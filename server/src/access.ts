// Row-level visibility rules for hiring data. RLS already limits every query to the tenant; these
// rules decide which of the tenant's requisitions, vacancies and candidates a principal may see.
import { sql, type ExpressionBuilder, type Expression, type SqlBool } from 'kysely';
import type { Tx } from './db.js';
import { can, type PermissionScope, type Principal } from './permissions.js';

/** Union of several permissions' scopes: 'all' if any is company-wide, else the merged departments. */
export function scopeOf(p: Principal, permissions: string[]): PermissionScope | null {
  let depts: string[] | null = null;
  for (const perm of permissions) {
    const scope = p.permissions[perm];
    if (!scope) continue;
    if (scope === 'all') return 'all';
    depts = [...new Set([...(depts ?? []), ...scope])];
  }
  return depts;
}

export function hasAny(p: Principal, permission: string) {
  return p.permissions[permission] !== undefined;
}

export async function agencyIdOf(tx: Tx, userId: string): Promise<string | null> {
  const row = await tx.selectFrom('agency_members').select('agency_id').where('user_id', '=', userId).executeTakeFirst();
  return row?.agency_id ?? null;
}

const FALSE = sql<SqlBool>`false`;
const TRUE = sql<SqlBool>`true`;

// ---------------------------------------------------------------------------
// Requisitions
// ---------------------------------------------------------------------------

const REQUISITION_DEPT_PERMS = ['requisitions.create', 'requisitions.approve', 'vacancies.view_all', 'vacancies.manage'];

/** For a query over `requisitions as rq`. */
export function requisitionVisible(p: Principal) {
  const scope = scopeOf(p, REQUISITION_DEPT_PERMS);
  return (eb: ExpressionBuilder<any, any>): Expression<SqlBool> => {
    if (scope === 'all') return TRUE;
    const ors: Expression<SqlBool>[] = [
      eb('rq.requested_by', '=', p.userId),
      eb('rq.hiring_manager_id', '=', p.userId),
      eb.exists(
        eb.selectFrom('requisition_approvals as ra')
          .select('ra.id')
          .whereRef('ra.requisition_id', '=', 'rq.id')
          .where('ra.approver_user_id', '=', p.userId),
      ),
    ];
    if (scope && scope.length > 0) ors.push(eb('rq.department_id', 'in', scope));
    return eb.or(ors);
  };
}

/** Budget (CTC range) is visible to people who raise or approve requisitions for the department. */
export function canSeeRequisitionBudget(p: Principal, departmentId: string, requestedBy: string) {
  return (
    requestedBy === p.userId ||
    can(p, 'requisitions.create', departmentId) ||
    can(p, 'requisitions.approve', departmentId) ||
    can(p, 'candidates.view_compensation') ||
    can(p, 'offers.approve')
  );
}

// ---------------------------------------------------------------------------
// Vacancies
// ---------------------------------------------------------------------------

/**
 * For a query over `vacancies as v` joined to `requisitions as rq`.
 * - vacancies.view_all: every vacancy in its scope (company or departments).
 * - vacancies.view_assigned: vacancies the user owns, recruits for, is hiring manager of, or whose
 *   agency is assigned; a department-scoped grant also covers that department's vacancies.
 */
export function vacancyVisible(p: Principal, agencyId: string | null) {
  const all = p.permissions['vacancies.view_all'];
  const assigned = p.permissions['vacancies.view_assigned'];
  return (eb: ExpressionBuilder<any, any>): Expression<SqlBool> => {
    if (all === 'all') return TRUE;
    const ors: Expression<SqlBool>[] = [];
    const deptScope = [...(Array.isArray(all) ? all : []), ...(Array.isArray(assigned) ? assigned : [])];
    if (deptScope.length > 0) ors.push(eb('rq.department_id', 'in', deptScope));
    if (assigned) {
      ors.push(eb('v.owner_user_id', '=', p.userId));
      ors.push(eb('rq.hiring_manager_id', '=', p.userId));
      ors.push(
        eb.exists(
          eb.selectFrom('vacancy_recruiters as vr')
            .select('vr.id')
            .whereRef('vr.vacancy_id', '=', 'v.id')
            .where('vr.recruiter_user_id', '=', p.userId)
            .where('vr.unassigned_at', 'is', null),
        ),
      );
      if (agencyId) {
        ors.push(
          eb.exists(
            eb.selectFrom('vacancy_agencies as va')
              .select('va.id')
              .whereRef('va.vacancy_id', '=', 'v.id')
              .where('va.agency_id', '=', agencyId)
              .where('va.status', '=', 'active'),
          ),
        );
      }
    }
    return ors.length > 0 ? eb.or(ors) : FALSE;
  };
}

// ---------------------------------------------------------------------------
// Candidates
// ---------------------------------------------------------------------------

/**
 * For a query over `candidates as c`.
 * - Agency users: only candidates their agency submitted (agency workspace, Sprint 3).
 * - candidates.view company-wide: the whole candidate database.
 * - candidates.view for departments: candidates with an application to a vacancy in those departments.
 */
export function candidateVisible(p: Principal, agencyId: string | null) {
  const scope = p.permissions['candidates.view'];
  return (eb: ExpressionBuilder<any, any>): Expression<SqlBool> => {
    if (!scope) return FALSE;
    if (agencyId) {
      return eb.exists(
        eb.selectFrom('applications as a')
          .innerJoin('submissions as s', 's.application_id', 'a.id')
          .select('a.id')
          .whereRef('a.candidate_id', '=', 'c.id')
          .where('s.agency_id', '=', agencyId),
      );
    }
    if (scope === 'all') return TRUE;
    return eb.exists(
      eb.selectFrom('applications as a')
        .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
        .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
        .select('a.id')
        .whereRef('a.candidate_id', '=', 'c.id')
        .where('rq.department_id', 'in', scope),
    );
  };
}

/** Removes fields the principal may not see. Contact and compensation are never sent unless permitted. */
export function redactCandidate<T extends Record<string, unknown>>(p: Principal, c: T, agencyId: string | null) {
  const out: Record<string, unknown> = { ...c };
  if (!hasAny(p, 'candidates.view_contact') && !agencyId) {
    delete out.email;
    delete out.phone;
  }
  if (!hasAny(p, 'candidates.view_compensation')) {
    delete out.current_ctc;
    delete out.expected_ctc;
  }
  return out as Partial<T>;
}
