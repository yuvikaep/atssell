-- JobsMato ATS - PostgreSQL schema
-- Version 1.1 | Revision of v1.0 starter schema (see schema_changes_v1.1.md)
-- Target: PostgreSQL 15+
--
-- Tenant isolation model:
--   * Every tenant-owned table has tenant_id and UNIQUE (tenant_id, id).
--   * Foreign keys between tenant-owned tables are composite (tenant_id, x_id), so a row can
--     never point at another tenant's row, even if the application has a bug.
--   * Row-Level Security is enabled and FORCED on every tenant-owned table. The application
--     sets the tenant per transaction:  SELECT set_config('app.tenant_id', '<uuid>', true);
--   * Cross-tenant background workers and platform admin tooling connect with a separate
--     database role that has BYPASSRLS. The web application role must NOT have BYPASSRLS.
--
-- Derived (not stored) states:
--   * A feedback link is expired when expires_at <= now(); no job has to flip a status.
--   * Interviewer feedback is overdue when feedback_status = 'pending' AND the interview's
--     feedback_due_at < now().

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
CREATE TYPE record_status AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE requisition_status AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled');
CREATE TYPE vacancy_status AS ENUM ('open', 'on_hold', 'closed', 'cancelled');
CREATE TYPE application_status AS ENUM ('active', 'rejected', 'withdrawn', 'hired', 'archived');
CREATE TYPE interview_mode AS ENUM ('google_meet', 'microsoft_teams', 'telephonic', 'face_to_face', 'other');
CREATE TYPE interview_status AS ENUM ('draft', 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');
CREATE TYPE feedback_recommendation AS ENUM ('strong_yes', 'yes', 'hold', 'no', 'strong_no');
-- 'expired' removed: expiry is derived from expires_at.
CREATE TYPE feedback_link_status AS ENUM ('active', 'consumed', 'revoked');
CREATE TYPE submission_source_type AS ENUM ('internal_recruiter', 'agency', 'referral', 'direct', 'job_board', 'other');
CREATE TYPE approval_decision AS ENUM ('pending', 'approved', 'rejected', 'skipped');
CREATE TYPE job_status AS ENUM ('queued', 'running', 'succeeded', 'failed', 'cancelled');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Current tenant from the per-transaction setting; NULL when unset (RLS then matches nothing).
CREATE FUNCTION app_current_tenant() RETURNS UUID
LANGUAGE sql STABLE AS $$
    SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid
$$;

CREATE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END $$;

-- Blocks UPDATE/DELETE on append-only tables. A retention purge job may set
-- app.allow_purge = 'on' for its own transaction to delete rows.
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' AND current_setting('app.allow_purge', true) = 'on' THEN
        RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = 'JMA01';
END $$;

-- ---------------------------------------------------------------------------
-- Platform
-- ---------------------------------------------------------------------------
CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    status record_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Platform Super Admins are not members of any tenant.
CREATE TABLE platform_admins (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email CITEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    auth_subject TEXT UNIQUE,
    status record_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Global permission catalogue (not tenant-owned, no RLS).
CREATE TABLE permissions (
    code TEXT PRIMARY KEY CHECK (code ~ '^[a-z_]+\.[a-z_]+$'),
    description TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------
CREATE TABLE tenant_settings (
    tenant_id UUID PRIMARY KEY REFERENCES tenants(id),
    feedback_link_expiry_hours INTEGER NOT NULL DEFAULT 168 CHECK (feedback_link_expiry_hours BETWEEN 1 AND 2160),
    feedback_due_hours INTEGER NOT NULL DEFAULT 48 CHECK (feedback_due_hours > 0),
    feedback_reminder_hours INTEGER[] NOT NULL DEFAULT '{24}',
    candidate_retention_days INTEGER CHECK (candidate_retention_days IS NULL OR candidate_retention_days > 0),
    default_ownership_policy JSONB NOT NULL DEFAULT '{"window_days": 90}'::jsonb,
    resume_max_bytes BIGINT NOT NULL DEFAULT 10485760,
    mfa_required_for_admins BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    email CITEXT NOT NULL,
    full_name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'active',
    auth_subject TEXT,
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, email),
    UNIQUE (tenant_id, auth_subject)
);

CREATE TABLE departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    parent_department_id UUID,
    head_user_id UUID,
    name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, name),
    CHECK (parent_department_id IS NULL OR parent_department_id <> id),
    FOREIGN KEY (tenant_id, parent_department_id) REFERENCES departments(tenant_id, id),
    FOREIGN KEY (tenant_id, head_user_id) REFERENCES users(tenant_id, id)
);

-- Rejects a parent change that would create a cycle in the department tree.
CREATE FUNCTION check_department_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.parent_department_id IS NULL THEN
        RETURN NEW;
    END IF;
    IF EXISTS (
        WITH RECURSIVE ancestors(id) AS (
            SELECT NEW.parent_department_id
            UNION
            SELECT d.parent_department_id
            FROM departments d JOIN ancestors a ON d.id = a.id
            WHERE d.parent_department_id IS NOT NULL
        )
        SELECT 1 FROM ancestors WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'department hierarchy cycle' USING ERRCODE = 'JMD01';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_departments_cycle
    BEFORE INSERT OR UPDATE OF parent_department_id ON departments
    FOR EACH ROW EXECUTE FUNCTION check_department_cycle();

-- tenant_id NULL = system role shared by all tenants (read-only to tenants).
CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    is_system_role BOOLEAN NOT NULL DEFAULT false,
    CHECK ((tenant_id IS NULL) = is_system_role)
);
CREATE UNIQUE INDEX uq_roles_system_code ON roles(code) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX uq_roles_tenant_code ON roles(tenant_id, code) WHERE tenant_id IS NOT NULL;

CREATE TABLE role_permissions (
    role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_code TEXT NOT NULL REFERENCES permissions(code),
    PRIMARY KEY (role_id, permission_code)
);

CREATE TABLE user_role_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL,
    role_id UUID NOT NULL REFERENCES roles(id),
    department_id UUID,  -- NULL = role applies company-wide
    assigned_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
    FOREIGN KEY (tenant_id, assigned_by) REFERENCES users(tenant_id, id)
);
-- NULLS NOT DISTINCT so a company-wide assignment cannot be duplicated (PG 15+).
CREATE UNIQUE INDEX uq_user_role_assignment
    ON user_role_assignments(tenant_id, user_id, role_id, department_id) NULLS NOT DISTINCT;

-- A role assignment may only use a system role or one of the same tenant's roles.
CREATE FUNCTION check_role_tenant() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    role_tenant UUID;
BEGIN
    SELECT tenant_id INTO role_tenant FROM roles WHERE id = NEW.role_id;
    IF role_tenant IS NOT NULL AND role_tenant <> NEW.tenant_id THEN
        RAISE EXCEPTION 'role belongs to another tenant' USING ERRCODE = 'JMR01';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER trg_user_role_assignments_tenant
    BEFORE INSERT OR UPDATE ON user_role_assignments
    FOR EACH ROW EXECUTE FUNCTION check_role_tenant();

CREATE TABLE user_invitations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    email CITEXT NOT NULL,
    role_id UUID NOT NULL REFERENCES roles(id),
    department_id UUID,
    agency_id UUID,  -- set when inviting an agency member; FK added after agencies
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    invited_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    CHECK (expires_at > created_at),
    FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
    FOREIGN KEY (tenant_id, invited_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX uq_user_invitations_open
    ON user_invitations(tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- Agencies
-- ---------------------------------------------------------------------------
-- Agency users are rows in users of the client tenant. An agency serving two client
-- companies therefore has separate accounts per client (see change log, open question).
CREATE TABLE agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'active',
    primary_contact_name TEXT,
    primary_contact_email CITEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, name)
);

ALTER TABLE user_invitations
    ADD FOREIGN KEY (tenant_id, agency_id) REFERENCES agencies(tenant_id, id);

CREATE TABLE agency_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    agency_id UUID NOT NULL,
    user_id UUID NOT NULL,
    agency_role TEXT NOT NULL CHECK (agency_role IN ('admin','recruiter')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    -- A user belongs to at most one agency within a tenant.
    UNIQUE (tenant_id, user_id),
    FOREIGN KEY (tenant_id, agency_id) REFERENCES agencies(tenant_id, id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Requisitions / vacancies
-- ---------------------------------------------------------------------------
CREATE TABLE requisitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    department_id UUID NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    headcount INTEGER NOT NULL CHECK (headcount > 0),
    employment_type TEXT NOT NULL,
    location TEXT NOT NULL,
    skills TEXT[] NOT NULL DEFAULT '{}',
    min_experience_years NUMERIC(4,1),
    max_experience_years NUMERIC(4,1),
    min_ctc NUMERIC(14,2),
    max_ctc NUMERIC(14,2),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
    target_date DATE,
    hiring_manager_id UUID,
    requested_by UUID NOT NULL,
    status requisition_status NOT NULL DEFAULT 'draft',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    CHECK (min_experience_years IS NULL OR min_experience_years >= 0),
    CHECK (max_experience_years IS NULL OR min_experience_years IS NULL OR max_experience_years >= min_experience_years),
    CHECK (min_ctc IS NULL OR min_ctc >= 0),
    CHECK (max_ctc IS NULL OR min_ctc IS NULL OR max_ctc >= min_ctc),
    FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id),
    FOREIGN KEY (tenant_id, hiring_manager_id) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id)
);

-- Ordered approval chain. The requisition is approved when every step is approved.
CREATE TABLE requisition_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    requisition_id UUID NOT NULL,
    step_order INTEGER NOT NULL CHECK (step_order > 0),
    approver_user_id UUID NOT NULL,
    decision approval_decision NOT NULL DEFAULT 'pending',
    reason TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (requisition_id, step_order),
    CHECK ((decision = 'pending') = (decided_at IS NULL)),
    CHECK (decision <> 'rejected' OR reason IS NOT NULL),
    FOREIGN KEY (tenant_id, requisition_id) REFERENCES requisitions(tenant_id, id),
    FOREIGN KEY (tenant_id, approver_user_id) REFERENCES users(tenant_id, id)
);

-- One requisition opens one or more vacancies (e.g. one per location). Title, location and
-- headcount are copied from the requisition when the vacancy is opened and may then diverge.
-- The application layer keeps SUM(vacancies.headcount) <= requisitions.headcount.
CREATE TABLE vacancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    requisition_id UUID NOT NULL,
    vacancy_code TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT NOT NULL,
    headcount INTEGER NOT NULL DEFAULT 1 CHECK (headcount > 0),
    owner_user_id UUID,
    status vacancy_status NOT NULL DEFAULT 'open',
    opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, vacancy_code),
    CHECK (closed_at IS NULL OR closed_at >= opened_at),
    FOREIGN KEY (tenant_id, requisition_id) REFERENCES requisitions(tenant_id, id),
    FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE vacancy_recruiters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL,
    recruiter_user_id UUID NOT NULL,
    assigned_by UUID NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    unassigned_at TIMESTAMPTZ,
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id),
    FOREIGN KEY (tenant_id, recruiter_user_id) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, assigned_by) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX uq_vacancy_recruiters_current
    ON vacancy_recruiters(vacancy_id, recruiter_user_id) WHERE unassigned_at IS NULL;

CREATE TABLE vacancy_agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL,
    agency_id UUID NOT NULL,
    status record_status NOT NULL DEFAULT 'active',
    assigned_by UUID NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ownership_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (vacancy_id, agency_id),
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id),
    FOREIGN KEY (tenant_id, agency_id) REFERENCES agencies(tenant_id, id),
    FOREIGN KEY (tenant_id, assigned_by) REFERENCES users(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Candidates
-- ---------------------------------------------------------------------------
CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    full_name TEXT NOT NULL,
    email CITEXT,
    phone TEXT,          -- store normalized E.164 for duplicate matching
    city TEXT,
    current_title TEXT,
    total_experience_years NUMERIC(4,1),
    current_ctc NUMERIC(14,2),
    expected_ctc NUMERIC(14,2),
    notice_period_days INTEGER,
    skills TEXT[] NOT NULL DEFAULT '{}',
    profile_summary TEXT,
    privacy_notice_status TEXT,
    retention_until DATE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','archived')),
    merged_into_candidate_id UUID,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    CHECK (total_experience_years IS NULL OR total_experience_years >= 0),
    CHECK (notice_period_days IS NULL OR notice_period_days >= 0),
    CHECK ((status = 'merged') = (merged_into_candidate_id IS NOT NULL)),
    CHECK (merged_into_candidate_id IS NULL OR merged_into_candidate_id <> id),
    FOREIGN KEY (tenant_id, merged_into_candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE INDEX idx_candidates_tenant_email ON candidates(tenant_id, email) WHERE status = 'active';
CREATE INDEX idx_candidates_tenant_phone ON candidates(tenant_id, phone) WHERE status = 'active';
CREATE INDEX idx_candidates_name_trgm ON candidates USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_candidates_skills ON candidates USING gin (skills);

-- Merge history: the source candidate is kept (status = 'merged'), never deleted.
CREATE TABLE candidate_merges (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    source_candidate_id UUID NOT NULL,
    target_candidate_id UUID NOT NULL,
    match_reason TEXT NOT NULL,          -- e.g. 'exact_email', 'exact_phone', 'manual'
    source_snapshot JSONB NOT NULL,      -- source row as it was before the merge
    merged_by UUID NOT NULL,
    merged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (source_candidate_id <> target_candidate_id),
    FOREIGN KEY (tenant_id, source_candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, target_candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, merged_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE candidate_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    candidate_id UUID NOT NULL,
    document_type TEXT NOT NULL CHECK (document_type IN ('resume','cover_letter','other')),
    storage_key TEXT NOT NULL UNIQUE,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    sha256 TEXT NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    -- Downloads are only allowed when scan_status = 'clean'.
    scan_status TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending','clean','infected','failed')),
    uploaded_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, uploaded_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE candidate_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    candidate_id UUID NOT NULL,
    application_id UUID,  -- optional: note about a specific application; FK added below
    body TEXT NOT NULL CHECK (length(body) > 0),
    visibility TEXT NOT NULL DEFAULT 'internal' CHECK (visibility IN ('internal','agency_shared')),
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Pipeline
-- ---------------------------------------------------------------------------
-- Tenant-configurable pipeline stages.
CREATE TABLE pipeline_stages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    code TEXT NOT NULL CHECK (code ~ '^[a-z_]+$'),
    name TEXT NOT NULL,
    sort_order INTEGER NOT NULL,
    is_initial BOOLEAN NOT NULL DEFAULT false,
    -- Terminal stages set the application status, e.g. 'hired' or 'rejected'.
    terminal_status application_status,
    status record_status NOT NULL DEFAULT 'active',
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, code)
);
CREATE UNIQUE INDEX uq_pipeline_stages_initial ON pipeline_stages(tenant_id) WHERE is_initial;

-- Allowed moves between stages. A move not listed here is rejected.
CREATE TABLE pipeline_stage_transitions (
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    from_stage_id UUID NOT NULL,
    to_stage_id UUID NOT NULL,
    requires_reason BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY (tenant_id, from_stage_id, to_stage_id),
    CHECK (from_stage_id <> to_stage_id),
    FOREIGN KEY (tenant_id, from_stage_id) REFERENCES pipeline_stages(tenant_id, id),
    FOREIGN KEY (tenant_id, to_stage_id) REFERENCES pipeline_stages(tenant_id, id)
);

CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    candidate_id UUID NOT NULL,
    vacancy_id UUID NOT NULL,
    status application_status NOT NULL DEFAULT 'active',
    stage_id UUID NOT NULL,
    stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disposition_reason TEXT,
    referred_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id),
    FOREIGN KEY (tenant_id, stage_id) REFERENCES pipeline_stages(tenant_id, id),
    FOREIGN KEY (tenant_id, referred_by) REFERENCES users(tenant_id, id)
);
-- One active application per candidate per vacancy; a rejected/withdrawn candidate may reapply.
CREATE UNIQUE INDEX uq_applications_active
    ON applications(candidate_id, vacancy_id) WHERE status = 'active';
CREATE INDEX idx_applications_vacancy_stage ON applications(vacancy_id, stage_id);
CREATE INDEX idx_applications_candidate ON applications(tenant_id, candidate_id);

ALTER TABLE candidate_notes
    ADD FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id);

-- Append-only stage history: one row per move, including the first stage.
CREATE TABLE application_stage_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL,
    from_stage_id UUID,
    to_stage_id UUID NOT NULL,
    reason TEXT,
    actor_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, from_stage_id) REFERENCES pipeline_stages(tenant_id, id),
    FOREIGN KEY (tenant_id, to_stage_id) REFERENCES pipeline_stages(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_stage_events_application ON application_stage_events(application_id, created_at);

CREATE TRIGGER trg_application_stage_events_append_only
    BEFORE UPDATE OR DELETE ON application_stage_events
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL,
    source_type submission_source_type NOT NULL,
    source_user_id UUID,
    agency_id UUID,
    resume_document_id UUID,  -- resume as submitted by this source
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_reference TEXT,
    ownership_state TEXT NOT NULL DEFAULT 'pending_review'
      CHECK (ownership_state IN ('pending_review','provisional','accepted','disputed','rejected','released')),
    ownership_expires_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    CHECK ((source_type = 'agency') = (agency_id IS NOT NULL)),
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, source_user_id) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, agency_id) REFERENCES agencies(tenant_id, id),
    FOREIGN KEY (tenant_id, resume_document_id) REFERENCES candidate_documents(tenant_id, id)
);
CREATE INDEX idx_submissions_application_time ON submissions(application_id, submitted_at);
CREATE INDEX idx_submissions_agency_time ON submissions(agency_id, submitted_at);

CREATE TABLE ownership_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    submission_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    actor_user_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, submission_id) REFERENCES submissions(tenant_id, id),
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id)
);

CREATE TRIGGER trg_ownership_events_append_only
    BEFORE UPDATE OR DELETE ON ownership_events
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Follow-ups and to-dos shown in the task center.
CREATE TABLE tasks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    assignee_user_id UUID NOT NULL,
    task_type TEXT NOT NULL,          -- e.g. 'follow_up', 'approval', 'feedback_overdue', 'joining_follow_up'
    title TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_tasks_open ON tasks(tenant_id, assignee_user_id, due_at) WHERE completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- Interviews
-- ---------------------------------------------------------------------------
CREATE TABLE interview_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL,
    name TEXT NOT NULL,
    round_order INTEGER NOT NULL CHECK (round_order > 0),
    -- {"competencies": [{"code": "communication", "label": "Communication", "required": true}]}
    evaluation_template JSONB NOT NULL DEFAULT '{"competencies": []}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (vacancy_id, round_order),
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id)
);

CREATE TABLE interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL,
    interview_plan_id UUID,
    round_name TEXT NOT NULL,
    mode interview_mode NOT NULL,
    scheduled_start TIMESTAMPTZ,
    scheduled_end TIMESTAMPTZ,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    meeting_url TEXT,
    location_instructions TEXT,
    status interview_status NOT NULL DEFAULT 'draft',
    -- Scorecard template snapshot at scheduling time, so later template edits do not
    -- change what an interviewer was asked to rate.
    evaluation_template JSONB NOT NULL DEFAULT '{"competencies": []}'::jsonb,
    feedback_due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    cancelled_reason TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, id, application_id),
    CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start),
    CHECK (status NOT IN ('scheduled','confirmed') OR (scheduled_start IS NOT NULL AND scheduled_end IS NOT NULL)),
    CHECK (status <> 'cancelled' OR cancelled_reason IS NOT NULL),
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, interview_plan_id) REFERENCES interview_plans(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_interviews_tenant_start ON interviews(tenant_id, scheduled_start);

CREATE TABLE interviewers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    interview_id UUID NOT NULL,
    user_id UUID,
    external_name TEXT,
    external_email CITEXT,
    identity_verification_required BOOLEAN NOT NULL DEFAULT false,
    -- 'overdue' removed: derived from interviews.feedback_due_at.
    feedback_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (feedback_status IN ('pending','submitted','waived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (tenant_id, id, interview_id),
    CHECK (user_id IS NOT NULL OR external_email IS NOT NULL),
    FOREIGN KEY (tenant_id, interview_id) REFERENCES interviews(tenant_id, id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE UNIQUE INDEX uq_interviewers_user ON interviewers(interview_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX uq_interviewers_email ON interviewers(interview_id, external_email) WHERE external_email IS NOT NULL;

-- Composite FK (tenant_id, interviewer_id, interview_id) guarantees interview_id matches the
-- interviewer's interview.
CREATE TABLE feedback_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    interview_id UUID NOT NULL,
    interviewer_id UUID NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),  -- SHA-256 hex
    status feedback_link_status NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    revoked_by UUID,
    consumed_at TIMESTAMPTZ,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_opened_at TIMESTAMPTZ,
    open_count INTEGER NOT NULL DEFAULT 0,
    UNIQUE (tenant_id, id),
    CHECK (expires_at > created_at),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
    CHECK ((status = 'consumed') = (consumed_at IS NOT NULL)),
    FOREIGN KEY (tenant_id, interviewer_id, interview_id) REFERENCES interviewers(tenant_id, id, interview_id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, revoked_by) REFERENCES users(tenant_id, id)
);
-- At most one active link per interviewer. Regeneration revokes the old link first.
CREATE UNIQUE INDEX uq_feedback_links_one_active
    ON feedback_links(interviewer_id) WHERE status = 'active';
CREATE INDEX idx_feedback_links_status_expiry ON feedback_links(status, expires_at);

-- The original submission. Immutable: corrections go to feedback_corrections.
CREATE TABLE feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    interview_id UUID NOT NULL,
    application_id UUID NOT NULL,
    interviewer_id UUID NOT NULL,
    feedback_link_id UUID,
    mode interview_mode NOT NULL,
    overall_rating SMALLINT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
    recommendation feedback_recommendation NOT NULL,
    competency_ratings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(competency_ratings) = 'object'),
    notes TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (interview_id, interviewer_id),
    FOREIGN KEY (tenant_id, interviewer_id, interview_id) REFERENCES interviewers(tenant_id, id, interview_id),
    FOREIGN KEY (tenant_id, interview_id, application_id) REFERENCES interviews(tenant_id, id, application_id),
    FOREIGN KEY (tenant_id, feedback_link_id) REFERENCES feedback_links(tenant_id, id)
);

CREATE TRIGGER trg_feedback_append_only
    BEFORE UPDATE OR DELETE ON feedback
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Each correction is a full replacement of the scored fields. The effective feedback is the
-- correction with the highest version, or the original feedback row when none exist.
CREATE TABLE feedback_corrections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    feedback_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    mode interview_mode NOT NULL,
    overall_rating SMALLINT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
    recommendation feedback_recommendation NOT NULL,
    competency_ratings JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(competency_ratings) = 'object'),
    notes TEXT,
    reason TEXT NOT NULL CHECK (length(reason) > 0),
    corrected_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (feedback_id, version),
    FOREIGN KEY (tenant_id, feedback_id) REFERENCES feedback(tenant_id, id),
    FOREIGN KEY (tenant_id, corrected_by) REFERENCES users(tenant_id, id)
);

CREATE TRIGGER trg_feedback_corrections_append_only
    BEFORE UPDATE OR DELETE ON feedback_corrections
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE hiring_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL,
    decision TEXT NOT NULL CHECK (decision IN ('advance','hold','reject','additional_round','select')),
    reason TEXT,
    decided_by UUID NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, decided_by) REFERENCES users(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Offers / joining (P1)
-- ---------------------------------------------------------------------------
CREATE TABLE offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft'
      CHECK (status IN ('draft','pending_approval','approved','released','accepted','declined','withdrawn')),
    offered_ctc NUMERIC(14,2) CHECK (offered_ctc IS NULL OR offered_ctc >= 0),
    proposed_joining_date DATE,
    decline_reason TEXT,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE offer_approvals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    offer_id UUID NOT NULL,
    step_order INTEGER NOT NULL CHECK (step_order > 0),
    approver_user_id UUID NOT NULL,
    decision approval_decision NOT NULL DEFAULT 'pending',
    reason TEXT,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (offer_id, step_order),
    CHECK ((decision = 'pending') = (decided_at IS NULL)),
    CHECK (decision <> 'rejected' OR reason IS NOT NULL),
    FOREIGN KEY (tenant_id, offer_id) REFERENCES offers(tenant_id, id),
    FOREIGN KEY (tenant_id, approver_user_id) REFERENCES users(tenant_id, id)
);

CREATE TABLE joining_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL,
    joining_date DATE,
    status TEXT NOT NULL CHECK (status IN ('expected','joined','delayed','backed_out')),
    reason TEXT,
    updated_by UUID,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (application_id),
    CHECK (status NOT IN ('delayed','backed_out') OR reason IS NOT NULL),
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, updated_by) REFERENCES users(tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Notifications, background jobs, audit
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    recipient_user_id UUID,
    recipient_email CITEXT,
    event_type TEXT NOT NULL,
    -- Deterministic key, e.g. 'feedback_reminder:<interviewer_id>:24h', so retries and
    -- re-runs of a scheduler cannot send the same notification twice.
    dedupe_key TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivery_channel TEXT NOT NULL CHECK (delivery_channel IN ('in_app','email','whatsapp','webhook')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    next_attempt_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, dedupe_key, delivery_channel),
    CHECK (recipient_user_id IS NOT NULL OR recipient_email IS NOT NULL),
    FOREIGN KEY (tenant_id, recipient_user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_notifications_due ON notifications(next_attempt_at) WHERE status = 'queued';
CREATE INDEX idx_notifications_inbox ON notifications(tenant_id, recipient_user_id, created_at DESC)
    WHERE delivery_channel = 'in_app';

CREATE TABLE import_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    import_type TEXT NOT NULL CHECK (import_type IN ('candidates_csv')),
    storage_key TEXT NOT NULL,
    status job_status NOT NULL DEFAULT 'queued',
    total_rows INTEGER,
    succeeded_rows INTEGER NOT NULL DEFAULT 0,
    failed_rows INTEGER NOT NULL DEFAULT 0,
    error_report_storage_key TEXT,
    requested_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE export_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    export_type TEXT NOT NULL,
    filters JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Field list resolved from the requester's permissions when the job was created.
    fields TEXT[] NOT NULL,
    status job_status NOT NULL DEFAULT 'queued',
    storage_key TEXT,
    expires_at TIMESTAMPTZ,
    requested_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    FOREIGN KEY (tenant_id, requested_by) REFERENCES users(tenant_id, id)
);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    actor_user_id UUID,
    actor_type TEXT NOT NULL DEFAULT 'user'
      CHECK (actor_type IN ('user','external_interviewer','system','platform_admin')),
    actor_label TEXT,   -- e.g. external interviewer email; never a raw token
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    request_id TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_audit_events_tenant_time ON audit_events(tenant_id, created_at DESC);
CREATE INDEX idx_audit_events_entity ON audit_events(tenant_id, entity_type, entity_id);

CREATE TRIGGER trg_audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'tenants','tenant_settings','users','departments','agencies','requisitions',
        'vacancies','candidates','applications','interviews','offers','joining_records'
    ] LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_updated_at BEFORE UPDATE ON %1$I
             FOR EACH ROW EXECUTE FUNCTION set_updated_at()', t);
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Row-Level Security
-- ---------------------------------------------------------------------------
-- Every table with a tenant_id column (except roles, handled below) gets the same policy.
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tb
          ON tb.table_name = c.table_name AND tb.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND c.column_name = 'tenant_id'
          AND tb.table_type = 'BASE TABLE'
          AND c.table_name <> 'roles'
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'CREATE POLICY tenant_isolation ON %I
             USING (tenant_id = app_current_tenant())
             WITH CHECK (tenant_id = app_current_tenant())', t);
    END LOOP;
END $$;

-- Tenants see system roles (read-only) plus their own roles.
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles FORCE ROW LEVEL SECURITY;
CREATE POLICY roles_read ON roles FOR SELECT
    USING (tenant_id IS NULL OR tenant_id = app_current_tenant());
CREATE POLICY roles_write ON roles FOR ALL
    USING (tenant_id = app_current_tenant())
    WITH CHECK (tenant_id = app_current_tenant());

-- The public feedback page has no tenant context until the token is resolved. The app sets
-- app.feedback_token_hash to the SHA-256 of the presented token; this policy then exposes
-- exactly that one link row, whose tenant_id is used to set app.tenant_id.
CREATE POLICY feedback_link_by_token ON feedback_links FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.feedback_token_hash', true), ''));

-- Same pattern for accepting an invitation before the user has a session.
CREATE POLICY invitation_by_token ON user_invitations FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.invitation_token_hash', true), ''));

-- ---------------------------------------------------------------------------
-- Atomic one-time feedback submission
-- ---------------------------------------------------------------------------
-- Caller: SELECT set_config('app.feedback_token_hash', <sha256 hex>, true); then call this
-- inside a transaction. Validates the link, inserts feedback, consumes the link, marks the
-- interviewer submitted and writes the audit event, all in the caller's transaction.
--
-- Error codes (map to generic HTTP responses; never reveal candidate details):
--   JMF01 invalid token        -> 401
--   JMF02 expired or revoked   -> 410
--   JMF03 already submitted    -> 409
--   JMF04 interview cancelled  -> 410
CREATE FUNCTION submit_feedback(
    p_token_hash TEXT,
    p_mode interview_mode,
    p_overall_rating SMALLINT,
    p_recommendation feedback_recommendation,
    p_competency_ratings JSONB,
    p_notes TEXT,
    p_request_id TEXT DEFAULT NULL,
    p_ip_hash TEXT DEFAULT NULL
) RETURNS UUID
LANGUAGE plpgsql AS $$
DECLARE
    link feedback_links%ROWTYPE;
    iv interviews%ROWTYPE;
    new_feedback_id UUID;
BEGIN
    PERFORM set_config('app.feedback_token_hash', p_token_hash, true);

    -- Resolve the tenant through the token policy first: SELECT ... FOR UPDATE must also pass
    -- the UPDATE policy, which needs app.tenant_id.
    SELECT * INTO link FROM feedback_links WHERE token_hash = p_token_hash;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'invalid feedback link' USING ERRCODE = 'JMF01';
    END IF;
    PERFORM set_config('app.tenant_id', link.tenant_id::text, true);

    -- Row lock serializes concurrent submissions for the same link; re-read after the lock.
    SELECT * INTO link FROM feedback_links WHERE id = link.id FOR UPDATE;

    IF link.status = 'consumed' THEN
        RAISE EXCEPTION 'feedback already submitted' USING ERRCODE = 'JMF03';
    END IF;
    IF link.status = 'revoked' OR link.expires_at <= now() THEN
        RAISE EXCEPTION 'feedback link expired or revoked' USING ERRCODE = 'JMF02';
    END IF;

    SELECT * INTO iv FROM interviews WHERE id = link.interview_id;
    IF iv.status = 'cancelled' THEN
        RAISE EXCEPTION 'interview cancelled' USING ERRCODE = 'JMF04';
    END IF;

    INSERT INTO feedback (tenant_id, interview_id, application_id, interviewer_id, feedback_link_id,
                          mode, overall_rating, recommendation, competency_ratings, notes)
    VALUES (link.tenant_id, link.interview_id, iv.application_id, link.interviewer_id, link.id,
            p_mode, p_overall_rating, p_recommendation, COALESCE(p_competency_ratings, '{}'::jsonb),
            NULLIF(p_notes, ''))
    RETURNING id INTO new_feedback_id;

    UPDATE feedback_links SET status = 'consumed', consumed_at = now() WHERE id = link.id;
    UPDATE interviewers SET feedback_status = 'submitted' WHERE id = link.interviewer_id;

    INSERT INTO audit_events (tenant_id, actor_type, actor_label, action, entity_type, entity_id,
                              request_id, ip_hash, metadata)
    SELECT link.tenant_id, 'external_interviewer', COALESCE(i.external_email::text, i.user_id::text),
           'feedback.submitted', 'feedback', new_feedback_id, p_request_id, p_ip_hash,
           jsonb_build_object('interview_id', link.interview_id, 'feedback_link_id', link.id)
    FROM interviewers i WHERE i.id = link.interviewer_id;

    RETURN new_feedback_id;
EXCEPTION
    -- A second submission for the same interviewer through a different (regenerated) link.
    WHEN unique_violation THEN
        RAISE EXCEPTION 'feedback already submitted' USING ERRCODE = 'JMF03';
END $$;

-- ---------------------------------------------------------------------------
-- Permission catalogue (seed)
-- ---------------------------------------------------------------------------
INSERT INTO permissions (code, description) VALUES
    ('tenant.manage_settings',     'Edit company settings, stages, ownership rules, expiry'),
    ('users.manage',               'Invite, deactivate and assign roles to users'),
    ('departments.manage',         'Create, edit and deactivate departments'),
    ('requisitions.create',        'Create and submit requisitions'),
    ('requisitions.approve',       'Approve or reject requisitions'),
    ('vacancies.view_all',         'View every vacancy in the company'),
    ('vacancies.view_assigned',    'View vacancies assigned to the user'),
    ('vacancies.manage',           'Edit vacancies and assign recruiters/agencies'),
    ('candidates.view',            'Search and view permitted candidates'),
    ('candidates.view_contact',    'View candidate email and phone'),
    ('candidates.view_compensation','View current/expected CTC'),
    ('candidates.manage',          'Create, edit, import and merge candidates'),
    ('applications.manage',        'Create applications and move stages'),
    ('submissions.create',         'Submit candidates as a source (agency/recruiter)'),
    ('ownership.resolve',          'Resolve candidate ownership disputes'),
    ('agencies.manage',            'Invite and manage agencies and their members'),
    ('interviews.manage',          'Schedule, reschedule and cancel interviews'),
    ('feedback_links.manage',      'Generate, revoke and regenerate feedback links'),
    ('feedback.view',              'View submitted interview feedback'),
    ('feedback.correct',           'Create audited feedback corrections'),
    ('decisions.record',           'Record hiring decisions'),
    ('offers.manage',              'Create and update offers'),
    ('offers.approve',             'Approve offers and view compensation'),
    ('analytics.view',             'View dashboards and reports'),
    ('exports.create',             'Export permitted data'),
    ('audit.view',                 'View audit logs');
