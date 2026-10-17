// Fills the demo company with a complete hiring picture so every screen has something real to show:
// jobs in every state, recruiters and agencies with commercial terms (one with a changed version),
// candidates across the pipeline, duplicate attempts, a CSV import, interviews with feedback, decisions,
// offers, joins, exits, replacements due, fulfilled and missed, a closed job, and an ownership correction.
//
//   npm run db:seed && npm run seed:demo        (the API must be running)
//
// Run it once on a fresh demo company; it stops if the demo jobs already exist.
import { createDb } from '../src/db.js';
import { hashPassword } from '../src/security.js';

const API = process.env.API_URL ?? 'http://localhost:3000';
const ORIGIN = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
const PASSWORD = 'demo-password-123';
const COMPANY = 'demo';

const db = createDb(process.env.DATABASE_URL_ADMIN!, 1);
const tenant = await db.selectFrom('tenants').select('id').where('slug', '=', COMPANY).executeTakeFirstOrThrow();
if (await db.selectFrom('vacancies').select('id').where('tenant_id', '=', tenant.id).limit(1).executeTakeFirst()) {
  console.log('Demo data is already loaded. Reset the demo database first to load it again.');
  await db.destroy();
  process.exit(0);
}

const hash = await hashPassword(PASSWORD);
const roleId = async (code: string) => (await db.selectFrom('roles').select('id').where('code', '=', code).where('tenant_id', 'is', null).executeTakeFirstOrThrow()).id;
const userByEmail = async (email: string) => (await db.selectFrom('users').select('id').where('tenant_id', '=', tenant.id).where('email', '=', email).executeTakeFirstOrThrow()).id;

// ---- tiny HTTP client, one session per person ----
type Who = 'hr' | 'rec1' | 'rec2' | 'isha' | 'karan' | 'northstar' | 'northstarSub' | 'summit' | 'apex';
const EMAIL: Record<Who, string> = {
  hr: 'admin@demo.test', rec1: 'recruiter@demo.test', rec2: 'recruiter2@demo.test', isha: 'ishita@demo.test', karan: 'karan@demo.test',
  northstar: 'neha@northstar.test', northstarSub: 'nikhil@northstar.test', summit: 'sam@summit.test', apex: 'anil@apex.test',
};
const cookies = new Map<Who, string>();
async function login(who: Who) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ company: COMPANY, email: EMAIL[who], password: PASSWORD }) });
    if (res.ok) { cookies.set(who, res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')); return; }
    if (res.status === 429) { await new Promise((r) => setTimeout(r, 15_000)); continue; }
    throw new Error(`login ${who}: ${res.status} ${await res.text()}`);
  }
  throw new Error(`login ${who}: rate limited`);
}
async function call<T = any>(who: Who, method: string, path: string, body?: unknown, expect: number[] = [200, 201, 202]): Promise<T> {
  if (!cookies.has(who)) await login(who);
  const res = await fetch(`${API}/api/v1${path}`, { method, headers: { cookie: cookies.get(who)!, origin: ORIGIN, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json: any = await res.json().catch(() => null);
  if (!expect.includes(res.status)) throw new Error(`${who} ${method} ${path} -> ${res.status} ${JSON.stringify(json?.error ?? json)}`);
  return json?.data as T;
}
const PDF = Buffer.from('%PDF-1.4\n% demo resume\n%%EOF');
async function submit(who: Who, jobId: string, profile: Record<string, unknown>) {
  if (!cookies.has(who)) await login(who);
  const form = new FormData();
  form.set('payload', JSON.stringify({ phone: null, skills: ['Sales'], source_declaration: 'agency_database', consent_confirmed: true, ...profile }));
  form.set('file', new Blob([PDF], { type: 'application/pdf' }), 'resume.pdf');
  const res = await fetch(`${API}/api/v1/agency/vacancies/${jobId}/submissions`, { method: 'POST', headers: { cookie: cookies.get(who)!, origin: ORIGIN }, body: form });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}
const iso = (d: Date) => d.toISOString().slice(0, 10);
const ago = (days: number) => iso(new Date(Date.now() - days * 86_400_000));
const at = (days: number, hour: number) => { const d = new Date(Date.now() + days * 86_400_000); d.setUTCHours(hour, 30, 0, 0); return d.toISOString(); };

// ---- departments, agencies and their people ----
console.log('Departments, agencies and terms…');
const deptId = async (name: string) => {
  const have = await db.selectFrom('departments').select('id').where('tenant_id', '=', tenant.id).where('name', '=', name).executeTakeFirst();
  return have?.id ?? (await call('hr', 'POST', '/departments', { name })).id as string;
};
const D = { sales: await deptId('Sales'), eng: await deptId('Engineering'), finance: await deptId('Finance'), hr: await deptId('Human Resources'), marketing: await deptId('Marketing') };

const agencySpecs = [
  { key: 'northstar' as const, name: 'Northstar Staffing', contact: 'neha@northstar.test', admin: ['Neha Kulkarni', 'neha@northstar.test'], sub: ['Nikhil Rane', 'nikhil@northstar.test'] },
  { key: 'summit' as const, name: 'Summit Recruiters', contact: 'sam@summit.test', admin: ['Sam Rao', 'sam@summit.test'] },
  { key: 'apex' as const, name: 'Apex Talent', contact: 'anil@apex.test', admin: ['Anil Kapoor', 'anil@apex.test'] },
];
const agency: Record<string, string> = {};
for (const a of agencySpecs) {
  const ex = await db.selectFrom('agencies').select('id').where('tenant_id', '=', tenant.id).where('name', '=', a.name).executeTakeFirst();
  agency[a.key] = ex?.id ?? (await call('hr', 'POST', '/agencies', { name: a.name, primary_contact_name: a.admin[0], primary_contact_email: a.contact })).id;
  for (const [i, [name, email]] of ([a.admin, ...(a.sub ? [a.sub] : [])] as string[][]).entries()) {
    const have = await db.selectFrom('users').select('id').where('email', '=', email!).executeTakeFirst();
    const uid = have?.id ?? (await db.insertInto('users').values({ tenant_id: tenant.id, email: email!, full_name: name!, password_hash: hash }).returning('id').executeTakeFirstOrThrow()).id;
    if (!have) {
      await db.insertInto('agency_members').values({ tenant_id: tenant.id, agency_id: agency[a.key]!, user_id: uid, agency_role: i === 0 ? 'admin' : 'recruiter' }).execute();
      await db.insertInto('user_role_assignments').values({ tenant_id: tenant.id, user_id: uid, role_id: await roleId(i === 0 ? 'agency_admin' : 'agency_recruiter'), department_id: null }).execute();
    }
  }
}
await db.updateTable('users').set({ password_hash: hash }).where('tenant_id', '=', tenant.id).execute();
// Northstar's terms changed 20 days ago: earlier hires keep version 1.
await call('hr', 'POST', `/agencies/${agency.northstar}/terms`, { payment_model: 'one_time_fee', fee_type: 'percent_of_ctc', fee_value: 8.33, lockin_days: 90, replacement_days: 60, effective_from: ago(400), agreement_ref: 'NS-MSA-2025' });
await call('hr', 'POST', `/agencies/${agency.northstar}/terms`, { payment_model: 'one_time_fee', fee_type: 'percent_of_ctc', fee_value: 10, lockin_days: 90, replacement_days: 45, effective_from: ago(20), agreement_ref: 'NS-MSA-2026', notes: 'Renegotiated after volume review' });
await call('hr', 'POST', `/agencies/${agency.summit}/terms`, { payment_model: 'one_time_fee', fee_type: 'fixed', fee_value: 60000, lockin_days: 60, replacement_days: 30, effective_from: ago(400), agreement_ref: 'SUM-2025' });
await call('hr', 'POST', `/agencies/${agency.apex}/terms`, { payment_model: 'payroll_management', fee_type: 'fixed', fee_value: 15000, lockin_days: 120, replacement_days: 30, effective_from: ago(400), agreement_ref: 'APEX-PAYROLL-1' });

// ---- jobs ----
console.log('Jobs and assignments…');
const job = async (title: string, department_id: string, location: string, openings: number, min: number, max: number) => {
  const j = await call('hr', 'POST', '/jobs', { title, department_id, location, openings, salary_min: min, salary_max: max, description: `${title}: own the work of the role, partner with the team and report on results.`, skills: ['Communication'] });
  return { id: j.id as string, code: j.vacancy_code as string };
};
const jobs = {
  sales: await job('Sales Executive', D.sales, 'Mumbai', 12, 700_000, 1_400_000),
  account: await job('Account Manager', D.sales, 'Delhi', 2, 1_400_000, 2_200_000),
  backend: await job('Backend Engineer', D.eng, 'Pune', 3, 1_800_000, 3_200_000),
  frontend: await job('Frontend Engineer', D.eng, 'Remote', 2, 1_600_000, 2_800_000),
  accountant: await job('Senior Accountant', D.finance, 'Mumbai', 2, 900_000, 1_600_000),
  hrexec: await job('HR Executive', D.hr, 'Pune', 1, 500_000, 900_000),
  marketing: await job('Marketing Associate', D.marketing, 'Bengaluru', 1, 600_000, 1_100_000),
};
const rec1 = await userByEmail(EMAIL.rec1);
const rec2 = await userByEmail(EMAIL.rec2);
const isha = await userByEmail(EMAIL.isha);
const karan = await userByEmail(EMAIL.karan);
const assign = async (j: { id: string }, recruiters: string[], agencies: string[]) => {
  for (const r of recruiters) await call('hr', 'POST', `/vacancies/${j.id}/assign-recruiter`, { user_id: r });
  for (const a of agencies) await call('hr', 'POST', `/vacancies/${j.id}/assign-agency`, { agency_id: agency[a] });
};
await assign(jobs.sales, [rec1], ['northstar', 'summit', 'apex']);
await assign(jobs.account, [rec1, rec2], ['northstar', 'summit']);
await assign(jobs.backend, [rec1], ['apex']);
await assign(jobs.frontend, [rec2], ['apex', 'northstar']);
await assign(jobs.accountant, [rec2], ['summit']);
await assign(jobs.hrexec, [rec2], []);
await assign(jobs.marketing, [rec2], ['northstar']);

// ---- candidates ----
console.log('Candidates, submissions and duplicates…');
const stageIds: Record<string, string> = Object.fromEntries((await call<{ id: string; code: string }[]>('hr', 'GET', '/pipeline/stages')).map((s) => [s.code, s.id]));
const FIRST = ['Aarav', 'Diya', 'Rohan', 'Sneha', 'Kabir', 'Isha', 'Vivaan', 'Anaya', 'Arjun', 'Myra', 'Reyansh', 'Kiara', 'Aditya', 'Saanvi', 'Ishaan', 'Navya', 'Dhruv', 'Tara', 'Rahul', 'Pooja', 'Karan', 'Meghna', 'Yash', 'Riya', 'Nikhil', 'Sakshi', 'Varun', 'Ananya', 'Manav', 'Zoya', 'Tanvi', 'Harsh', 'Pallavi', 'Neel', 'Kavya', 'Omkar'];
const LAST = ['Sharma', 'Patel', 'Iyer', 'Nair', 'Gupta', 'Singh', 'Reddy', 'Joshi', 'Mehta', 'Kapoor', 'Das', 'Khan', 'Bose', 'Menon', 'Verma', 'Rao'];
const CITIES = ['Mumbai', 'Pune', 'Delhi', 'Bengaluru', 'Hyderabad', 'Chennai'];
let seq = 0;
const person = (title: string, skills: string[], exp: number) => {
  seq += 1;
  const first = FIRST[seq % FIRST.length]!;
  const last = LAST[(seq * 5) % LAST.length]!;
  return { full_name: `${first} ${last}`, email: `${first}.${last}${seq}@mail.test`.toLowerCase(), phone: `9${String(400000000 + seq * 7919).padStart(9, '0')}`, city: CITIES[seq % CITIES.length], current_title: title, total_experience_years: exp, notice_period_days: [15, 30, 60, 90][seq % 4], skills };
};
interface Hire { applicationId: string; candidateId: string; who: Who | 'internal'; job: { id: string }; p: ReturnType<typeof person> }
const applicationOf = async (email: string, jobId: string) => {
  const c = await db.selectFrom('candidates').select('id').where('tenant_id', '=', tenant.id).where('email', '=', email).executeTakeFirstOrThrow();
  const a = await db.selectFrom('applications').select('id').where('candidate_id', '=', c.id).where('vacancy_id', '=', jobId).executeTakeFirstOrThrow();
  return { candidateId: c.id, applicationId: a.id };
};
async function internal(who: 'rec1' | 'rec2', j: { id: string }, title: string, skills: string[], exp: number): Promise<Hire> {
  const p = person(title, skills, exp);
  const c = await call(who, 'POST', '/candidates', { ...p, profile_summary: `${exp} years as ${title}.` });
  const a = await call(who, 'POST', '/applications', { candidate_id: c.id, vacancy_id: j.id, source_type: 'internal_recruiter' });
  return { applicationId: a.id, candidateId: c.id, who: 'internal', job: j, p };
}
async function viaAgency(who: Who, j: { id: string }, title: string, skills: string[], exp: number, reuse?: ReturnType<typeof person>): Promise<Hire> {
  const p = reuse ?? person(title, skills, exp);
  const res = await submit(who, j.id, p);
  if (res.status !== 201) throw new Error(`agency submit ${who}: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...(await applicationOf(p.email, j.id)), who, job: j, p };
}
const move = (id: string, code: string) => call('hr', 'PATCH', `/applications/${id}/stage`, { stage_id: stageIds[code], ...(code === 'rejected' || code === 'withdrawn' ? { reason: code === 'rejected' ? 'Salary expectation outside the band' : 'Accepted another job' } : {}) });
const upTo = async (id: string, ...codes: string[]) => { for (const c of codes) await move(id, c); };

const sales: Hire[] = [];
for (let i = 0; i < 4; i++) sales.push(await internal('rec1', jobs.sales, 'Sales Executive', ['B2B sales', 'CRM'], 2 + i));
for (let i = 0; i < 5; i++) sales.push(await viaAgency('northstar', jobs.sales, 'Territory Sales Executive', ['B2B sales', 'CRM'], 3 + i));
for (let i = 0; i < 2; i++) sales.push(await viaAgency('northstarSub', jobs.sales, 'Sales Associate', ['Sales'], 2 + i));
for (let i = 0; i < 3; i++) sales.push(await viaAgency('summit', jobs.sales, 'Business Development Executive', ['B2B sales', 'Negotiation'], 4 + i));
for (let i = 0; i < 2; i++) sales.push(await viaAgency('apex', jobs.sales, 'Inside Sales Executive', ['Telecalling'], 1 + i));
const account: Hire[] = [];
for (let i = 0; i < 2; i++) account.push(await internal('rec2', jobs.account, 'Key Account Executive', ['Key accounts'], 5 + i));
for (let i = 0; i < 2; i++) account.push(await viaAgency('northstar', jobs.account, 'Account Executive', ['Key accounts'], 6 + i));
account.push(await viaAgency('summit', jobs.account, 'Relationship Manager', ['Presentations'], 7));
const backend: Hire[] = [];
for (let i = 0; i < 4; i++) backend.push(await internal('rec1', jobs.backend, 'Software Engineer', ['Node.js', 'PostgreSQL'], 3 + i));
for (let i = 0; i < 3; i++) backend.push(await viaAgency('apex', jobs.backend, 'Backend Developer', ['Node.js', 'AWS'], 4 + i));
const frontend: Hire[] = [];
for (let i = 0; i < 3; i++) frontend.push(await internal('rec2', jobs.frontend, 'UI Developer', ['React', 'TypeScript'], 2 + i));
for (let i = 0; i < 2; i++) frontend.push(await viaAgency('apex', jobs.frontend, 'Frontend Developer', ['React'], 3 + i));
frontend.push(await viaAgency('northstar', jobs.frontend, 'Web Developer', ['React', 'CSS'], 3));
const accountant: Hire[] = [];
for (let i = 0; i < 2; i++) accountant.push(await internal('rec2', jobs.accountant, 'Accountant', ['Tally', 'GST'], 4 + i));
for (let i = 0; i < 3; i++) accountant.push(await viaAgency('summit', jobs.accountant, 'Senior Accountant', ['Tally', 'GST'], 5 + i));
const hrexec = [await internal('rec2', jobs.hrexec, 'HR Associate', ['Onboarding'], 3)];
const marketing = [await internal('rec2', jobs.marketing, 'Marketing Executive', ['SEO', 'Content'], 3), await viaAgency('northstar', jobs.marketing, 'Content Marketer', ['Content'], 4)];

// Duplicates: refused, recorded, the first owner keeps the job.
const northstarCandidate = sales[4]!.p;
const d1 = await submit('summit', jobs.sales.id, northstarCandidate);
const existing = await applicationOf(northstarCandidate.email, jobs.sales.id);
await call('rec1', 'POST', '/applications', { candidate_id: existing.candidateId, vacancy_id: jobs.sales.id, source_type: 'internal_recruiter' }, [409]);
console.log(`  duplicates refused: agency ${d1.status}, recruiter 409`);
// The same candidate on a different job is a separate submission with its own owner.
await viaAgency('apex', jobs.backend, 'Backend Developer', ['Node.js'], 4, northstarCandidate);

// A CSV import by a recruiter, with a duplicate and a bad row.
const csv = [
  'Name,Email,Phone,City,Title,Experience,Skills,Job',
  `Imran Shaikh,imran.shaikh@mail.test,9${String(600000001).padStart(9, '0')},Mumbai,Sales Executive,3,"B2B sales; CRM",${jobs.sales.code}`,
  `Divya Pillai,divya.pillai@mail.test,9${String(600000002).padStart(9, '0')},Pune,Sales Executive,2,CRM,${jobs.sales.code}`,
  `Tarun Bhatt,tarun.bhatt@mail.test,9${String(600000003).padStart(9, '0')},Delhi,Key Account Executive,6,Key accounts,${jobs.account.code}`,
  `${northstarCandidate.full_name},${northstarCandidate.email},,Pune,Sales Executive,3,,${jobs.sales.code}`,
  'Broken Row,not-an-email,,,,,,',
].join('\n');
const imp = await call('rec1', 'POST', '/candidates/import', { csv });
console.log(`  import: ${imp.summary.created} new, ${imp.summary.duplicates} duplicate, ${imp.summary.failed} failed`);

// ---- pipeline ----
console.log('Pipeline, interviews and feedback…');
// A spread of statuses on the sales job.
await upTo(sales[0]!.applicationId, 'screening');
await upTo(sales[1]!.applicationId, 'screening', 'shortlisted');
await upTo(sales[2]!.applicationId, 'screening', 'shortlisted');
await move(sales[3]!.applicationId, 'rejected');
await upTo(sales[5]!.applicationId, 'screening');
await upTo(sales[6]!.applicationId, 'screening', 'shortlisted', 'interview');
await upTo(sales[7]!.applicationId, 'screening', 'shortlisted', 'interview');
await move(sales[9]!.applicationId, 'withdrawn');
for (const h of [...account.slice(0, 3), ...backend.slice(0, 5), ...frontend.slice(0, 3), ...accountant.slice(0, 3)]) await upTo(h.applicationId, 'screening', 'shortlisted');

const panelOf = (...ids: string[]) => ids.map((user_id) => ({ user_id }));
const schedule = async (who: Who, h: Hire, round: string, days: number, hour: number, ids: string[]) =>
  (await call(who, 'POST', `/applications/${h.applicationId}/interviews`, { round_name: round, mode: 'google_meet', scheduled_start: at(days, hour), scheduled_end: at(days, hour + 1), timezone: 'Asia/Kolkata', meeting_url: 'https://meet.google.com/demo-room', panel: panelOf(...ids) })) as { id: string };
const backdate = (id: string, days: number, hour: number) => db.updateTable('interviews').set({ scheduled_start: at(days, hour), scheduled_end: at(days, hour + 1), feedback_due_at: at(days + 2, hour) }).where('id', '=', id).execute();
const feedback = (who: Who, interview: string, rating: number, rec: string, notes: string) => call(who, 'POST', `/me/interviews/${interview}/feedback`, {
  mode: 'google_meet', overall_rating: rating, recommendation: rec, notes, competency_ratings: { role_skills: rating, communication: Math.max(1, rating - 1), problem_solving: rating },
});
// Jobs and the recruiter assigned to them (rec1 works sales, account and backend; rec2 the rest).
const recruiterFor = (h: Hire): 'rec1' | 'rec2' => ([jobs.sales.id, jobs.account.id, jobs.backend.id].includes(h.job.id) ? 'rec1' : 'rec2');
const held = async (h: Hire, round: string, daysAgo: number, panel: [Who, string][], rating: number, rec: string, notes: string) => {
  const iv = await schedule(recruiterFor(h), h, round, 4, 10, panel.map(([w]) => (w === 'isha' ? isha : karan)));
  await backdate(iv.id, -daysAgo, 10);
  for (const [w] of panel) await feedback(w, iv.id, rating, rec, notes);
  return iv;
};
const interviewed = [sales[4]!, sales[5]!, sales[6]!, sales[7]!, sales[8]!, sales[12]!, account[0]!, account[1]!, backend[0]!, backend[1]!, backend[4]!, frontend[0]!, accountant[0]!, accountant[2]!];
for (const [i, h] of interviewed.entries()) {
  await held(h, 'First round', 12 + i, [['isha', ''], ['karan', '']], 3 + (i % 3), i % 5 === 4 ? 'no' : 'yes', ['Clear communicator, good examples.', 'Solid fundamentals; needs coaching.', 'Strong fit for the role.'][i % 3]!);
}
// Upcoming interviews and one still owing feedback.
await schedule('rec1', sales[6]!, 'Final round', 1, 11, [isha, karan]);
await schedule('rec1', sales[7]!, 'Final round', 2, 15, [karan]);
await schedule('rec1', account[2]!, 'Technical round', 2, 12, [isha]);
await schedule('rec1', backend[2]!, 'System design', 3, 10, [karan]);
const owing = await schedule('rec1', backend[3]!, 'Coding round', 4, 11, [isha]);
await backdate(owing.id, -3, 11);
// A round a recruiter still has to book.
await call('rec2', 'POST', `/applications/${frontend[1]!.applicationId}/interviews`, { round_name: 'Portfolio review', mode: 'google_meet', panel: panelOf(isha) });

// Decisions by the HR Lead.
await call('hr', 'POST', `/applications/${sales[6]!.applicationId}/decisions`, { decision: 'select', reason: 'Best numbers of the group.' });
await call('hr', 'POST', `/applications/${sales[7]!.applicationId}/decisions`, { decision: 'hold', reason: 'Waiting for references.' });
await call('hr', 'POST', `/applications/${sales[4]!.applicationId}/decisions`, { decision: 'select', reason: 'Strong across rounds.' });
await call('hr', 'POST', `/applications/${account[1]!.applicationId}/decisions`, { decision: 'reject', reason: 'Experience gap for key accounts.' });

// ---- offers, joins, exits, replacements ----
console.log('Offers, joins, exits and replacements…');
const offer = (h: Hire, ctc: number, status: 'offered' | 'accepted' | 'declined', reason?: string) => call('hr', 'POST', `/applications/${h.applicationId}/offer`, { offered_ctc: ctc, status, ...(reason ? { decline_reason: reason } : {}) });
await offer(sales[8]!, 1_150_000, 'offered');
await offer(backend[0]!, 2_600_000, 'accepted');
await offer(accountant[0]!, 1_300_000, 'declined', 'Accepted a higher offer elsewhere');
await offer(frontend[0]!, 2_200_000, 'offered');

const join = async (h: Hire, daysAgo: number, designation: string, ctc: number) => (await call('hr', 'POST', `/applications/${h.applicationId}/join`, { joined_on: ago(daysAgo), designation, annual_ctc: ctc })).id as string;
const exit = (id: string, daysAgo: number, reason: string) => call('hr', 'POST', `/employment/${id}/exit`, { exit_date: ago(daysAgo), exit_reason: reason });

// Northstar: two hires under version 1 (one leaves inside the lock-in and is replaced), two under version 2.
const ns = sales.filter((h) => h.who === 'northstar');
const nsA = await join(ns[0]!, 110, 'Sales Executive', 900_000);
const nsB = await join(ns[1]!, 100, 'Sales Executive', 1_000_000);
await join(ns[2]!, 12, 'Sales Executive', 1_100_000);
await join(ns[3]!, 8, 'Sales Executive', 1_200_000);
await exit(nsA, 70, 'Found another job');            // inside the 90-day lock-in: replacement due (v1 allows 60 days)
await exit(nsB, 5, 'Relocated');                      // after the lock-in: nothing owed
// Replacement for Northstar's early leaver: a hire from the same agency on the same job.
const repl = ((await call('hr', 'GET', '/replacements?status=due')) as { id: string; employment_id: string }[]).find((r) => r.employment_id === nsA);
const nsC = await join(ns[4]!, 30, 'Sales Executive', 950_000);
if (repl) await call('hr', 'POST', `/replacements/${repl.id}/link`, { replacement_employment_id: nsC });
// Summit: one early exit whose replacement window has passed, one still due, one hire who stays.
const sm = sales.filter((h) => h.who === 'summit');
const smA = await join(sm[0]!, 100, 'Business Development Executive', 1_050_000);
await exit(smA, 90, 'Not a fit');                     // lock-in 60: served 10 days, owed within 30 -> overdue
const smB = await join(sm[1]!, 60, 'Business Development Executive', 1_100_000);
await exit(smB, 15, 'Left for a competitor');         // served 45 days, inside the 60-day lock-in; due in 15 days
await join(sm[2]!, 40, 'Business Development Executive', 1_150_000);
// Apex (payroll model), the company's own recruiters, and a second job for the funnel.
await join(sales.filter((h) => h.who === 'apex')[0]!, 50, 'Inside Sales Executive', 600_000);
await join(sales[0]!, 45, 'Sales Executive', 800_000);
await join(sales[1]!, 25, 'Sales Executive', 850_000);
await join(backend[1]!, 35, 'Software Engineer', 2_400_000);
await join(frontend[2]!, 20, 'UI Developer', 1_900_000);
await join(accountant.filter((h) => h.who === 'summit')[0]!, 30, 'Senior Accountant', 1_200_000);
await join(marketing[1]!, 15, 'Content Marketer', 800_000);
// Invoice tracking on agency hires.
const hires = (await call('hr', 'GET', '/employment?page_size=200')) as { id: string; source_agency_id: string | null; candidate_name: string }[];
let n = 0;
for (const e of hires.filter((x) => x.source_agency_id)) {
  const status = (['paid', 'invoiced', 'not_invoiced'] as const)[n++ % 3]!;
  await call('hr', 'PATCH', `/employment/${e.id}/invoice`, { invoice_status: status, invoice_reference: status === 'not_invoiced' ? null : `INV-${1000 + n}` });
}

// ---- job states and a correction ----
console.log('Job states and an ownership correction…');
await call('hr', 'PATCH', `/vacancies/${jobs.hrexec.id}`, { status: 'on_hold', status_reason: 'Hiring freeze until next quarter' });
await call('hr', 'POST', `/jobs/${jobs.marketing.id}/close`, { outcome: 'Position filled by Northstar Staffing' });
// A submission credited to the wrong agency, corrected with a reason (kept in the audit trail).
const wrong = await viaAgency('summit', jobs.frontend, 'Web Developer', ['React'], 3).catch(() => null);
if (wrong) {
  const sub = await db.selectFrom('submissions').select('id').where('application_id', '=', wrong.applicationId).executeTakeFirstOrThrow();
  await call('hr', 'POST', `/submissions/${sub.id}/correct-ownership`, { agency_id: agency.apex, reason: 'Email trail shows Apex Talent sourced this candidate first.' });
}

await db.destroy();
console.log(`\nDone. Sign in at ${ORIGIN} with company code "${COMPANY}" and password "${PASSWORD}":`);
console.log('  HR Lead             admin@demo.test');
console.log('  Company Recruiter   recruiter@demo.test, recruiter2@demo.test');
console.log('  Agency              neha@northstar.test (+ sub-recruiter nikhil@northstar.test), sam@summit.test, anil@apex.test');
console.log('  Interviewer         ishita@demo.test, karan@demo.test');
