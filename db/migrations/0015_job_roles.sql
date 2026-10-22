-- Job roles (e.g. "Sales Executive") belong to a department. A recruiter picks one when sourcing, so
-- each application records which role the candidate was sourced for.
CREATE TABLE job_roles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    department_id UUID NOT NULL,
    name TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    status record_status NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, department_id) REFERENCES departments(tenant_id, id)
);
CREATE UNIQUE INDEX job_roles_name ON job_roles (tenant_id, department_id, lower(name));
ALTER TABLE job_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_roles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON job_roles USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

ALTER TABLE applications ADD COLUMN job_role_id UUID,
  ADD FOREIGN KEY (tenant_id, job_role_id) REFERENCES job_roles(tenant_id, id);
CREATE INDEX applications_job_role ON applications (tenant_id, job_role_id) WHERE job_role_id IS NOT NULL;
