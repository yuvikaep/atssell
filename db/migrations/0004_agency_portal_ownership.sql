-- Sprint 3: agency portal, submissions as a source record, ownership rules.

-- What the agency actually declared when it submitted. Agencies read this, never the canonical
-- candidate record, which may hold details from other sources (internal staff, other agencies).
ALTER TABLE submissions
    ADD COLUMN submitted_profile JSONB,
    ADD COLUMN source_declaration TEXT,
    ADD COLUMN consent_confirmed BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE submissions
    ADD CONSTRAINT submissions_agency_needs_user CHECK (source_type <> 'agency' OR source_user_id IS NOT NULL);

-- One submission per agency per application. A second agency (or internal source) may still add its own.
CREATE UNIQUE INDEX uq_submissions_agency_application
    ON submissions(application_id, agency_id) WHERE source_type = 'agency';

CREATE INDEX idx_submissions_ownership_review
    ON submissions(tenant_id, ownership_state, submitted_at DESC)
    WHERE ownership_state IN ('pending_review', 'disputed');
CREATE INDEX idx_ownership_events_submission ON ownership_events(submission_id, created_at);

-- ---------------------------------------------------------------------------
-- Agency roles: portal only
-- ---------------------------------------------------------------------------
-- Agency users must not reach any internal endpoint. They lose vacancies.view_assigned and
-- candidates.view (which would expose the internal candidate and vacancy views) and get a dedicated
-- portal permission instead. Everything they do goes through /agency/*.
INSERT INTO permissions (code, description) VALUES
    ('agency_portal.use', 'Use the agency portal: see assigned vacancies and submit candidates');

DELETE FROM role_permissions
WHERE role_id IN (SELECT id FROM roles WHERE tenant_id IS NULL AND code IN ('agency_admin', 'agency_recruiter'))
  AND permission_code <> 'submissions.create';

INSERT INTO role_permissions (role_id, permission_code)
SELECT r.id, 'agency_portal.use' FROM roles r
WHERE r.tenant_id IS NULL AND r.code IN ('agency_admin', 'agency_recruiter');
