-- Readable IDs, numbered per company:
--   sourcing_code       SRC-000001  given when a candidate is sourced for a job (every application)
--   temp_employee_code  TEMP-00001  given once the candidate is selected (a "select" decision) or hired
-- Assigned by triggers so every way of sourcing or selecting gets one. They run as the caller, under
-- row-level security, inside the company's own context.

ALTER TABLE applications ADD COLUMN sourcing_code TEXT, ADD COLUMN temp_employee_code TEXT;

CREATE FUNCTION next_tenant_code(p_tenant UUID, p_name TEXT) RETURNS BIGINT
LANGUAGE sql SET search_path = public, pg_temp AS $$
  INSERT INTO tenant_counters (tenant_id, name, value) VALUES (p_tenant, p_name, 1)
  ON CONFLICT (tenant_id, name) DO UPDATE SET value = tenant_counters.value + 1
  RETURNING value;
$$;

CREATE FUNCTION applications_assign_codes() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'INSERT' AND NEW.sourcing_code IS NULL THEN
    NEW.sourcing_code := 'SRC-' || lpad(next_tenant_code(NEW.tenant_id, 'sourcing')::text, 6, '0');
  END IF;
  IF NEW.status = 'hired' AND NEW.temp_employee_code IS NULL THEN
    NEW.temp_employee_code := 'TEMP-' || lpad(next_tenant_code(NEW.tenant_id, 'temp_employee')::text, 5, '0');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER applications_codes BEFORE INSERT OR UPDATE OF status ON applications
  FOR EACH ROW EXECUTE FUNCTION applications_assign_codes();

CREATE FUNCTION hiring_decisions_temp_code() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.decision = 'select' THEN
    UPDATE applications
       SET temp_employee_code = 'TEMP-' || lpad(next_tenant_code(NEW.tenant_id, 'temp_employee')::text, 5, '0')
     WHERE tenant_id = NEW.tenant_id AND id = NEW.application_id AND temp_employee_code IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER hiring_decisions_temp_code AFTER INSERT ON hiring_decisions
  FOR EACH ROW EXECUTE FUNCTION hiring_decisions_temp_code();

-- Existing rows, oldest first.
DO $$
DECLARE r RECORD;
BEGIN
  -- Each row is written inside its own company's context, so this works whether or not the
  -- migrating role bypasses row-level security.
  FOR r IN SELECT id, tenant_id FROM applications WHERE sourcing_code IS NULL ORDER BY created_at, id LOOP
    PERFORM set_config('app.tenant_id', r.tenant_id::text, true);
    UPDATE applications SET sourcing_code = 'SRC-' || lpad(next_tenant_code(r.tenant_id, 'sourcing')::text, 6, '0') WHERE id = r.id;
  END LOOP;
  FOR r IN SELECT a.id, a.tenant_id FROM applications a
            WHERE a.temp_employee_code IS NULL
              AND (a.status = 'hired' OR EXISTS (SELECT 1 FROM hiring_decisions d WHERE d.application_id = a.id AND d.decision = 'select'))
            ORDER BY a.updated_at, a.id LOOP
    PERFORM set_config('app.tenant_id', r.tenant_id::text, true);
    UPDATE applications SET temp_employee_code = 'TEMP-' || lpad(next_tenant_code(r.tenant_id, 'temp_employee')::text, 5, '0') WHERE id = r.id;
  END LOOP;
END $$;

ALTER TABLE applications ALTER COLUMN sourcing_code SET NOT NULL;
CREATE UNIQUE INDEX applications_sourcing_code ON applications (tenant_id, sourcing_code);
CREATE UNIQUE INDEX applications_temp_employee_code ON applications (tenant_id, temp_employee_code) WHERE temp_employee_code IS NOT NULL;
