import { forbidden } from './errors.js';
import type { Tx } from './db.js';

/**
 * Effective permission scope: 'all' when granted by a company-wide role assignment, otherwise the
 * list of departments the permission is granted for.
 */
export type PermissionScope = 'all' | string[];

export interface Principal {
  userId: string;
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  email: string;
  fullName: string;
  sessionId: string;
  /** An admin chose this person's password; they must pick their own before doing anything else. */
  mustChangePassword: boolean;
  roles: { code: string; name: string; departmentId: string | null }[];
  permissions: Record<string, PermissionScope>;
}

export async function loadRolesAndPermissions(tx: Tx, userId: string) {
  const rows = await tx
    .selectFrom('user_role_assignments as ura')
    .innerJoin('roles as r', 'r.id', 'ura.role_id')
    .leftJoin('role_permissions as rp', 'rp.role_id', 'r.id')
    .select(['r.code', 'r.name', 'ura.department_id', 'ura.role_id', 'rp.permission_code'])
    .where('ura.user_id', '=', userId)
    .execute();

  const roles = new Map<string, Principal['roles'][number]>();
  const permissions: Record<string, PermissionScope> = {};
  for (const row of rows) {
    roles.set(`${row.role_id}:${row.department_id ?? ''}`, {
      code: row.code,
      name: row.name,
      departmentId: row.department_id,
    });
    if (!row.permission_code) continue;
    const current = permissions[row.permission_code];
    if (row.department_id === null) {
      permissions[row.permission_code] = 'all';
    } else if (current !== 'all') {
      permissions[row.permission_code] = [...new Set([...(current ?? []), row.department_id])];
    }
  }
  return { roles: [...roles.values()], permissions };
}

/** True when the permission is held company-wide, or for departmentId when one is given. */
export function can(p: Principal, permission: string, departmentId?: string): boolean {
  const scope = p.permissions[permission];
  if (!scope) return false;
  if (scope === 'all') return true;
  return departmentId !== undefined && scope.includes(departmentId);
}

export function requirePermission(p: Principal, permission: string, departmentId?: string): void {
  if (!can(p, permission, departmentId)) throw forbidden();
}
