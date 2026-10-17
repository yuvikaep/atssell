-- Sprint 5: CSV exports. The worker builds the file from the requester's own permissions at run time;
-- these columns record what was produced and why a job failed.
ALTER TABLE export_jobs
    ADD COLUMN filename TEXT,
    ADD COLUMN row_count INTEGER,
    ADD COLUMN error TEXT,
    ADD COLUMN started_at TIMESTAMPTZ,
    ADD CONSTRAINT export_jobs_type_chk CHECK (export_type IN ('candidates', 'applications', 'vacancies'));

CREATE INDEX idx_export_jobs_queue ON export_jobs(status, created_at) WHERE status IN ('queued', 'running');
CREATE INDEX idx_export_jobs_requester ON export_jobs(tenant_id, requested_by, created_at DESC);
