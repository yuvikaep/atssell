import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import { agencyIdOf, canSeeRequisitionBudget, hasAny, requisitionVisible, vacancyVisible } from '../access.js';
import { principal } from '../app.js';
import { audit } from '../audit.js';
import type { VacancyStatus } from '../db-types.js';
import { pgConstraint, pgErrorCode, withTenant, type Tx } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { can, requirePermission, type Principal } from '../permissions.js';
import { idParams, pageQuery } from './common.js';

const STATUSES = ['open', 'on_hold', 'closed', 'cancelled'] as const;

// Allowed status moves. Reopening a closed vacancy is allowed; a cancelled one is final.
const TRANSITIONS: Record<VacancyStatus, VacancyStatus[]> = {
  open: ['on_hold', 'closed', 'cancelled'],
  on_hold: ['open', 'closed', 'cancelled'],
  closed: ['open'],
  cancelled: [],
};
const REASON_REQUIRED: VacancyStatus[] = ['on_hold', 'cancelled'];

const OpenBody = z.object({
  title: z.string().trim().min(2).max(200).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  headcount: z.number().int().min(1).max(1000).optional(),
  owner_user_id: z.uuid().nullable().optional(),
});

const UpdateBody = z
  .object({
    title: z.string().trim().min(2).max(200),
    location: z.string().trim().min(1).max(200),
    headcount: z.number().int().min(1).max(1000),
    owner_user_id: z.uuid().nullable(),
    status: z.enum(STATUSES),
    status_reason: z.string().trim().max(2000),
  })
  .partial()
  .refine((b) => Object.keys(b).length > 0, 'Provide at least one field to update.');

const ListQuery = pageQuery.extend({
  status: z.enum([...STATUSES, 'active', 'all']).default('active'),
  department_id: z.uuid().optional(),
  recruiter_id: z.uuid().optional(),
  agency_id: z.uuid().optional(),
  priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
  location: z.string().trim().max(200).optional(),
  q: z.string().trim().max(200).optional(),
});

const UserBody = z.object({ user_id: z.uuid() });
const AgencyBody = z.object({ agency_id: z.uuid() });

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function nextVacancyCode(tx: Tx, tenantId: string) {
  const { value } = await tx
    .insertInto('tenant_counters')
    .values({ tenant_id: tenantId, name: 'vacancy', value: 1 })
    .onConflict((oc) => oc.columns(['tenant_id', 'name']).doUpdateSet({ value: sql`tenant_counters.value + 1` }))
    .returning('value')
    .executeTakeFirstOrThrow();
  return `VAC-${String(value).padStart(4, '0')}`;
}

/** Headcount already given to the requisition's other non-cancelled vacancies. */
async function allocatedHeadcount(tx: Tx, requisitionId: string, excludeVacancyId?: string) {
  let q = tx
    .selectFrom('vacancies')
    .select(sql<number>`coalesce(sum(headcount), 0)::int`.as('n'))
    .where('requisition_id', '=', requisitionId)
    .where('status', '<>', 'cancelled');
  if (excludeVacancyId) q = q.where('id', '<>', excludeVacancyId);
  return (await q.executeTakeFirstOrThrow()).n;
}

export async function assertInternalActiveUser(tx: Tx, userId: string, what: string) {
  const u = await tx
    .selectFrom('users as u')
    .leftJoin('agency_members as am', 'am.user_id', 'u.id')
    .select(['u.status', 'am.id as agency_member_id'])
    .where('u.id', '=', userId)
    .executeTakeFirst();
  if (!u || u.status !== 'active') throw new AppError(422, 'INVALID_USER', `${what} was not found or is inactive.`);
  if (u.agency_member_id) throw new AppError(422, 'AGENCY_USER', `${what} must be a company user, not an agency member.`);
}

function baseQuery(tx: Tx, p: Principal, agencyId: string | null) {
  return tx
    .selectFrom('vacancies as v')
    .innerJoin('requisitions as rq', 'rq.id', 'v.requisition_id')
    .innerJoin('departments as d', 'd.id', 'rq.department_id')
    .leftJoin('users as owner', 'owner.id', 'v.owner_user_id')
    .where(vacancyVisible(p, agencyId));
}

async function loadVacancy(tx: Tx, p: Principal, id: string, lock = false) {
  const agencyId = await agencyIdOf(tx, p.userId);
  let q = baseQuery(tx, p, agencyId)
    .select(['v.id', 'v.status', 'v.headcount', 'v.requisition_id', 'rq.department_id', 'rq.status as requisition_status', 'rq.headcount as requisition_headcount'])
    .where('v.id', '=', id);
  if (lock) q = q.forUpdate('v');
  const v = await q.executeTakeFirst();
  if (!v) throw notFound('Vacancy');
  return v;
}

export async function vacancyDetail(tx: Tx, p: Principal, id: string) {
  const agencyId = await agencyIdOf(tx, p.userId);
  const v = await baseQuery(tx, p, agencyId)
    .leftJoin('users as hm', 'hm.id', 'rq.hiring_manager_id')
    .selectAll('v')
    .select([
      'rq.department_id', 'd.name as department_name', 'owner.full_name as owner_name',
      'rq.title as requisition_title', 'rq.description', 'rq.skills', 'rq.employment_type', 'rq.priority',
      'rq.target_date', 'rq.min_experience_years', 'rq.max_experience_years', 'rq.min_ctc', 'rq.max_ctc',
      'rq.requested_by', 'rq.hiring_manager_id', 'hm.full_name as hiring_manager_name',
    ])
    .where('v.id', '=', id)
    .executeTakeFirst();
  if (!v) throw notFound('Vacancy');

  const recruiters = await tx
    .selectFrom('vacancy_recruiters as vr')
    .innerJoin('users as u', 'u.id', 'vr.recruiter_user_id')
    .select(['u.id', 'u.full_name', 'u.email', 'vr.assigned_at'])
    .where('vr.vacancy_id', '=', id)
    .where('vr.unassigned_at', 'is', null)
    .orderBy('u.full_name')
    .execute();

  const interviewers = await tx
    .selectFrom('vacancy_interviewers as vi')
    .innerJoin('users as u', 'u.id', 'vi.user_id')
    .select(['u.id', 'u.full_name', 'u.email', 'vi.assigned_at'])
    .where('vi.vacancy_id', '=', id)
    .orderBy('u.full_name')
    .execute();

  // Agency users never see which other agencies work on a vacancy.
  const agencies = agencyId
    ? []
    : await tx
        .selectFrom('vacancy_agencies as va')
        .innerJoin('agencies as a', 'a.id', 'va.agency_id')
        .select(['a.id', 'a.name', 'va.assigned_at', 'va.ownership_policy'])
        .where('va.vacancy_id', '=', id)
        .where('va.status', '=', 'active')
        .orderBy('a.name')
        .execute();

  const stageCounts = await tx
    .selectFrom('applications as a')
    .innerJoin('pipeline_stages as s', 's.id', 'a.stage_id')
    .select(['s.id as stage_id', 's.code', 's.name', sql<number>`count(*)::int`.as('count')])
    .where('a.vacancy_id', '=', id)
    .groupBy(['s.id', 's.code', 's.name', 's.sort_order'])
    .orderBy('s.sort_order')
    .execute();

  const { min_ctc, max_ctc, requested_by, ...rest } = v;
  const budget = !agencyId && canSeeRequisitionBudget(p, v.department_id, requested_by);
  return {
    ...rest,
    ...(budget ? { min_ctc, max_ctc } : {}),
    age_days: Math.floor((Date.now() - v.opened_at.getTime()) / 86_400_000),
    recruiters,
    interviewers,
    agencies,
    stage_counts: stageCounts,
    can: {
      manage: can(p, 'vacancies.manage', v.department_id),
      add_candidates: hasAny(p, 'applications.manage') && v.status === 'open',
    },
  };
}

export async function vacancyRoutes(app: FastifyInstance) {
  const { db } = app;

  app.get('/vacancies', async (req) => {
    const p = principal(req);
    const f = ListQuery.parse(req.query);
    return withTenant(db, p.tenantId, async (tx) => {
      const agencyId = await agencyIdOf(tx, p.userId);
      let base = baseQuery(tx, p, agencyId);
      if (f.status === 'active') base = base.where('v.status', 'in', ['open', 'on_hold']);
      else if (f.status !== 'all') base = base.where('v.status', '=', f.status);
      if (f.department_id) base = base.where('rq.department_id', '=', f.department_id);
      if (f.priority) base = base.where('rq.priority', '=', f.priority);
      if (f.location) base = base.where('v.location', 'ilike', `%${escapeLike(f.location)}%`);
      if (f.q) {
        const like = `%${escapeLike(f.q)}%`;
        base = base.where((eb) => eb.or([eb('v.title', 'ilike', like), eb('v.vacancy_code', 'ilike', like)]));
      }
      if (f.recruiter_id) {
        base = base.where((eb) => eb.exists(
          eb.selectFrom('vacancy_recruiters as fr').select('fr.id').whereRef('fr.vacancy_id', '=', 'v.id')
            .where('fr.recruiter_user_id', '=', f.recruiter_id!).where('fr.unassigned_at', 'is', null),
        ));
      }
      if (f.agency_id && !agencyId) {
        base = base.where((eb) => eb.exists(
          eb.selectFrom('vacancy_agencies as fa').select('fa.id').whereRef('fa.vacancy_id', '=', 'v.id')
            .where('fa.agency_id', '=', f.agency_id!).where('fa.status', '=', 'active'),
        ));
      }

      const { total } = await base.select(sql<number>`count(*)::int`.as('total')).executeTakeFirstOrThrow();
      const rows = await base
        .select((eb) => [
          'v.id', 'v.vacancy_code', 'v.title', 'v.location', 'v.headcount', 'v.status', 'v.opened_at',
          'rq.department_id', 'd.name as department_name', 'rq.priority', 'rq.target_date',
          'owner.full_name as owner_name',
          eb.selectFrom('vacancy_recruiters as vr').innerJoin('users as ru', 'ru.id', 'vr.recruiter_user_id')
            .select(sql<string[]>`coalesce(array_agg(ru.full_name order by ru.full_name), '{}')`.as('n'))
            .whereRef('vr.vacancy_id', '=', 'v.id').where('vr.unassigned_at', 'is', null)
            .as('recruiters'),
          (agencyId
            ? sql<string[]>`'{}'::text[]`
            : eb.selectFrom('vacancy_agencies as va').innerJoin('agencies as ag', 'ag.id', 'va.agency_id')
                .select(sql<string[]>`coalesce(array_agg(ag.name order by ag.name), '{}')`.as('n'))
                .whereRef('va.vacancy_id', '=', 'v.id').where('va.status', '=', 'active')
          ).as('agencies'),
          eb.selectFrom('applications as ap').select(sql<number>`count(*)::int`.as('n'))
            .whereRef('ap.vacancy_id', '=', 'v.id').where('ap.status', '=', 'active')
            .as('active_candidates'),
          eb.selectFrom('employment_records as er').select(sql<number>`count(*)::int`.as('n'))
            .whereRef('er.vacancy_id', '=', 'v.id')
            .as('joined'),
        ])
        .orderBy('v.opened_at', 'desc')
        .limit(f.page_size)
        .offset((f.page - 1) * f.page_size)
        .execute();
      const now = Date.now();
      return {
        data: rows.map((r) => ({ ...r, age_days: Math.floor((now - r.opened_at.getTime()) / 86_400_000) })),
        page: f.page,
        page_size: f.page_size,
        total,
      };
    });
  });

  app.get('/vacancies/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    return { data: await withTenant(db, p.tenantId, (tx) => vacancyDetail(tx, p, id)) };
  });

  // Opens a vacancy from an approved requisition. Title and location default to the requisition's.
  app.post('/requisitions/:id/vacancies', async (req, reply) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = OpenBody.parse(req.body);

    const detail = await withTenant(db, p.tenantId, async (tx) => {
      // Lock the requisition so concurrent openings cannot exceed its headcount.
      const rq = await tx
        .selectFrom('requisitions as rq')
        .selectAll('rq')
        .where('rq.id', '=', id)
        .where(requisitionVisible(p))
        .forUpdate()
        .executeTakeFirst();
      if (!rq) throw notFound('Requisition');
      requirePermission(p, 'vacancies.manage', rq.department_id);
      if (rq.status !== 'approved') throw new AppError(409, 'NOT_APPROVED', 'Vacancies can only be opened from an approved requisition.');

      const allocated = await allocatedHeadcount(tx, id);
      const headcount = body.headcount ?? rq.headcount - allocated;
      if (headcount < 1 || allocated + headcount > rq.headcount) {
        throw new AppError(422, 'HEADCOUNT_EXCEEDED', `Only ${rq.headcount - allocated} of ${rq.headcount} positions are left to open.`);
      }
      if (body.owner_user_id) await assertInternalActiveUser(tx, body.owner_user_id, 'Owner');

      const vacancy = await tx
        .insertInto('vacancies')
        .values({
          tenant_id: p.tenantId,
          requisition_id: id,
          vacancy_code: await nextVacancyCode(tx, p.tenantId),
          title: body.title ?? rq.title,
          location: body.location ?? rq.location,
          headcount,
          owner_user_id: body.owner_user_id ?? p.userId,
        })
        .returning(['id', 'vacancy_code'])
        .executeTakeFirstOrThrow();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.opened', entityType: 'vacancy', entityId: vacancy.id,
        metadata: { requisition_id: id, vacancy_code: vacancy.vacancy_code, headcount },
      });
      return vacancyDetail(tx, p, vacancy.id);
    });
    return reply.status(201).send({ data: detail });
  });

  app.patch('/vacancies/:id', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const body = UpdateBody.parse(req.body);

    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancy(tx, p, id, true);
      requirePermission(p, 'vacancies.manage', v.department_id);
      const changes: Record<string, unknown> = { ...body };

      if (body.status && body.status !== v.status) {
        if (!TRANSITIONS[v.status].includes(body.status)) {
          throw new AppError(409, 'INVALID_TRANSITION', `A ${v.status.replace('_', ' ')} vacancy cannot be moved to ${body.status.replace('_', ' ')}.`);
        }
        if (REASON_REQUIRED.includes(body.status) && !body.status_reason) {
          throw new AppError(400, 'VALIDATION_ERROR', 'Some fields are invalid.', [{ path: 'status_reason', message: 'Give a reason.' }]);
        }
        if (body.status === 'open' && v.requisition_status !== 'approved') {
          throw new AppError(409, 'NOT_APPROVED', 'The requisition is no longer approved.');
        }
        if (body.status === 'closed' || body.status === 'cancelled') changes.closed_at = sql`now()`;
        if (body.status === 'open') changes.closed_at = null;
      }
      if (body.headcount !== undefined && body.headcount !== v.headcount) {
        // Lock the requisition so concurrent headcount edits cannot exceed it together.
        await tx.selectFrom('requisitions').select('id').where('id', '=', v.requisition_id).forUpdate().execute();
        const others = await allocatedHeadcount(tx, v.requisition_id, id);
        if (others + body.headcount > v.requisition_headcount) {
          throw new AppError(422, 'HEADCOUNT_EXCEEDED', `Only ${v.requisition_headcount - others} positions are available for this vacancy.`);
        }
      }
      if (body.owner_user_id) await assertInternalActiveUser(tx, body.owner_user_id, 'Owner');

      await tx.updateTable('vacancies').set(changes).where('id', '=', id).execute();
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId,
        action: body.status && body.status !== v.status ? `vacancy.${body.status}` : 'vacancy.updated',
        entityType: 'vacancy', entityId: id,
        metadata: { changes: body, previous_status: v.status },
      });
      return vacancyDetail(tx, p, id);
    });
    return { data: detail };
  });

  app.post('/vacancies/:id/assign-recruiter', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { user_id } = UserBody.parse(req.body);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancy(tx, p, id, true);
      requirePermission(p, 'vacancies.manage', v.department_id);
      await assertInternalActiveUser(tx, user_id, 'Recruiter');
      await tx
        .insertInto('vacancy_recruiters')
        .values({ tenant_id: p.tenantId, vacancy_id: id, recruiter_user_id: user_id, assigned_by: p.userId })
        .execute()
        .catch((err: unknown) => {
          if (pgErrorCode(err) === '23505' && pgConstraint(err) === 'uq_vacancy_recruiters_current') {
            throw new AppError(409, 'ALREADY_ASSIGNED', 'This recruiter is already assigned.');
          }
          throw err;
        });
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.recruiter_assigned', entityType: 'vacancy', entityId: id,
        metadata: { user_id },
      });
      return vacancyDetail(tx, p, id);
    });
    return { data: detail };
  });

  // Interviewers this job uses (company people, not agency members).
  app.post('/vacancies/:id/assign-interviewer', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { user_id } = UserBody.parse(req.body);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancy(tx, p, id, true);
      requirePermission(p, 'vacancies.manage', v.department_id);
      await assertInternalActiveUser(tx, user_id, 'Interviewer');
      await tx.insertInto('vacancy_interviewers').values({ tenant_id: p.tenantId, vacancy_id: id, user_id, assigned_by: p.userId }).execute()
        .catch((err: unknown) => { throw pgErrorCode(err) === '23505' ? new AppError(409, 'ALREADY_ASSIGNED', 'This interviewer is already assigned.') : err; });
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.interviewer_assigned', entityType: 'vacancy', entityId: id, metadata: { user_id } });
      return vacancyDetail(tx, p, id);
    });
    return { data: detail };
  });

  app.post('/vacancies/:id/unassign-interviewer', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { user_id } = UserBody.parse(req.body);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancy(tx, p, id, true);
      requirePermission(p, 'vacancies.manage', v.department_id);
      await tx.deleteFrom('vacancy_interviewers').where('vacancy_id', '=', id).where('user_id', '=', user_id).execute();
      await audit(tx, req, { tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.interviewer_unassigned', entityType: 'vacancy', entityId: id, metadata: { user_id } });
      return vacancyDetail(tx, p, id);
    });
    return { data: detail };
  });

  app.post('/vacancies/:id/unassign-recruiter', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { user_id } = UserBody.parse(req.body);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancy(tx, p, id, true);
      requirePermission(p, 'vacancies.manage', v.department_id);
      const done = await tx
        .updateTable('vacancy_recruiters')
        .set({ unassigned_at: sql`now()` })
        .where('vacancy_id', '=', id)
        .where('recruiter_user_id', '=', user_id)
        .where('unassigned_at', 'is', null)
        .returning('id')
        .executeTakeFirst();
      if (!done) throw notFound('Recruiter assignment');
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.recruiter_unassigned', entityType: 'vacancy', entityId: id,
        metadata: { user_id },
      });
      return vacancyDetail(tx, p, id);
    });
    return { data: detail };
  });

  app.post('/vacancies/:id/assign-agency', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { agency_id } = AgencyBody.parse(req.body);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancy(tx, p, id, true);
      requirePermission(p, 'vacancies.manage', v.department_id);
      const agency = await tx.selectFrom('agencies').select('status').where('id', '=', agency_id).executeTakeFirst();
      if (!agency || agency.status !== 'active') throw new AppError(422, 'INVALID_AGENCY', 'Agency was not found or is inactive.');
      const existing = await tx.selectFrom('vacancy_agencies').select(['id', 'status']).where('vacancy_id', '=', id).where('agency_id', '=', agency_id).executeTakeFirst();
      if (existing?.status === 'active') throw new AppError(409, 'ALREADY_ASSIGNED', 'This agency is already assigned.');
      if (existing) {
        await tx.updateTable('vacancy_agencies').set({ status: 'active', assigned_by: p.userId, assigned_at: sql`now()` }).where('id', '=', existing.id).execute();
      } else {
        await tx.insertInto('vacancy_agencies').values({ tenant_id: p.tenantId, vacancy_id: id, agency_id, assigned_by: p.userId }).execute();
      }
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.agency_assigned', entityType: 'vacancy', entityId: id,
        metadata: { agency_id },
      });
      return vacancyDetail(tx, p, id);
    });
    return { data: detail };
  });

  app.post('/vacancies/:id/unassign-agency', async (req) => {
    const p = principal(req);
    const { id } = idParams.parse(req.params);
    const { agency_id } = AgencyBody.parse(req.body);
    const detail = await withTenant(db, p.tenantId, async (tx) => {
      const v = await loadVacancy(tx, p, id, true);
      requirePermission(p, 'vacancies.manage', v.department_id);
      const done = await tx
        .updateTable('vacancy_agencies')
        .set({ status: 'inactive' })
        .where('vacancy_id', '=', id)
        .where('agency_id', '=', agency_id)
        .where('status', '=', 'active')
        .returning('id')
        .executeTakeFirst();
      if (!done) throw notFound('Agency assignment');
      await audit(tx, req, {
        tenantId: p.tenantId, actorUserId: p.userId, action: 'vacancy.agency_unassigned', entityType: 'vacancy', entityId: id,
        metadata: { agency_id },
      });
      return vacancyDetail(tx, p, id);
    });
    return { data: detail };
  });
}
