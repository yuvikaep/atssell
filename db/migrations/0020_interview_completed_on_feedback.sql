-- An interview whose panel has all given (or been excused from) feedback is completed, however the
-- feedback arrived (signed-in form or emailed link). Existing ones are brought up to date too.
CREATE FUNCTION interviews_complete_when_feedback_done() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.feedback_status IN ('submitted', 'waived') THEN
    UPDATE interviews i SET status = 'completed', updated_at = now()
     WHERE i.id = NEW.interview_id AND i.status IN ('scheduled', 'confirmed')
       AND NOT EXISTS (SELECT 1 FROM interviewers m WHERE m.interview_id = i.id AND m.feedback_status = 'pending')
       AND EXISTS (SELECT 1 FROM interviewers m WHERE m.interview_id = i.id AND m.feedback_status = 'submitted');
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER interviewers_complete_interview AFTER UPDATE OF feedback_status ON interviewers
  FOR EACH ROW EXECUTE FUNCTION interviews_complete_when_feedback_done();

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN SELECT i.id, i.tenant_id FROM interviews i
            WHERE i.status IN ('scheduled', 'confirmed')
              AND NOT EXISTS (SELECT 1 FROM interviewers m WHERE m.interview_id = i.id AND m.feedback_status = 'pending')
              AND EXISTS (SELECT 1 FROM interviewers m WHERE m.interview_id = i.id AND m.feedback_status = 'submitted') LOOP
    PERFORM set_config('app.tenant_id', r.tenant_id::text, true);
    UPDATE interviews SET status = 'completed', updated_at = now() WHERE id = r.id;
  END LOOP;
END $$;
