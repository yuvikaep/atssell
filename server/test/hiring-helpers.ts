import { addDepartment, addUser, call, createCompany, login, nextIp, sessionCookie, WEB_ORIGIN, type TestContext } from './helpers.js';

export const FUTURE = '2099-01-01';

export function requisitionPayload(departmentId: string, overrides: Record<string, unknown> = {}) {
  return {
    department_id: departmentId,
    title: 'Backend Engineer',
    description: 'Build and run the services behind our hiring platform.',
    headcount: 2,
    employment_type: 'full_time',
    location: 'Pune',
    skills: ['Node.js', 'PostgreSQL'],
    min_experience_years: 3,
    max_experience_years: 8,
    min_ctc: 1_800_000,
    max_ctc: 3_000_000,
    priority: 'high',
    target_date: FUTURE,
    ...overrides,
  };
}

/** A company with people in the roles the hiring flows need. All share one password. */
export async function setupCompany(ctx: TestContext, prefix = 'hire') {
  const co = await createCompany(ctx, prefix);
  const t = co.tenant.id;
  const eng = await addDepartment(ctx, t, 'Engineering');
  const sales = await addDepartment(ctx, t, 'Sales');
  const users = {
    hr1: await addUser(ctx, t, { email: `hr1@${co.slug}.test`, role: 'hr_head' }),
    hr2: await addUser(ctx, t, { email: `hr2@${co.slug}.test`, role: 'hr_head' }),
    recruiter: await addUser(ctx, t, { email: `rec@${co.slug}.test`, role: 'internal_recruiter' }),
    engManager: await addUser(ctx, t, { email: `engmgr@${co.slug}.test`, role: 'hiring_manager', departmentId: eng.id }),
    salesManager: await addUser(ctx, t, { email: `salesmgr@${co.slug}.test`, role: 'hiring_manager', departmentId: sales.id }),
  };
  // Hiring managers only take part in interviews and feedback. The requisition and report tests need a
  // department-level requester, so give these two a company-defined role for that (not a system role).
  const lead = await ctx.adminDb.insertInto('roles').values({ tenant_id: t, code: 'dept_requester', name: 'Department requester' }).returning('id').executeTakeFirstOrThrow();
  await ctx.adminDb.insertInto('role_permissions').values([{ role_id: lead.id, permission_code: 'requisitions.create' }, { role_id: lead.id, permission_code: 'analytics.view' }]).execute();
  await ctx.adminDb.insertInto('user_role_assignments').values([
    { tenant_id: t, user_id: users.engManager.id, role_id: lead.id, department_id: eng.id },
    { tenant_id: t, user_id: users.salesManager.id, role_id: lead.id, department_id: sales.id },
  ]).execute();
  const email = (name: keyof typeof users | 'admin') => (name === 'admin' ? co.admin.email : `${{
    hr1: 'hr1', hr2: 'hr2', recruiter: 'rec', engManager: 'engmgr', salesManager: 'salesmgr',
  }[name]}@${co.slug}.test`);
  const as = (name: keyof typeof users | 'admin') => login(ctx, co.slug, email(name));
  return { co, eng, sales, users, as, email };
}

type Setup = Awaited<ReturnType<typeof setupCompany>>;

/** Creates a requisition as `requester`, gets it approved by hr1, and returns its id. */
export async function approvedRequisition(
  ctx: TestContext,
  s: Setup,
  opts: { requesterCookie?: string; departmentId?: string; headcount?: number } = {},
) {
  const requester = opts.requesterCookie ?? (await s.as('admin'));
  const created = await call(ctx, requester, 'POST', '/requisitions', requisitionPayload(opts.departmentId ?? s.eng.id, { headcount: opts.headcount ?? 2 }));
  if (created.statusCode !== 201) throw new Error(`create requisition failed: ${created.body}`);
  const id = created.json().data.id as string;
  const submitted = await call(ctx, requester, 'POST', `/requisitions/${id}/submit-approval`, { approver_user_ids: [s.users.hr1.id] });
  if (submitted.statusCode !== 200) throw new Error(`submit failed: ${submitted.body}`);
  const approved = await call(ctx, await s.as('hr1'), 'POST', `/requisitions/${id}/approve`, { decision: 'approved' });
  if (approved.statusCode !== 200) throw new Error(`approve failed: ${approved.body}`);
  return id;
}

export async function openVacancy(ctx: TestContext, cookie: string, requisitionId: string, body: Record<string, unknown> = {}) {
  const res = await call(ctx, cookie, 'POST', `/requisitions/${requisitionId}/vacancies`, body);
  if (res.statusCode !== 201) throw new Error(`open vacancy failed: ${res.statusCode} ${res.body}`);
  return res.json().data as { id: string; vacancy_code: string };
}

export function multipartBody(filename: string, content: Buffer, fields: Record<string, string> = {}) {
  const boundary = `----jmtest${Math.random().toString(16).slice(2)}`;
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    content,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

export function uploadDocument(ctx: TestContext, cookie: string, candidateId: string, filename: string, content: Buffer, fields: Record<string, string> = {}) {
  const { payload, headers } = multipartBody(filename, content, fields);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/candidates/${candidateId}/documents`,
    headers: { cookie, origin: WEB_ORIGIN, ...headers },
    payload,
  });
}

export const PDF = (extra = '') => Buffer.from(`%PDF-1.4\n% test resume ${extra}\n%%EOF`);

// ---- Sprint 3: agencies ----

export async function createAgency(ctx: TestContext, adminCookie: string, name: string) {
  const res = await call(ctx, adminCookie, 'POST', '/agencies', { name, primary_contact_email: `ops@${name.toLowerCase().replace(/\W+/g, '')}.test` });
  if (res.statusCode !== 201) throw new Error(`create agency failed: ${res.body}`);
  return res.json().data.id as string;
}

/** Invites an agency member through the real flow and accepts it; returns the new user's session. */
export async function addAgencyMember(
  ctx: TestContext,
  adminCookie: string,
  agencyId: string,
  email: string,
  agencyRole: 'admin' | 'recruiter' = 'recruiter',
) {
  const invite = await call(ctx, adminCookie, 'POST', `/agencies/${agencyId}/invitations`, { email, agency_role: agencyRole });
  if (invite.statusCode !== 201) throw new Error(`invite failed: ${invite.body}`);
  const token = ctx.mailer.invitations.at(-1)!.link.split('#')[1]!;
  const accept = await ctx.app.inject({
    method: 'POST', url: '/api/v1/invitations/accept', remoteAddress: nextIp(),
    payload: { token, full_name: email.split('@')[0], password: 'agency-member-password' },
  });
  if (accept.statusCode !== 201) throw new Error(`accept failed: ${accept.body}`);
  const me = await call(ctx, sessionCookie(accept), 'GET', '/me');
  return { cookie: sessionCookie(accept), userId: me.json().data.user.id as string };
}

export const agencyProfile = (n: string, extra: Record<string, unknown> = {}) => ({
  full_name: `Agency Candidate ${n}`,
  email: `ac.${n.toLowerCase().replace(/\s/g, '.')}@mail.test`,
  phone: null,
  skills: ['Java'],
  source_declaration: 'agency_database',
  consent_confirmed: true,
  ...extra,
});

export function submitAs(
  ctx: TestContext,
  cookie: string,
  vacancyId: string,
  payload: Record<string, unknown>,
  file: { name: string; content: Buffer } | null = { name: 'cv.pdf', content: PDF('agency') },
) {
  const { payload: body, headers } = multipartBody(file?.name ?? 'none.pdf', file?.content ?? Buffer.alloc(0), { payload: JSON.stringify(payload) });
  // Without a file part the request must still be valid multipart; send only the payload field.
  const noFile = file === null;
  const boundary = headers['content-type'].split('boundary=')[1]!;
  const onlyFields = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="payload"\r\n\r\n${JSON.stringify(payload)}\r\n--${boundary}--\r\n`);
  return ctx.app.inject({
    method: 'POST',
    url: `/api/v1/agency/vacancies/${vacancyId}/submissions`,
    headers: { cookie, origin: WEB_ORIGIN, ...headers },
    payload: noFile ? onlyFields : body,
  });
}

/** An open vacancy with the given agencies assigned. */
export async function vacancyWithAgencies(ctx: TestContext, s: Awaited<ReturnType<typeof setupCompany>>, agencyIds: string[], opts: { title?: string; headcount?: number } = {}) {
  const admin = await s.as('admin');
  const rq = await approvedRequisition(ctx, s, { headcount: opts.headcount ?? 2 });
  const v = await openVacancy(ctx, admin, rq, opts.title ? { title: opts.title } : {});
  for (const agency_id of agencyIds) {
    const res = await call(ctx, admin, 'POST', `/vacancies/${v.id}/assign-agency`, { agency_id });
    if (res.statusCode !== 200) throw new Error(`assign agency failed: ${res.body}`);
  }
  return v;
}

// ---- Sprint 4: interviews ----

export const inHours = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();

/** A vacancy with one candidate applied, ready for interviews. Returns ids. */
export async function applicationOnVacancy(ctx: TestContext, s: Awaited<ReturnType<typeof setupCompany>>, label: string) {
  const admin = await s.as('admin');
  const rq = await approvedRequisition(ctx, s);
  const vacancy = await openVacancy(ctx, admin, rq);
  const cand = await call(ctx, admin, 'POST', '/candidates', {
    full_name: `Interviewee ${label}`, email: `interviewee.${label}@mail.test`, phone: '9811100000'.slice(0, 7) + String(label.length).padStart(3, '0'),
    current_title: 'Analyst', total_experience_years: 5, current_ctc: 1_500_000, expected_ctc: 2_000_000, skills: ['Excel'], city: 'Pune',
  });
  if (cand.statusCode !== 201) throw new Error(`candidate failed: ${cand.body}`);
  const app = await call(ctx, admin, 'POST', '/applications', { candidate_id: cand.json().data.id, vacancy_id: vacancy.id });
  if (app.statusCode !== 201) throw new Error(`application failed: ${app.body}`);
  return { vacancyId: vacancy.id, candidateId: cand.json().data.id as string, applicationId: app.json().data.id as string };
}

export async function scheduleInterview(ctx: TestContext, cookie: string, applicationId: string, overrides: Record<string, unknown> = {}) {
  const res = await call(ctx, cookie, 'POST', `/applications/${applicationId}/interviews`, {
    round_name: 'Technical round', mode: 'google_meet', scheduled_start: inHours(24), scheduled_end: inHours(25), timezone: 'Asia/Kolkata',
    panel: [], ...overrides,
  });
  if (res.statusCode !== 201) throw new Error(`schedule failed: ${res.statusCode} ${res.body}`);
  return res.json().data as {
    id: string; status: string; panel: { id: string; user_id: string | null; email: string | null; name: string }[];
    template: { competencies: { code: string; required: boolean }[] };
  };
}

export const goodFeedback = (extra: Record<string, unknown> = {}) => ({
  mode: 'google_meet', overall_rating: 4, recommendation: 'yes',
  competency_ratings: { role_skills: 4, communication: 4, problem_solving: 3 }, notes: 'Solid.', ...extra,
});

/** Issues a link and returns the raw token (only available at issue time, as in real life). */
export async function issueLink(ctx: TestContext, cookie: string, interviewId: string, interviewerId: string, body: Record<string, unknown> = {}) {
  const res = await call(ctx, cookie, 'POST', `/interviews/${interviewId}/feedback-links`, { interviewer_id: interviewerId, ...body });
  if (res.statusCode !== 201) throw new Error(`issue link failed: ${res.statusCode} ${res.body}`);
  const url = res.json().data.url as string;
  return { id: res.json().data.id as string, token: url.split('#')[1]!, url, emailed: res.json().data.emailed as boolean };
}

export function publicPost(ctx: TestContext, path: string, payload: object, remoteAddress?: string) {
  return ctx.app.inject({ method: 'POST', url: `/api/v1/public/feedback/${path}`, remoteAddress: remoteAddress ?? nextIp(), payload });
}
