// CSV exports. A job records which fields the requester may export when it is created; the worker
// builds the file later using the requester's permissions as they are at that moment, so a person
// whose access was removed in between gets a failed job, not a file.
import { candidateVisible, hasAny, vacancyVisible } from './access.js';
import type { Tx } from './db.js';
import { loadRolesAndPermissions, type Principal } from './permissions.js';

export const EXPORT_TYPES = ['candidates', 'applications', 'vacancies'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];
export const MAX_EXPORT_ROWS = 50_000;
export const EXPORT_TTL_HOURS = 24;

interface FieldDef { label: string; needs?: string }

/** Every exportable column, and the extra permission (if any) needed to include it. */
export const EXPORT_FIELDS: Record<ExportType, Record<string, FieldDef>> = {
  candidates: {
    full_name: { label: 'Name' },
    email: { label: 'Email', needs: 'candidates.view_contact' },
    phone: { label: 'Phone', needs: 'candidates.view_contact' },
    city: { label: 'City' },
    current_title: { label: 'Current title' },
    total_experience_years: { label: 'Experience (years)' },
    notice_period_days: { label: 'Notice period (days)' },
    current_ctc: { label: 'Current CTC', needs: 'candidates.view_compensation' },
    expected_ctc: { label: 'Expected CTC', needs: 'candidates.view_compensation' },
    skills: { label: 'Skills' },
    created_at: { label: 'Added on' },
  },
  applications: {
    candidate_name: { label: 'Candidate' },
    candidate_email: { label: 'Candidate email', needs: 'candidates.view_contact' },
    vacancy_code: { label: 'Vacancy code' },
    vacancy_title: { label: 'Vacancy' },
    department: { label: 'Department' },
    stage: { label: 'Stage' },
    status: { label: 'Status' },
    applied_on: { label: 'Applied on' },
  },
  vacancies: {
    vacancy_code: { label: 'Vacancy code' },
    title: { label: 'Title' },
    department: { label: 'Department' },
    location: { label: 'Location' },
    status: { label: 'Status' },
    opened_on: { label: 'Opened on' },
  },
};

/** Fields this principal may include in an export of `type`. */
export function allowedFields(p: Principal, type: ExportType): string[] {
  return Object.entries(EXPORT_FIELDS[type]).filter(([, d]) => !d.needs || hasAny(p, d.needs)).map(([k]) => k);
}

/** Whether the principal may export this kind of data at all. */
export function canExport(p: Principal, type: ExportType): boolean {
  if (!hasAny(p, 'exports.create')) return false;
  if (type === 'vacancies') return hasAny(p, 'vacancies.view_all') || hasAny(p, 'vacancies.view_assigned');
  return hasAny(p, 'candidates.view');
}

/**
 * Spreadsheets run text starting with = + - @ (or a tab/CR) as a formula. Prefix such cells with an
 * apostrophe so imported data can never execute. Numbers are left alone.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join('; ') : String(value);
  if (typeof value !== 'number' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  // BOM so Excel reads UTF-8 names correctly.
  return '﻿' + [headers, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

type Filters = { status?: string; department_id?: string };

/** Builds the CSV text for a job. Throws if the requester may no longer export it. */
export async function buildExport(tx: Tx, p: Principal, type: ExportType, fields: string[], filters: Filters) {
  if (!canExport(p, type)) throw new Error('The requester no longer has permission to export this data.');
  const allowed = new Set(allowedFields(p, type));
  const cols = fields.filter((f) => allowed.has(f));
  if (cols.length === 0) throw new Error('None of the requested fields are available to the requester.');
  const defs = EXPORT_FIELDS[type];
  const date = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
  let records: Record<string, unknown>[];

  if (type === 'candidates') {
    let q = tx.selectFrom('candidates as c').selectAll('c').where('c.status', '=', 'active').where(candidateVisible(p, null));
    if (filters.department_id) {
      q = q.where((eb) => eb.exists(eb.selectFrom('applications as a').innerJoin('vacancies as v', 'v.id', 'a.vacancy_id').innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id').select('a.id').whereRef('a.candidate_id', '=', 'c.id').where('rq.department_id', '=', filters.department_id!)));
    }
    records = (await q.orderBy('c.created_at', 'desc').limit(MAX_EXPORT_ROWS + 1).execute()) as unknown as Record<string, unknown>[];
  } else if (type === 'applications') {
    let q = tx
      .selectFrom('applications as a')
      .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
      .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
      .innerJoin('departments as d', 'd.id', 'rq.department_id')
      .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
      .innerJoin('pipeline_stages as st', 'st.id', 'a.stage_id')
      .select(['c.full_name as candidate_name', 'c.email as candidate_email', 'v.vacancy_code', 'v.title as vacancy_title', 'd.name as department', 'st.name as stage', 'a.status', 'a.created_at as applied_at'])
      .where(vacancyVisible(p, null));
    if (filters.status) q = q.where('a.status', '=', filters.status as 'active');
    if (filters.department_id) q = q.where('rq.department_id', '=', filters.department_id);
    const rows = await q.orderBy('a.created_at', 'desc').limit(MAX_EXPORT_ROWS + 1).execute();
    records = rows.map((r) => ({ ...r, applied_on: date(r.applied_at) }));
  } else {
    let q = tx
      .selectFrom('vacancies as v')
      .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
      .innerJoin('departments as d', 'd.id', 'rq.department_id')
      .select(['v.vacancy_code', 'v.title', 'd.name as department', 'v.location', 'v.status', 'v.opened_at'])
      .where(vacancyVisible(p, null));
    if (filters.status) q = q.where('v.status', '=', filters.status as 'open');
    if (filters.department_id) q = q.where('rq.department_id', '=', filters.department_id);
    const rows = await q.orderBy('v.opened_at', 'desc').limit(MAX_EXPORT_ROWS + 1).execute();
    records = rows.map((r) => ({ ...r, opened_on: date(r.opened_at) }));
  }

  if (records.length > MAX_EXPORT_ROWS) throw new Error(`This export has more than ${MAX_EXPORT_ROWS} rows. Narrow the filters and try again.`);
  const csv = toCsv(cols.map((c) => defs[c]!.label), records.map((r) => cols.map((c) => r[c])));
  return { csv, rowCount: records.length };
}

/** Rebuilds a Principal for a user inside the worker (there is no session). Null if the user is gone. */
export async function principalForUser(tx: Tx, tenantId: string, userId: string): Promise<Principal | null> {
  const u = await tx.selectFrom('users').select(['id', 'email', 'full_name', 'status']).where('id', '=', userId).executeTakeFirst();
  if (!u || u.status !== 'active') return null;
  const { roles, permissions } = await loadRolesAndPermissions(tx, userId);
  const t = await tx.selectFrom('tenants').select(['name', 'slug']).where('id', '=', tenantId).executeTakeFirstOrThrow();
  return { userId, tenantId, tenantName: t.name, tenantSlug: t.slug, email: u.email, fullName: u.full_name, sessionId: 'worker', roles, permissions };
}

