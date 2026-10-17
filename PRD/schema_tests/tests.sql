-- Runs as jm_app (NOBYPASSRLS). Each block prints PASS/FAIL.
\set QUIET on
SET client_min_messages = notice;

-- 1. No tenant context -> sees nothing
DO $$ BEGIN
  IF (SELECT count(*) FROM candidates) = 0 THEN RAISE NOTICE 'PASS 1 no tenant context sees 0 candidates';
  ELSE RAISE NOTICE 'FAIL 1'; END IF; END $$;

-- 2. Tenant B cannot see tenant A candidates
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000b', true);
  IF (SELECT count(*) FROM candidates) = 0 AND (SELECT count(*) FROM users) = 1
  THEN RAISE NOTICE 'PASS 2 tenant B sees only own rows';
  ELSE RAISE NOTICE 'FAIL 2'; END IF; END $$;

-- 3. Tenant B cannot insert a row tagged with tenant A
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000b', true);
  INSERT INTO candidates (tenant_id, full_name) VALUES ('00000000-0000-0000-0000-00000000000a', 'x');
  RAISE NOTICE 'FAIL 3';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'PASS 3 RLS WITH CHECK blocks cross-tenant insert'; END $$;

-- 4. Composite FK blocks pointing at another tenant's row (tenant B requisition -> tenant A department)
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000b', true);
  INSERT INTO requisitions (tenant_id, department_id, title, description, headcount, employment_type, location, requested_by)
  VALUES ('00000000-0000-0000-0000-00000000000b', '20000000-0000-0000-0000-00000000000a', 't', 'd', 1, 'ft', 'x',
          '10000000-0000-0000-0000-00000000000b');
  RAISE NOTICE 'FAIL 4';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS 4 composite FK blocks cross-tenant reference'; END $$;

-- 5. Department cycle rejected (Engineering -> parent Platform, while Platform's parent is Engineering)
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  UPDATE departments SET parent_department_id = '20000000-0000-0000-0000-0000000000a2'
   WHERE id = '20000000-0000-0000-0000-00000000000a';
  RAISE NOTICE 'FAIL 5';
EXCEPTION WHEN SQLSTATE 'JMD01' THEN RAISE NOTICE 'PASS 5 department cycle rejected'; END $$;

-- 6. Invalid token
DO $$ BEGIN
  PERFORM submit_feedback(encode(digest('nope','sha256'),'hex'), 'google_meet', 4::smallint, 'yes', '{}', '');
  RAISE NOTICE 'FAIL 6';
EXCEPTION WHEN SQLSTATE 'JMF01' THEN RAISE NOTICE 'PASS 6 invalid token -> JMF01'; END $$;

-- 7. Expired token
DO $$ BEGIN
  PERFORM submit_feedback(encode(digest('tok-two','sha256'),'hex'), 'google_meet', 4::smallint, 'yes', '{}', '');
  RAISE NOTICE 'FAIL 7';
EXCEPTION WHEN SQLSTATE 'JMF02' THEN RAISE NOTICE 'PASS 7 expired token -> JMF02'; END $$;

-- 8. Revoked token
DO $$ BEGIN
  PERFORM submit_feedback(encode(digest('tok-three','sha256'),'hex'), 'google_meet', 4::smallint, 'yes', '{}', '');
  RAISE NOTICE 'FAIL 8';
EXCEPTION WHEN SQLSTATE 'JMF02' THEN RAISE NOTICE 'PASS 8 revoked token -> JMF02'; END $$;

-- 9. Token-only context can see exactly one link row, and nothing else
DO $$ BEGIN
  PERFORM set_config('app.feedback_token_hash', encode(digest('tok-one','sha256'),'hex'), true);
  IF (SELECT count(*) FROM feedback_links) = 1 AND (SELECT count(*) FROM candidates) = 0
  THEN RAISE NOTICE 'PASS 9 token policy exposes only its own link';
  ELSE RAISE NOTICE 'FAIL 9'; END IF; END $$;
