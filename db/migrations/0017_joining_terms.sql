-- Who settles salary and joining date for a job's selected candidates: its recruiter(s), the
-- interviewer who selected them, or the company admin. That person proposes; the admin approves (or
-- enters it directly). Once approved only the admin can change it; recruiters and agencies can see it.
ALTER TABLE vacancies ADD COLUMN terms_owner TEXT NOT NULL DEFAULT 'admin'
    CHECK (terms_owner IN ('recruiter', 'interviewer', 'admin'));

CREATE TABLE joining_terms (
    application_id UUID PRIMARY KEY,
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    annual_ctc NUMERIC(14,2) NOT NULL CHECK (annual_ctc > 0),
    joining_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'approved')),
    proposed_by UUID NOT NULL,
    proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by UUID,
    approved_at TIMESTAMPTZ,
    FOREIGN KEY (tenant_id, application_id) REFERENCES applications(tenant_id, id),
    FOREIGN KEY (tenant_id, proposed_by) REFERENCES users(tenant_id, id),
    FOREIGN KEY (tenant_id, approved_by) REFERENCES users(tenant_id, id)
);
ALTER TABLE joining_terms ENABLE ROW LEVEL SECURITY;
ALTER TABLE joining_terms FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON joining_terms USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
