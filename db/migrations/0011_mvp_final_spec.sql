-- Final MVP specification: four roles, job-wise first-submission-wins, agency commercials,
-- employment (joined / exited), replacement tracking and own-performance views.

-- ---- Four roles ----------------------------------------------------------------------------------
-- HR Lead (company_admin), Company Recruiter (internal_recruiter), Agency (agency_admin) with optional
-- Agency Sub-recruiters (agency_recruiter), and Interviewer. Earlier roles stay in the table so existing
-- assignments and history keep working, but they can no longer be given to anyone.
ALTER TABLE roles ADD COLUMN is_assignable BOOLEAN NOT NULL DEFAULT true;
UPDATE roles SET is_assignable = false
 WHERE tenant_id IS NULL AND code IN ('hr_head', 'hiring_manager', 'recruitment_manager', 'offer_approver');
UPDATE roles SET name = 'HR Lead'              WHERE tenant_id IS NULL AND code = 'company_admin';
UPDATE roles SET name = 'Company Recruiter'    WHERE tenant_id IS NULL AND code = 'internal_recruiter';
UPDATE roles SET name = 'Agency'               WHERE tenant_id IS NULL AND code = 'agency_admin';
UPDATE roles SET name = 'Agency Sub-recruiter' WHERE tenant_id IS NULL AND code = 'agency_recruiter';

INSERT INTO permissions (code, description) VALUES
    ('employment.manage',     'Mark candidates joined or exited, track replacements, close jobs'),
    ('agency_terms.manage',   'Set agency commercial terms'),
    ('performance.view_all',  'See recruiter and agency leaderboards'),
    ('performance.view_own',  'See your own performance');
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
 WHERE r.tenant_id IS NULL AND r.code = 'company_admin' AND p.code IN ('employment.manage', 'agency_terms.manage', 'performance.view_all', 'performance.view_own');
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'performance.view_own' FROM roles r
 WHERE r.tenant_id IS NULL AND r.code IN ('internal_recruiter', 'agency_admin', 'agency_recruiter');

-- ---- Job-wise ownership --------------------------------------------------------------------------
-- A candidate has one phone number per company. (Email is a duplicate signal, never a unique key.)
CREATE UNIQUE INDEX uq_candidates_company_phone ON candidates(tenant_id, phone) WHERE phone IS NOT NULL AND status = 'active';
-- One accepted ownership record per application, and an application is one candidate on one job.
CREATE UNIQUE INDEX uq_submissions_one_accepted ON submissions(application_id) WHERE ownership_state = 'accepted';

-- Every refused duplicate submission, kept apart from the accepted owner. Nothing here ever changes ownership.
CREATE TABLE duplicate_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    original_submission_id UUID,
    attempted_by UUID,
    attempted_agency_id UUID,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id),
    FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, original_submission_id) REFERENCES submissions(tenant_id, id),
    FOREIGN KEY (tenant_id, attempted_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, attempted_agency_id) REFERENCES agencies(tenant_id, id)
);
CREATE INDEX idx_duplicate_attempts_vacancy ON duplicate_attempts(tenant_id, vacancy_id, attempted_at);

-- ---- Agency commercial terms (versioned) ---------------------------------------------------------
-- A change is a new version. Old versions are never edited, so a hire keeps the terms it was made under.
CREATE TABLE agency_terms (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    agency_id UUID NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    payment_model TEXT NOT NULL CHECK (payment_model IN ('payroll_management', 'one_time_fee')),
    fee_type TEXT NOT NULL CHECK (fee_type IN ('percent_of_ctc', 'fixed')),
    fee_value NUMERIC(14,2) NOT NULL CHECK (fee_value >= 0),
    lockin_days INTEGER CHECK (lockin_days IS NULL OR lockin_days >= 0),
    replacement_days INTEGER CHECK (replacement_days IS NULL OR replacement_days >= 0),
    effective_from DATE NOT NULL,
    agreement_ref TEXT,
    notes TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (agency_id, version),
    CHECK (fee_type <> 'percent_of_ctc' OR fee_value <= 100),
    FOREIGN KEY (tenant_id, agency_id) REFERENCES agencies(tenant_id, id),
    FOREIGN KEY (tenant_id, created_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_agency_terms_agency ON agency_terms(agency_id, effective_from DESC, version DESC);

-- ---- Employment: joined, active, exited ---------------------------------------------------------
CREATE TABLE employment_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    application_id UUID NOT NULL,
    candidate_id UUID NOT NULL,
    vacancy_id UUID NOT NULL,
    source_user_id UUID,
    source_agency_id UUID,
    agency_terms_id UUID,
    joined_on DATE NOT NULL,
    designation TEXT NOT NULL,
    annual_ctc NUMERIC(14,2) NOT NULL CHECK (annual_ctc >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'exited')),
    exit_date DATE,
    exit_reason TEXT,
    marked_joined_by UUID NOT NULL,
    marked_exited_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (application_id),
    CHECK ((status = 'exited') = (exit_date IS NOT NULL)),
    CHECK (status <> 'exited' OR exit_reason IS NOT NULL),
    CHECK (exit_date IS NULL OR exit_date >= joined_on),
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, candidate_id) REFERENCES candidates(tenant_id, id),
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id),
    FOREIGN KEY (tenant_id, source_user_id) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, source_agency_id) REFERENCES agencies(tenant_id, id),
    FOREIGN KEY (tenant_id, agency_terms_id) REFERENCES agency_terms(tenant_id, id),
    FOREIGN KEY (tenant_id, marked_joined_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, marked_exited_by) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_employment_vacancy ON employment_records(tenant_id, vacancy_id, status);
CREATE INDEX idx_employment_agency ON employment_records(tenant_id, source_agency_id, status);

-- When an agency-sourced hire leaves inside the lock-in period, the agency owes a replacement by `due_by`.
CREATE TABLE replacement_records (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    employment_id UUID NOT NULL,
    agency_id UUID NOT NULL,
    vacancy_id UUID NOT NULL,
    lockin_days INTEGER NOT NULL,
    replacement_days INTEGER NOT NULL,
    due_by DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due', 'replaced', 'expired', 'waived')),
    replacement_employment_id UUID,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (employment_id),
    CHECK ((status = 'replaced') = (replacement_employment_id IS NOT NULL)),
    FOREIGN KEY (tenant_id, employment_id) REFERENCES employment_records(tenant_id, id),
    FOREIGN KEY (tenant_id, agency_id) REFERENCES agencies(tenant_id, id),
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id),
    FOREIGN KEY (tenant_id, replacement_employment_id) REFERENCES employment_records(tenant_id, id)
);
CREATE INDEX idx_replacements_due ON replacement_records(tenant_id, status, due_by);

-- ---- Row-level security and append-only history -------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['duplicate_attempts', 'agency_terms', 'employment_records', 'replacement_records'] LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
        EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())', t);
    END LOOP;
END $$;

CREATE TRIGGER trg_duplicate_attempts_append_only BEFORE UPDATE OR DELETE ON duplicate_attempts FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER trg_agency_terms_append_only BEFORE UPDATE OR DELETE ON agency_terms FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
