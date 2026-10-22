// Salary and joining date for selected candidates. The job decides who settles it (its recruiters,
// the interviewer who selected the candidate, or the admin). That person proposes; the company admin
// approves or enters it directly. Once approved only the admin can change it.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { interviewedApplication } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import { withTenant, type Tx } from '../db.js';
import { AppError, forbidden } from '../errors.js';
import { can, type Principal } from '../permissions.js';
import { idParams } from './common.js';

const TermsBody = z.object({
  annual_ctc: z.number().positive('Enter the annual CTC.').max(1_000_000_000),
  joining_date: z.iso.date('Enter the joining date.'),
});

const isAdmin = (p: Principal) => can(p, 'employment.manage');

/** Whether this person settles salary and joining for the application under the job's rule. */
async function settles(tx: Tx, p: Principal, a: { id: string; vacancy_id: string; terms_owner: string }) {
  if (isAdmin(p)) return true;
  if (a.terms_owner === 'recruiter') {
    return !!(await tx.selectFrom('vacancy_recruiters').select('id').where('vacancy_id', '=', a.vacancy_id).where('recruiter_user_id', '=', p.userId).where('unassigned_at', 'is', null).executeTakeFirst());
  }
  if (a.terms_owner === 'interviewer') return interviewedApplication(tx, p.userId, a.id);
  return false;
}

/** Selected candidates still to join, with any terms. */
function selectedBase(tx: Tx) {
  return tx.selectFrom('applications as a')
    .innerJoin('vacancies as v', 'v.id', 'a.vacancy_id')
    .innerJoin('candidates as c', 'c.id', 'a.candidate_id')
    .leftJoin('joining_terms as jt', 'jt.application_id', 'a.id')
    .leftJoin('users as pu', 'pu.id', 'jt.proposed_by')
    .leftJoin('users as au', 'au.id', 'jt.approved_by')
    .select(['a.id', 'a.vacancy_id', 'a.sourcing_code', 'a.temp_employee_code', 'v.title as job_title', 'v.terms_owner', 'c.id as candidate_id', 'c.full_name as candidate_name', 'c.current_title',
      'jt.annual_ctc', 'jt.joining_date', 'jt.status as terms_status', 'pu.full_name as proposed_by_name', 'jt.proposed_at', 'au.full_name as approved_by_name', 'jt.approved_at'])
    .where('a.temp_employee_code', 'is not', null)
    .where('a.status', '=', 'active')
    .where((eb) => eb.not(eb.exists(eb.selectFrom('employment_records as e').select('e.id').whereRef('e.application_id', '=', 'a.id'))));
}

async function loadSelected(tx: Tx, id: string) {
  const a = await selectedBase(tx).where('a.id', '=', id).forUpdate('a').executeTakeFirst();
  if (!a) throw new AppError(409, 'NOT_SELECTED', 'Salary and joining are set only for a selected candidate who has not joined.');
  return a;
}

export async function joiningRoutes(app: FastifyInstance) {
  const { db } = app;

  // My list: selected candidates whose salary and joining I settle (the admin sees all).
  app.get('/joining-terms', async (req) => {
    const p = principal(req);
    const rows = await withTenant(db, p.tenantId, async (tx) => {
      const all = await selectedBase(tx).orderBy('a.temp_employee_code').limit(500).execute();
      const mine = [];
      for (const r of all) if (await settles(tx, p, r)) mine.push({ ...r, can_edit: isAdmin(p) || r.terms_status !== 'approved', can_approve: isAdmin(p) && r.terms_status === 'proposed' });
      return mine;
    });
    return { data: rows, is_admin: isAdmin(p) };
  });

  const write = async (req: FastifyRequest, approveOnly: boolean) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    return withTenant(db, p.tenantId, async (tx) => {
      const a = await loadSelected(tx, id);
      if (approveOnly) {
        if (!isAdmin(p)) throw forbidden();
        if (a.terms_status !== 'proposed') throw new AppError(409, 'NOTHING_TO_APPROVE', 'There is no proposal to approve.');
        await tx.updateTable('joining_terms').set({ status: 'approved', approved_by: p.userId, approved_at: sql`now()` }).where('application_id', '=', id).execute();
        await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'joining_terms.approved', entityType: 'application', entityId: id });
        return { status: 'approved' };
      }
      const body = TermsBody.parse(req.body);
      if (!(await settles(tx, p, a))) throw forbidden();
      if (a.terms_status === 'approved' && !isAdmin(p)) throw new AppError(409, 'TERMS_APPROVED', 'Salary and joining are approved. Only the admin can change them.');
      // The admin's own entry is final straight away.
      const approved = isAdmin(p);
      const values = { annual_ctc: body.annual_ctc, joining_date: body.joining_date, status: approved ? 'approved' as const : 'proposed' as const, proposed_by: p.userId, proposed_at: sql<Date>`now()`, approved_by: approved ? p.userId : null, approved_at: approved ? sql<Date>`now()` : null };
      await tx.insertInto('joining_terms').values({ tenant_id: p.tenantId, application_id: id, ...values })
        .onConflict((oc) => oc.column('application_id').doUpdateSet(values)).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: approved ? 'joining_terms.set' : 'joining_terms.proposed', entityType: 'application', entityId: id, metadata: body });
      return { status: values.status };
    });
  };
  app.post('/applications/:id/joining-terms', async (req, reply) => reply.status(201).send({ data: await write(req, false) }));
  app.post('/applications/:id/joining-terms/approve', async (req) => ({ data: await write(req, true) }));
}
