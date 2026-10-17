-- Fee and invoice tracking per hire, and the HR Lead's audited ownership correction.
ALTER TABLE employment_records
    ADD COLUMN invoice_status TEXT NOT NULL DEFAULT 'not_invoiced' CHECK (invoice_status IN ('not_invoiced', 'invoiced', 'paid', 'credited')),
    ADD COLUMN invoice_reference TEXT;

INSERT INTO permissions (code, description) VALUES ('ownership.correct', 'Correct a submission''s ownership in exceptional cases (audited)');
INSERT INTO role_permissions (role_id, permission_code)
SELECT id, 'ownership.correct' FROM roles WHERE tenant_id IS NULL AND code = 'company_admin';
