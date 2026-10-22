-- The interviewers a job uses. Scheduling an interview for the job offers only these people and the
-- company admins, instead of everyone in the company.
CREATE TABLE vacancy_interviewers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    vacancy_id UUID NOT NULL,
    user_id UUID NOT NULL,
    assigned_by UUID NOT NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, id),
    UNIQUE (vacancy_id, user_id),
    FOREIGN KEY (tenant_id, vacancy_id) REFERENCES vacancies(tenant_id, id),
    FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, assigned_by) REFERENCES users(tenant_id, id)
);
ALTER TABLE vacancy_interviewers ENABLE ROW LEVEL SECURITY;
ALTER TABLE vacancy_interviewers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON vacancy_interviewers USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
