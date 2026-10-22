// One plain status per application, the same everywhere: the candidate sheet, its filter and the counts.
// Interviewers decide select / hold / reject; after selection only joining remains (joined or backout).
import { sql } from 'kysely';

export const SIMPLE_STATUSES = ['sourced', 'interview', 'on_hold', 'rejected', 'selected', 'joined', 'backout', 'exited'] as const;
export type SimpleStatus = (typeof SIMPLE_STATUSES)[number];

/** SQL for the plain status of the application row aliased `alias`. */
export function simpleStatusSql(alias: string) {
  const a = sql.raw(alias);
  return sql<SimpleStatus>`(CASE
    WHEN EXISTS (SELECT 1 FROM employment_records e WHERE e.application_id = ${a}.id AND e.status = 'exited') THEN 'exited'
    WHEN EXISTS (SELECT 1 FROM employment_records e WHERE e.application_id = ${a}.id) THEN 'joined'
    WHEN ${a}.temp_employee_code IS NOT NULL AND ${a}.status IN ('withdrawn', 'rejected') THEN 'backout'
    WHEN ${a}.temp_employee_code IS NOT NULL THEN 'selected'
    WHEN ${a}.status IN ('rejected', 'withdrawn') THEN 'rejected'
    WHEN (SELECT d.decision FROM hiring_decisions d WHERE d.application_id = ${a}.id ORDER BY d.decided_at DESC LIMIT 1) = 'reject' THEN 'rejected'
    WHEN (SELECT d.decision FROM hiring_decisions d WHERE d.application_id = ${a}.id ORDER BY d.decided_at DESC LIMIT 1) = 'hold' THEN 'on_hold'
    WHEN EXISTS (SELECT 1 FROM interviews i WHERE i.application_id = ${a}.id AND i.status <> 'cancelled') THEN 'interview'
    ELSE 'sourced' END)`;
}
