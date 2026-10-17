-- Sprint 1: password login, sessions, password reset, built-in roles.

ALTER TABLE users ADD COLUMN password_hash TEXT;

-- Server-side sessions. The cookie holds a random token; only its SHA-256 is stored.
CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    revoked_at TIMESTAMPTZ,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ip_hash TEXT,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);
CREATE INDEX idx_sessions_user_active ON sessions(tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE password_reset_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    user_id UUID NOT NULL,
    token_hash TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (expires_at > created_at),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id)
);

-- Same RLS model as 0001, plus token-only read access used before a tenant is known.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sessions
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY session_by_token ON sessions FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.session_token_hash', true), ''));

ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON password_reset_tokens
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY reset_by_token ON password_reset_tokens FOR SELECT
    USING (token_hash = NULLIF(current_setting('app.reset_token_hash', true), ''));

-- ---------------------------------------------------------------------------
-- Built-in roles (tenant_id NULL, shared by every tenant)
-- ---------------------------------------------------------------------------
INSERT INTO roles (code, name, is_system_role) VALUES
    ('company_admin',       'Company Admin',            true),
    ('hr_head',             'HR / TA Head',             true),
    ('recruitment_manager', 'Recruitment Manager',      true),
    ('internal_recruiter',  'Internal Recruiter',       true),
    ('hiring_manager',      'Hiring Manager',           true),
    ('interviewer',         'Interviewer',              true),
    ('offer_approver',      'Offer / Finance Approver', true),
    ('agency_admin',        'Agency Admin',             true),
    ('agency_recruiter',    'Agency Recruiter',         true);

-- Company Admin gets every permission.
INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, p.code FROM roles r CROSS JOIN permissions p
WHERE r.tenant_id IS NULL AND r.code = 'company_admin';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, m.permission_code
FROM (VALUES
    ('hr_head', 'requisitions.create'), ('hr_head', 'requisitions.approve'),
    ('hr_head', 'vacancies.view_all'), ('hr_head', 'vacancies.manage'),
    ('hr_head', 'candidates.view'), ('hr_head', 'candidates.view_contact'),
    ('hr_head', 'candidates.view_compensation'), ('hr_head', 'candidates.manage'),
    ('hr_head', 'applications.manage'), ('hr_head', 'ownership.resolve'),
    ('hr_head', 'agencies.manage'), ('hr_head', 'interviews.manage'),
    ('hr_head', 'feedback_links.manage'), ('hr_head', 'feedback.view'),
    ('hr_head', 'feedback.correct'), ('hr_head', 'decisions.record'),
    ('hr_head', 'offers.manage'), ('hr_head', 'analytics.view'),
    ('hr_head', 'exports.create'), ('hr_head', 'audit.view'),

    ('recruitment_manager', 'vacancies.view_all'), ('recruitment_manager', 'vacancies.manage'),
    ('recruitment_manager', 'candidates.view'), ('recruitment_manager', 'candidates.view_contact'),
    ('recruitment_manager', 'candidates.manage'), ('recruitment_manager', 'applications.manage'),
    ('recruitment_manager', 'submissions.create'), ('recruitment_manager', 'ownership.resolve'),
    ('recruitment_manager', 'agencies.manage'), ('recruitment_manager', 'interviews.manage'),
    ('recruitment_manager', 'feedback_links.manage'), ('recruitment_manager', 'feedback.view'),
    ('recruitment_manager', 'feedback.correct'), ('recruitment_manager', 'analytics.view'),
    ('recruitment_manager', 'exports.create'),

    ('internal_recruiter', 'vacancies.view_assigned'), ('internal_recruiter', 'candidates.view'),
    ('internal_recruiter', 'candidates.view_contact'), ('internal_recruiter', 'candidates.manage'),
    ('internal_recruiter', 'applications.manage'), ('internal_recruiter', 'submissions.create'),
    ('internal_recruiter', 'interviews.manage'), ('internal_recruiter', 'feedback_links.manage'),
    ('internal_recruiter', 'feedback.view'),

    ('hiring_manager', 'requisitions.create'), ('hiring_manager', 'vacancies.view_assigned'),
    ('hiring_manager', 'candidates.view'), ('hiring_manager', 'feedback.view'),
    ('hiring_manager', 'decisions.record'), ('hiring_manager', 'analytics.view'),

    -- Interviewer: no permissions; sees only interviews they are assigned to (Sprint 4).

    ('offer_approver', 'offers.approve'), ('offer_approver', 'candidates.view_compensation'),

    ('agency_admin', 'vacancies.view_assigned'), ('agency_admin', 'candidates.view'),
    ('agency_admin', 'submissions.create'),
    ('agency_recruiter', 'vacancies.view_assigned'), ('agency_recruiter', 'candidates.view'),
    ('agency_recruiter', 'submissions.create')
) AS m(role_code, permission_code)
JOIN roles r ON r.code = m.role_code AND r.tenant_id IS NULL;
