-- Runs as superuser: creates app role and two tenants with a full interview chain.
CREATE ROLE jm_app LOGIN NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO jm_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jm_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO jm_app;

INSERT INTO tenants (id, name, slug) VALUES
 ('00000000-0000-0000-0000-00000000000a', 'Acme', 'acme'),
 ('00000000-0000-0000-0000-00000000000b', 'Beta', 'beta');

INSERT INTO users (id, tenant_id, email, full_name) VALUES
 ('10000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'r@acme.test', 'Acme Recruiter'),
 ('10000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'r@beta.test', 'Beta Recruiter');

INSERT INTO departments (id, tenant_id, name) VALUES
 ('20000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Engineering'),
 ('20000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-00000000000a', 'Platform'),
 ('20000000-0000-0000-0000-00000000000b', '00000000-0000-0000-0000-00000000000b', 'Sales');
UPDATE departments SET parent_department_id = '20000000-0000-0000-0000-00000000000a'
 WHERE id = '20000000-0000-0000-0000-0000000000a2';

INSERT INTO requisitions (id, tenant_id, department_id, title, description, headcount, employment_type, location, requested_by)
VALUES ('30000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a',
        '20000000-0000-0000-0000-00000000000a', 'Backend Engineer', 'desc', 2, 'full_time', 'Pune',
        '10000000-0000-0000-0000-00000000000a');
INSERT INTO vacancies (id, tenant_id, requisition_id, vacancy_code, title, location)
VALUES ('40000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a',
        '30000000-0000-0000-0000-00000000000a', 'ENG-001', 'Backend Engineer', 'Pune');
INSERT INTO pipeline_stages (id, tenant_id, code, name, sort_order, is_initial) VALUES
 ('50000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'submitted', 'Submitted', 1, true);
INSERT INTO candidates (id, tenant_id, full_name, email) VALUES
 ('60000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a', 'Asha Rao', 'asha@example.test');
INSERT INTO applications (id, tenant_id, candidate_id, vacancy_id, stage_id) VALUES
 ('70000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a',
  '60000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-00000000000a',
  '50000000-0000-0000-0000-00000000000a');
INSERT INTO interviews (id, tenant_id, application_id, round_name, mode, scheduled_start, scheduled_end, status, created_by)
VALUES ('80000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-00000000000a',
        '70000000-0000-0000-0000-00000000000a', 'Technical', 'google_meet',
        now() + interval '1 day', now() + interval '1 day 1 hour', 'scheduled',
        '10000000-0000-0000-0000-00000000000a');
-- Three interviewers: happy path, expired link, revoked link.
INSERT INTO interviewers (id, tenant_id, interview_id, external_name, external_email) VALUES
 ('90000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', 'Int One', 'one@ext.test'),
 ('90000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', 'Int Two', 'two@ext.test'),
 ('90000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', 'Int Three', 'three@ext.test');
INSERT INTO feedback_links (tenant_id, interview_id, interviewer_id, token_hash, expires_at, created_by, created_at) VALUES
 ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-000000000001',
  encode(digest('tok-one','sha256'),'hex'), now() + interval '7 days', '10000000-0000-0000-0000-00000000000a', now()),
 ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-000000000002',
  encode(digest('tok-two','sha256'),'hex'), now() - interval '1 hour', '10000000-0000-0000-0000-00000000000a', now() - interval '8 days'),
 ('00000000-0000-0000-0000-00000000000a', '80000000-0000-0000-0000-00000000000a', '90000000-0000-0000-0000-000000000003',
  encode(digest('tok-three','sha256'),'hex'), now() + interval '7 days', '10000000-0000-0000-0000-00000000000a', now());
UPDATE feedback_links SET status = 'revoked', revoked_at = now()
 WHERE interviewer_id = '90000000-0000-0000-0000-000000000003';
