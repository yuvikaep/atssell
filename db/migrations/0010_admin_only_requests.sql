-- Only the company's admin raises hiring requests (requisitions). HR heads still approve them.
-- Internal recruiters never held requisitions.create, vacancies.manage or agencies.manage: they work
-- only on vacancies assigned to them.
DELETE FROM role_permissions
WHERE permission_code = 'requisitions.create'
  AND role_id IN (SELECT id FROM roles WHERE code IN ('hr_head', 'hiring_manager') AND tenant_id IS NULL);
