// One plain status per candidate (sheet, filter, counts) and the backout step after selection.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, setupApp, type TestContext } from './helpers.js';
import { applicationOnVacancy, setupCompany } from './hiring-helpers.js';

let ctx: TestContext;
let s: Awaited<ReturnType<typeof setupCompany>>;
let admin: string;
let manager: string;

beforeAll(async () => {
  ctx = await setupApp();
  s = await setupCompany(ctx, 'ss');
  [admin, manager] = await Promise.all([s.as('admin'), s.as('engManager')]);
});
afterAll(() => ctx.close());

const sheetStatus = async (candidateId: string) =>
  ((await call(ctx, admin, 'GET', '/candidate-master?page_size=200')).json().data as { id: string; simple_status: string }[]).find((r) => r.id === candidateId)?.simple_status;

describe('plain statuses', () => {
  it('go sourced → selected → backout, are filterable and counted', async () => {
    const a = await applicationOnVacancy(ctx, s, 'one');
    expect(await sheetStatus(a.candidateId)).toBe('sourced');
    const before = (await call(ctx, admin, 'GET', '/status-summary')).json().data;

    expect((await call(ctx, manager, 'POST', `/applications/${a.applicationId}/decisions`, { decision: 'select', reason: 'Good' })).statusCode).toBe(201);
    expect(await sheetStatus(a.candidateId)).toBe('selected');
    const filtered = (await call(ctx, admin, 'GET', '/candidate-master?status=selected')).json().data.map((r: { id: string }) => r.id);
    expect(filtered).toContain(a.candidateId);
    const after = (await call(ctx, admin, 'GET', '/status-summary')).json().data;
    expect(after.selected).toBe(before.selected + 1);
    expect(after.total).toBe(before.total);

    expect((await call(ctx, admin, 'POST', `/applications/${a.applicationId}/backout`, {})).statusCode).toBe(400);
    expect((await call(ctx, admin, 'POST', `/applications/${a.applicationId}/backout`, { reason: 'Took another offer' })).statusCode).toBe(200);
    expect(await sheetStatus(a.candidateId)).toBe('backout');
    expect((await call(ctx, admin, 'POST', `/applications/${a.applicationId}/backout`, { reason: 'Again' })).statusCode).toBe(409);
  });

  it('cannot back out someone who was never selected, and rejects show as rejected', async () => {
    const b = await applicationOnVacancy(ctx, s, 'twotwo');
    expect((await call(ctx, admin, 'POST', `/applications/${b.applicationId}/backout`, { reason: 'x' })).statusCode).toBe(409);
    await call(ctx, manager, 'POST', `/applications/${b.applicationId}/decisions`, { decision: 'reject', reason: 'Not a fit' });
    expect(await sheetStatus(b.candidateId)).toBe('rejected');
  });
});
