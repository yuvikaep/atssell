import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, login, nextIp, sessionCookie, setupApp, type TestContext } from './helpers.js';
import { addAgencyMember, createAgency, setupCompany, vacancyWithAgencies } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let engManager: string;
let agency: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'am');
  [admin, engManager] = await Promise.all([s.as('admin'), s.as('engManager')]);
  agency = await createAgency(ctx, admin, 'Members Staffing');
});
afterAll(() => ctx.close());

const invite = (cookie: string, email: string, agency_role: 'admin' | 'recruiter' = 'recruiter', id = agency) =>
  call(ctx, cookie, 'POST', `/agencies/${id}/invitations`, { email, agency_role });

describe('inviting agency members', () => {
  it('invites with an agency, and accepting creates the user, the membership and the agency role', async () => {
    const res = await invite(admin, 'first.admin@agency.test', 'admin');
    expect(res.statusCode).toBe(201);
    const mail = ctx.mailer.invitations.at(-1)!;
    expect(mail).toMatchObject({ to: 'first.admin@agency.test', roleName: 'Agency' });

    const token = mail.link.split('#')[1]!;
    const accept = await ctx.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', remoteAddress: nextIp(), payload: { token, full_name: 'First Admin', password: 'agency-member-password' } });
    expect(accept.statusCode).toBe(201);

    const me = (await call(ctx, sessionCookie(accept), 'GET', '/me')).json().data;
    expect(me.roles.map((r: { code: string }) => r.code)).toEqual(['agency_admin']);
    expect(Object.keys(me.permissions).sort()).toEqual(['agency_portal.use', 'performance.view_own', 'submissions.create']);

    const member = await ctx.adminDb.selectFrom('agency_members').select(['agency_id', 'agency_role']).where('user_id', '=', me.user.id).executeTakeFirstOrThrow();
    expect(member).toMatchObject({ agency_id: agency, agency_role: 'admin' });
  });

  it('lists members and pending invitations for the agency', async () => {
    await invite(admin, 'pending.person@agency.test', 'recruiter');
    const res = await call(ctx, admin, 'GET', `/agencies/${agency}/members`);
    const data = res.json().data;
    expect(data.members.map((m: { email: string }) => m.email)).toContain('first.admin@agency.test');
    expect(data.invitations.map((i: { email: string; agency_role: string }) => [i.email, i.agency_role])).toContainEqual(['pending.person@agency.test', 'recruiter']);
  });

  it('refuses existing users, double invitations and inactive agencies', async () => {
    expect((await invite(admin, s.co.admin.email)).json().error.code).toBe('USER_EXISTS');
    expect((await invite(admin, 'Pending.Person@agency.test')).json().error.code).toBe('INVITATION_PENDING');
    const dormant = await createAgency(ctx, admin, 'Dormant Agency');
    await call(ctx, admin, 'PATCH', `/agencies/${dormant}`, { status: 'inactive' });
    expect((await invite(admin, 'someone@dormant.test', 'recruiter', dormant)).json().error.code).toBe('AGENCY_INACTIVE');
  });

  it('only people who manage agencies can invite or list members', async () => {
    expect((await invite(engManager, 'nope@agency.test')).statusCode).toBe(403);
    expect((await call(ctx, engManager, 'GET', `/agencies/${agency}/members`)).statusCode).toBe(403);
  });

  it('resending keeps the agency, so the new link still joins that agency', async () => {
    await invite(admin, 'resend.me@agency.test', 'recruiter');
    const pending = (await call(ctx, admin, 'GET', '/users/invitations')).json().data.find((i: { email: string }) => i.email === 'resend.me@agency.test');
    expect(pending.agency_name).toBe('Members Staffing');
    expect((await call(ctx, admin, 'POST', `/users/invitations/${pending.id}/resend`)).statusCode).toBe(201);
    const token = ctx.mailer.invitations.at(-1)!.link.split('#')[1]!;
    const accept = await ctx.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', remoteAddress: nextIp(), payload: { token, full_name: 'Resent Person', password: 'agency-member-password' } });
    expect(accept.statusCode).toBe(201);
    const me = (await call(ctx, sessionCookie(accept), 'GET', '/me')).json().data;
    const member = await ctx.adminDb.selectFrom('agency_members').select('agency_id').where('user_id', '=', me.user.id).executeTakeFirst();
    expect(member?.agency_id).toBe(agency);
  });

  it('an invitation to an agency deactivated before acceptance is refused', async () => {
    const other = await createAgency(ctx, admin, 'Closing Agency');
    await invite(admin, 'late@closing.test', 'recruiter', other);
    const token = ctx.mailer.invitations.at(-1)!.link.split('#')[1]!;
    await call(ctx, admin, 'PATCH', `/agencies/${other}`, { status: 'inactive' });
    const accept = await ctx.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', remoteAddress: nextIp(), payload: { token, full_name: 'Late Joiner', password: 'agency-member-password' } });
    expect(accept.statusCode).toBe(410);
    expect(await ctx.adminDb.selectFrom('users').select('id').where('email', '=', 'late@closing.test').executeTakeFirst()).toBeUndefined();
  });
});

describe('managing agency members', () => {
  it('changing a member between admin and recruiter changes what they can see', async () => {
    const agencyId = await createAgency(ctx, admin, 'Scope Staffing');
    const boss = await addAgencyMember(ctx, admin, agencyId, 'boss@scope.test', 'admin');
    const rec = await addAgencyMember(ctx, admin, agencyId, 'rec@scope.test', 'recruiter');
    const v = await vacancyWithAgencies(ctx, s, [agencyId]);
    const { submitAs, agencyProfile } = await import('./hiring-helpers.js');
    await submitAs(ctx, boss.cookie, v.id, agencyProfile('boss one'));
    await submitAs(ctx, rec.cookie, v.id, agencyProfile('rec one'));

    const count = async (cookie: string) => (await call(ctx, cookie, 'GET', '/agency/submissions')).json().total;
    expect(await count(rec.cookie)).toBe(1);
    expect(await count(boss.cookie)).toBe(2);

    const promote = await call(ctx, admin, 'PATCH', `/agencies/${agencyId}/members/${rec.userId}`, { agency_role: 'admin' });
    expect(promote.statusCode).toBe(200);
    expect(await count(rec.cookie)).toBe(2);
    const role = (await call(ctx, rec.cookie, 'GET', '/me')).json().data.roles.map((r: { code: string }) => r.code);
    expect(role).toEqual(['agency_admin']);
  });

  it('deactivating a member signs them out at once and blocks sign-in', async () => {
    const agencyId = await createAgency(ctx, admin, 'Leaver Staffing');
    const m = await addAgencyMember(ctx, admin, agencyId, 'leaver@leaver.test');
    expect((await call(ctx, m.cookie, 'GET', '/agency/home')).statusCode).toBe(200);
    expect((await call(ctx, admin, 'PATCH', `/agencies/${agencyId}/members/${m.userId}`, { status: 'inactive' })).statusCode).toBe(200);
    expect((await call(ctx, m.cookie, 'GET', '/agency/home')).statusCode).toBe(401);
    const attempt = await ctx.app.inject({ method: 'POST', url: '/api/v1/auth/login', remoteAddress: nextIp(), payload: { company: s.co.slug, email: 'leaver@leaver.test', password: 'agency-member-password' } });
    expect(attempt.statusCode).toBe(403);
  });

  it('deactivating the agency itself locks its members out of the portal', async () => {
    const agencyId = await createAgency(ctx, admin, 'Suspended Staffing');
    const m = await addAgencyMember(ctx, admin, agencyId, 'member@suspended.test');
    await call(ctx, admin, 'PATCH', `/agencies/${agencyId}`, { status: 'inactive' });
    const res = await call(ctx, m.cookie, 'GET', '/agency/home');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AGENCY_INACTIVE');
    await call(ctx, admin, 'PATCH', `/agencies/${agencyId}`, { status: 'active' });
    expect((await call(ctx, m.cookie, 'GET', '/agency/home')).statusCode).toBe(200);
  });

  it('agency members cannot be moved to internal roles from the company role editor', async () => {
    const m = await addAgencyMember(ctx, admin, agency, 'stuck@agency.test');
    const res = await call(ctx, admin, 'PUT', `/users/${m.userId}/roles`, { assignments: [{ role_code: 'company_admin', department_id: null }] });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe('AGENCY_USER');
  });

  it('a person cannot belong to two agencies', async () => {
    const a = await createAgency(ctx, admin, 'Agency One');
    const b = await createAgency(ctx, admin, 'Agency Two');
    const m = await addAgencyMember(ctx, admin, a, 'twice@agency.test');
    await expect(ctx.adminDb.insertInto('agency_members').values({ tenant_id: s.co.tenant.id, agency_id: b, user_id: m.userId, agency_role: 'recruiter' }).execute()).rejects.toThrow(/duplicate key/);
  });

  it('records member changes in the audit log', async () => {
    const actions = (await ctx.adminDb.selectFrom('audit_events').select('action').where('tenant_id', '=', s.co.tenant.id).where('entity_type', '=', 'agency').execute()).map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(['agency.member_invited', 'agency.member_updated']));
    expect(login).toBeDefined();
  });
});
