-- Hiring managers take part in interviews and feedback; they no longer raise requisitions or see reports.
-- They can request (schedule) interviews for candidates on vacancies in their department.
-- Company-wide system role: applies to every company.
DELETE FROM role_permissions
WHERE permission_code IN ('requisitions.create', 'analytics.view')
  AND role_id IN (SELECT id FROM roles WHERE code = 'hiring_manager' AND tenant_id IS NULL);

INSERT INTO role_permissions (role_id, permission_code)
SELECT id, 'interviews.manage' FROM roles WHERE code = 'hiring_manager' AND tenant_id IS NULL
ON CONFLICT DO NOTHING;
