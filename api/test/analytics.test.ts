import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let other: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let engManager: string;
let salesManager: string;
let recruiter: string;
let otherAdmin: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'an');
  other = await setupCompany(ctx, 'ao');
  [admin, engManager, salesManager, recruiter, otherAdmin] = await Promise.all([s.as('admin'), s.as('engManager'), s.as('salesManager'), s.as('recruiter'), other.as('admin')]);
  await applicationOnVacancy(ctx, s, 'a');
  await applicationOnVacancy(ctx, s, 'bb');
  await applicationOnVacancy(ctx, other, 'a');
});
afterAll(() => ctx.close());

const get = async (cookie: string, path: string) => call(ctx, cookie, 'GET', path);

describe('analytics reports', () => {
  it('every report states its definition and the range it covers', async () => {
    for (const r of ['hiring-funnel', 'vacancy-ageing', 'feedback-sla', 'recruiter-activity', 'time-to-hire', 'agency-performance']) {
      const res = await get(admin, `/analytics/${r}`);
      expect(res.statusCode, r).toBe(200);
      expect(res.json().data.definition, r).toEqual(expect.any(String));
    }
    const f = (await get(admin, '/analytics/hiring-funnel?from=2020-01-01&to=2020-01-31')).json().data;
    expect(f.range).toEqual({ from: '2020-01-01', to: '2020-01-31' });
    expect(f.total_applications).toBe(0);
  });

  it('counts only this company, and the funnel reflects applications', async () => {
    const mine = (await get(admin, '/analytics/hiring-funnel')).json().data;
    const theirs = (await get(otherAdmin, '/analytics/hiring-funnel')).json().data;
    expect(mine.total_applications).toBe(2);
    expect(theirs.total_applications).toBe(1);
    expect(mine.stages.length).toBeGreaterThan(3);
  });

  it('limits a hiring manager to their department', async () => {
    expect((await get(admin, '/analytics/vacancy-ageing')).json().data.total_open).toBe(2);
    const r = await get(engManager, '/analytics/hiring-funnel'); expect(r.json().data.total_applications).toBe(2);
    expect((await get(salesManager, '/analytics/hiring-funnel')).json().data.total_applications).toBe(0);
    expect((await get(salesManager, '/analytics/vacancy-ageing')).json().data.total_open).toBe(0);
  });

  it('applies department filters', async () => {
    const eng = (await get(admin, `/analytics/hiring-funnel?department_id=${s.eng.id}`)).json().data;
    const sales = (await get(admin, `/analytics/hiring-funnel?department_id=${s.sales.id}`)).json().data;
    expect(eng.total_applications).toBe(2);
    expect(sales.total_applications).toBe(0);
  });

  it('rejects malformed filters', async () => {
    expect((await get(admin, '/analytics/hiring-funnel?from=yesterday')).statusCode).toBe(400);
    expect((await get(admin, '/analytics/hiring-funnel?department_id=nope')).statusCode).toBe(400);
  });

  it('keeps agency figures to people who manage agencies', async () => {
    expect((await get(engManager, '/analytics/agency-performance')).statusCode).toBe(403);
    expect((await get(admin, '/analytics/agency-performance')).statusCode).toBe(200);
  });

  it('requires analytics permission for reports but lets recruiters see the dashboard', async () => {
    expect((await get(recruiter, '/analytics/hiring-funnel')).statusCode).toBe(403);
    const d = await get(recruiter, '/analytics/dashboard');
    expect(d.statusCode).toBe(200);
    expect(d.json().data).toHaveProperty('open_vacancies');
    expect((await call(ctx, '', 'GET', '/analytics/dashboard')).statusCode).toBe(401);
  });

  it('dashboard totals match the reports', async () => {
    const d = (await get(admin, '/analytics/dashboard')).json().data;
    expect(d.open_vacancies).toBe(2);
    expect(d.active_candidates).toBe(2);
    expect((await get(otherAdmin, '/analytics/dashboard')).json().data.active_candidates).toBe(1);
  });
});
