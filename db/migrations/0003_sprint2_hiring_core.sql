-- Sprint 2: requisition approval rounds, vacancy codes, cancellation reasons.

-- A rejected requisition can be edited and resubmitted. Each submission is a new approval round,
-- so earlier decisions stay in history instead of being overwritten.
ALTER TABLE requisition_approvals ADD COLUMN round INTEGER NOT NULL DEFAULT 1 CHECK (round > 0);
ALTER TABLE requisition_approvals DROP CONSTRAINT requisition_approvals_requisition_id_step_order_key;
ALTER TABLE requisition_approvals ADD CONSTRAINT uq_requisition_approvals_step UNIQUE (requisition_id, round, step_order);

ALTER TABLE requisitions
    ADD COLUMN approval_round INTEGER NOT NULL DEFAULT 0 CHECK (approval_round >= 0),
    ADD COLUMN cancel_reason TEXT,
    ADD CONSTRAINT requisitions_cancel_reason CHECK (status <> 'cancelled' OR cancel_reason IS NOT NULL);

ALTER TABLE vacancies
    ADD COLUMN status_reason TEXT;

-- Per-tenant sequences (e.g. vacancy codes VAC-0001). UPDATE ... RETURNING is atomic per row.
CREATE TABLE tenant_counters (
    tenant_id UUID NOT NULL REFERENCES tenants(id),
    name TEXT NOT NULL,
    value BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, name)
);
ALTER TABLE tenant_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_counters
    USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());

CREATE INDEX idx_requisitions_tenant_status ON requisitions(tenant_id, status, created_at DESC);
CREATE INDEX idx_vacancies_tenant_status ON vacancies(tenant_id, status, opened_at DESC);
CREATE INDEX idx_vacancy_agencies_agency ON vacancy_agencies(agency_id) WHERE status = 'active';
CREATE INDEX idx_candidates_city ON candidates(tenant_id, lower(city)) WHERE status = 'active';
