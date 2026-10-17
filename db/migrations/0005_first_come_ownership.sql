-- Ownership policy change: the first party to source a candidate is credited automatically and
-- permanently. Nobody at the company decides or changes it, and a later attempt to source a candidate
-- who is already in the database is rejected as a duplicate (nothing is stored for it).
--
-- The ownership window, the dispute and review states and the manager decision permission are retired.
-- The columns stay (migrations are never edited); the application no longer uses them.

-- Existing agency submissions: the earliest source of each candidate keeps the credit; any later
-- agency submission by a different source is marked rejected (what the new rule would have done).
-- Internal submissions are untouched: using a candidate is not a sourcing claim.
WITH first_source AS (
    SELECT DISTINCT ON (a.candidate_id) a.candidate_id, s.agency_id
    FROM submissions s
    JOIN applications a ON a.id = s.application_id
    ORDER BY a.candidate_id, s.submitted_at, s.id
),
changes AS (
    SELECT s.id, s.tenant_id, s.ownership_state AS previous_state,
           CASE WHEN s.agency_id IS NOT DISTINCT FROM f.agency_id THEN 'accepted' ELSE 'rejected' END AS new_state
    FROM submissions s
    JOIN applications a ON a.id = s.application_id
    JOIN first_source f ON f.candidate_id = a.candidate_id
    WHERE s.agency_id IS NOT NULL
),
updated AS (
    UPDATE submissions s
    SET ownership_state = c.new_state, ownership_expires_at = NULL
    FROM changes c
    WHERE s.id = c.id AND (s.ownership_state <> c.new_state OR s.ownership_expires_at IS NOT NULL)
    RETURNING s.id, s.tenant_id, c.previous_state, c.new_state
)
INSERT INTO ownership_events (tenant_id, submission_id, event_type, previous_state, new_state, reason)
SELECT tenant_id, id, 'policy_migrated', previous_state, new_state,
       'Ownership policy changed to first come, first credited'
FROM updated;

UPDATE submissions SET ownership_expires_at = NULL WHERE ownership_expires_at IS NOT NULL;

-- Managers no longer decide ownership.
DELETE FROM role_permissions WHERE permission_code = 'ownership.resolve';
DELETE FROM permissions WHERE code = 'ownership.resolve';

DROP INDEX IF EXISTS idx_submissions_ownership_review;
