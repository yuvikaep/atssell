-- JobsMato ATS - PostgreSQL starter schema
-- Version 1.0 | Draft for engineering review
-- Assumptions: UUID primary keys, PostgreSQL 15+, app-level tenant context.
-- IMPORTANT: Review against chosen auth provider, privacy policy, and production threat model.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE TYPE record_status AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE requisition_status AS ENUM ('draft', 'pending_approval', 'approved', 'rejected', 'cancelled');
CREATE TYPE vacancy_status AS ENUM ('open', 'on_hold', 'closed', 'cancelled');
CREATE TYPE application_status AS ENUM ('active', 'rejected', 'withdrawn', 'hired', 'archived');
CREATE TYPE interview_mode AS ENUM ('google_meet', 'microsoft_teams', 'telephonic', 'face_to_face', 'other');
CREATE TYPE interview_status AS ENUM ('draft', 'scheduled', 'confirmed', 'completed', 'cancelled', 'no_show');
CREATE TYPE feedback_recommendation AS ENUM ('strong_yes', 'yes', 'hold', 'no', 'strong_no');
CREATE TYPE feedback_link_status AS ENUM ('active', 'consumed', 'expired', 'revoked');
CREATE TYPE submission_source_type AS ENUM ('internal_recruiter', 'agency', 'referral', 'direct', 'job_board', 'other');

CREATE TABLE tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    status record_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    email CITEXT NOT NULL,
    full_name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'active',
    auth_subject TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email),
    UNIQUE (tenant_id, auth_subject)
);

CREATE TABLE departments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    parent_department_id UUID REFERENCES departments(id),
    name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id),
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    is_system_role BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (tenant_id, code)
);

CREATE TABLE user_role_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL REFERENCES users(id),
    role_id UUID NOT NULL REFERENCES roles(id),
    department_id UUID REFERENCES departments(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, user_id, role_id, department_id)
);

CREATE TABLE agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    status record_status NOT NULL DEFAULT 'active',
    primary_contact_name TEXT,
    primary_contact_email TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE agency_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    agency_id UUID NOT NULL REFERENCES agencies(id),
    user_id UUID NOT NULL REFERENCES users(id),
    agency_role TEXT NOT NULL CHECK (agency_role IN ('admin','recruiter')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (agency_id, user_id)
);

CREATE TABLE requisitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    department_id UUID NOT NULL REFERENCES departments(id),
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    headcount INTEGER NOT NULL CHECK (headcount > 0),
    employment_type TEXT NOT NULL,
    location TEXT NOT NULL,
    min_experience_years NUMERIC(4,1),
    max_experience_years NUMERIC(4,1),
    min_ctc NUMERIC(14,2),
    max_ctc NUMERIC(14,2),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','critical')),
    target_date DATE,
    hiring_manager_id UUID REFERENCES users(id),
    requested_by UUID NOT NULL REFERENCES users(id),
    status requisition_status NOT NULL DEFAULT 'draft',
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE vacancies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    requisition_id UUID NOT NULL REFERENCES requisitions(id),
    vacancy_code TEXT NOT NULL,
    status vacancy_status NOT NULL DEFAULT 'open',
    opened_at TIMESTAMPTZ,
    closed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, vacancy_code)
);

CREATE TABLE vacancy_recruiters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL REFERENCES vacancies(id),
    recruiter_user_id UUID NOT NULL REFERENCES users(id),
    assigned_by UUID NOT NULL REFERENCES users(id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (vacancy_id, recruiter_user_id)
);

CREATE TABLE vacancy_agencies (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL REFERENCES vacancies(id),
    agency_id UUID NOT NULL REFERENCES agencies(id),
    assigned_by UUID NOT NULL REFERENCES users(id),
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ownership_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    UNIQUE (vacancy_id, agency_id)
);

CREATE TABLE candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    full_name TEXT NOT NULL,
    email CITEXT,
    phone TEXT,
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
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (total_experience_years IS NULL OR total_experience_years >= 0),
    CHECK (notice_period_days IS NULL OR notice_period_days >= 0)
);

CREATE INDEX idx_candidates_tenant_name ON candidates(tenant_id, lower(full_name));
CREATE INDEX idx_candidates_tenant_email ON candidates(tenant_id, email);
CREATE INDEX idx_candidates_tenant_phone ON candidates(tenant_id, phone);

CREATE TABLE candidate_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    candidate_id UUID NOT NULL REFERENCES candidates(id),
    document_type TEXT NOT NULL CHECK (document_type IN ('resume','cover_letter','other')),
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
    uploaded_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE applications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    candidate_id UUID NOT NULL REFERENCES candidates(id),
    vacancy_id UUID NOT NULL REFERENCES vacancies(id),
    status application_status NOT NULL DEFAULT 'active',
    stage TEXT NOT NULL DEFAULT 'submitted',
    stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    disposition_reason TEXT,
    referred_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (candidate_id, vacancy_id)
);

CREATE TABLE submissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL REFERENCES applications(id),
    source_type submission_source_type NOT NULL,
    source_user_id UUID REFERENCES users(id),
    agency_id UUID REFERENCES agencies(id),
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    source_reference TEXT,
    ownership_state TEXT NOT NULL DEFAULT 'pending_review'
      CHECK (ownership_state IN ('pending_review','provisional','accepted','disputed','rejected','released')),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_submissions_application_time ON submissions(application_id, submitted_at);
CREATE INDEX idx_submissions_agency_time ON submissions(agency_id, submitted_at);

CREATE TABLE ownership_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    submission_id UUID NOT NULL REFERENCES submissions(id),
    event_type TEXT NOT NULL,
    previous_state TEXT,
    new_state TEXT,
    reason TEXT,
    actor_user_id UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE interview_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL REFERENCES vacancies(id),
    name TEXT NOT NULL,
    round_order INTEGER NOT NULL CHECK (round_order > 0),
    evaluation_template JSONB NOT NULL DEFAULT '{}'::jsonb,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (vacancy_id, round_order)
);

CREATE TABLE interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL REFERENCES applications(id),
    interview_plan_id UUID REFERENCES interview_plans(id),
    round_name TEXT NOT NULL,
    mode interview_mode NOT NULL,
    scheduled_start TIMESTAMPTZ,
    scheduled_end TIMESTAMPTZ,
    timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    meeting_url TEXT,
    location_instructions TEXT,
    status interview_status NOT NULL DEFAULT 'draft',
    feedback_due_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (scheduled_end IS NULL OR scheduled_start IS NULL OR scheduled_end > scheduled_start)
);

CREATE TABLE interviewers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    interview_id UUID NOT NULL REFERENCES interviews(id),
    user_id UUID REFERENCES users(id),
    external_name TEXT,
    external_email CITEXT,
    identity_verification_required BOOLEAN NOT NULL DEFAULT false,
    feedback_status TEXT NOT NULL DEFAULT 'pending'
      CHECK (feedback_status IN ('pending','submitted','overdue','waived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (user_id IS NOT NULL OR external_name IS NOT NULL OR external_email IS NOT NULL)
);

CREATE TABLE feedback_links (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    interview_id UUID NOT NULL REFERENCES interviews(id),
    interviewer_id UUID NOT NULL REFERENCES interviewers(id),
    token_hash TEXT NOT NULL UNIQUE,
    status feedback_link_status NOT NULL DEFAULT 'active',
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    consumed_at TIMESTAMPTZ,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_opened_at TIMESTAMPTZ,
    CHECK (expires_at > created_at)
);

CREATE TABLE feedback (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    interview_id UUID NOT NULL REFERENCES interviews(id),
    application_id UUID NOT NULL REFERENCES applications(id),
    interviewer_id UUID NOT NULL REFERENCES interviewers(id),
    feedback_link_id UUID REFERENCES feedback_links(id),
    mode interview_mode NOT NULL,
    overall_rating SMALLINT NOT NULL CHECK (overall_rating BETWEEN 1 AND 5),
    recommendation feedback_recommendation NOT NULL,
    competency_ratings JSONB NOT NULL DEFAULT '{}'::jsonb,
    notes TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    corrected_from_feedback_id UUID REFERENCES feedback(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (interview_id, interviewer_id)
);

CREATE TABLE hiring_decisions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL REFERENCES applications(id),
    decision TEXT NOT NULL CHECK (decision IN ('advance','hold','reject','additional_round','select')),
    reason TEXT,
    decided_by UUID NOT NULL REFERENCES users(id),
    decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE offers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL REFERENCES applications(id),
    status TEXT NOT NULL CHECK (status IN ('draft','pending_approval','approved','released','accepted','declined','withdrawn')),
    offered_ctc NUMERIC(14,2),
    proposed_joining_date DATE,
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE joining_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL REFERENCES applications(id),
    joining_date DATE,
    status TEXT NOT NULL CHECK (status IN ('expected','joined','delayed','backed_out')),
    reason TEXT,
    updated_by UUID REFERENCES users(id),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    recipient_user_id UUID REFERENCES users(id),
    recipient_email CITEXT,
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    delivery_channel TEXT NOT NULL CHECK (delivery_channel IN ('in_app','email','whatsapp','webhook')),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','cancelled')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    actor_user_id UUID REFERENCES users(id),
    actor_type TEXT NOT NULL DEFAULT 'user',
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    request_id TEXT,
    ip_hash TEXT,
    user_agent TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_audit_events_tenant_time ON audit_events(tenant_id, created_at DESC);
CREATE INDEX idx_interviews_tenant_start ON interviews(tenant_id, scheduled_start);
CREATE INDEX idx_feedback_links_status_expiry ON feedback_links(status, expires_at);
CREATE INDEX idx_applications_vacancy_stage ON applications(vacancy_id, stage);

-- Engineering notes:
-- 1. CITEXT requires CREATE EXTENSION citext; add that extension if using CITEXT.
-- 2. Production must enforce tenant ownership consistently, preferably with PostgreSQL RLS
--    plus server-side authorization. Foreign keys above should be strengthened with composite
--    tenant-aware constraints in the production migration.
-- 3. Public feedback link endpoints must hash the presented token and compare to token_hash.
-- 4. Token consumption + feedback INSERT + audit event must occur in one DB transaction.
-- 5. Consider a partial unique index to allow only one active link per interviewer/interview.
-- 6. Use short-lived signed object-storage URLs for resume access; never expose storage keys publicly.
