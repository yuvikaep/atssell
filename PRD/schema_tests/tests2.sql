-- Runs as jm_app after the concurrency test has consumed tok-one.
SET client_min_messages = notice;

-- 11. Replay after success
DO $$ BEGIN
  PERFORM submit_feedback(encode(digest('tok-one','sha256'),'hex'), 'google_meet', 4::smallint, 'yes', '{}', '');
  RAISE NOTICE 'FAIL 11';
EXCEPTION WHEN SQLSTATE 'JMF03' THEN RAISE NOTICE 'PASS 11 replay -> JMF03'; END $$;

-- 12. Side effects of the one successful submission
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  IF (SELECT count(*) FROM feedback) = 1
     AND (SELECT status FROM feedback_links WHERE interviewer_id = '90000000-0000-0000-0000-000000000001') = 'consumed'
     AND (SELECT feedback_status FROM interviewers WHERE id = '90000000-0000-0000-0000-000000000001') = 'submitted'
     AND (SELECT count(*) FROM audit_events WHERE action = 'feedback.submitted') = 1
  THEN RAISE NOTICE 'PASS 12 one feedback, link consumed, interviewer submitted, one audit event';
  ELSE RAISE NOTICE 'FAIL 12 feedback=% audit=%', (SELECT count(*) FROM feedback),
       (SELECT count(*) FROM audit_events WHERE action = 'feedback.submitted'); END IF; END $$;

-- 13. Feedback is immutable
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  UPDATE feedback SET overall_rating = 1;
  RAISE NOTICE 'FAIL 13';
EXCEPTION WHEN SQLSTATE 'JMA01' THEN RAISE NOTICE 'PASS 13 feedback UPDATE blocked'; END $$;

-- 14. Correction is recorded alongside the original
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO feedback_corrections (tenant_id, feedback_id, version, mode, overall_rating, recommendation, reason, corrected_by)
  SELECT tenant_id, id, 1, mode, 3, 'hold', 'Interviewer emailed a correction', '10000000-0000-0000-0000-00000000000a' FROM feedback;
  IF (SELECT count(*) FROM feedback_corrections) = 1 AND (SELECT overall_rating FROM feedback) = 4
  THEN RAISE NOTICE 'PASS 14 correction stored, original untouched';
  ELSE RAISE NOTICE 'FAIL 14'; END IF; END $$;

-- 15. Only one active link per interviewer
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO feedback_links (tenant_id, interview_id, interviewer_id, token_hash, expires_at, created_by)
  VALUES ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-000000000003',
          encode(digest('tok-3a','sha256'),'hex'), now() + interval '1 day', '10000000-0000-0000-0000-00000000000a');
  INSERT INTO feedback_links (tenant_id, interview_id, interviewer_id, token_hash, expires_at, created_by)
  VALUES ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-000000000003',
          encode(digest('tok-3b','sha256'),'hex'), now() + interval '1 day', '10000000-0000-0000-0000-00000000000a');
  RAISE NOTICE 'FAIL 15';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS 15 second active link rejected'; END $$;

-- 16. Link interview_id must match the interviewer's interview
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  INSERT INTO interviews (id, tenant_id, application_id, round_name, mode, created_by)
  VALUES ('80000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a',
          '70000000-0000-0000-0000-00000000000a', 'HR', 'telephonic', '10000000-0000-0000-0000-00000000000a');
  INSERT INTO feedback_links (tenant_id, interview_id, interviewer_id, token_hash, expires_at, created_by)
  VALUES ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-0000000000a2', '90000000-0000-0000-0000-000000000001',
          encode(digest('tok-mismatch','sha256'),'hex'), now() + interval '1 day', '10000000-0000-0000-0000-00000000000a');
  RAISE NOTICE 'FAIL 16';
EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS 16 mismatched interview/interviewer rejected'; END $$;

-- 17. Reapply after rejection allowed; two active applications not allowed
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  BEGIN
    INSERT INTO applications (tenant_id, candidate_id, vacancy_id, stage_id)
    VALUES ('00000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-00000000000a',
            '40000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-00000000000a');
    RAISE NOTICE 'FAIL 17a';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS 17a duplicate active application rejected'; END;
  UPDATE applications SET status = 'rejected' WHERE id = '70000000-0000-0000-0000-00000000000a';
  INSERT INTO applications (tenant_id, candidate_id, vacancy_id, stage_id)
  VALUES ('00000000-0000-0000-0000-00000000000a', '60000000-0000-0000-0000-00000000000a',
          '40000000-0000-0000-0000-00000000000a', '50000000-0000-0000-0000-00000000000a');
  RAISE NOTICE 'PASS 17b reapply after rejection allowed';
END $$;

-- 18. Audit log is append-only
DO $$ BEGIN
  PERFORM set_config('app.tenant_id', '00000000-0000-0000-0000-00000000000a', true);
  DELETE FROM audit_events;
  RAISE NOTICE 'FAIL 18';
EXCEPTION WHEN SQLSTATE 'JMA01' THEN RAISE NOTICE 'PASS 18 audit DELETE blocked'; END $$;
