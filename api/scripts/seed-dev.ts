// Development seed: a demo company with a few departments and users, all with password-based
// login. Idempotent: does nothing if the demo company already exists.
import { createDb } from '../src/db.js';
import { hashPassword } from '../src/security.js';
import { createTenant } from '../src/services/tenants.js';

if (process.env.NODE_ENV === 'production') throw new Error('seed-dev must not run in production');
const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');

const SLUG = 'demo';
const PASSWORD = 'demo-password-123';
const db = createDb(adminUrl, 1);

try {
  const exists = await db.selectFrom('tenants').select('id').where('slug', '=', SLUG).executeTakeFirst();
  if (exists) {
    console.log(`Demo company already exists (company code: ${SLUG}).`);
  } else {
    const { tenant, admin } = await createTenant(db, {
      name: 'Demo Industries',
      slug: SLUG,
      adminEmail: 'admin@demo.test',
      adminName: 'Priya Admin',
    });
    const passwordHash = await hashPassword(PASSWORD);

    await db.transaction().execute(async (tx) => {
      await tx.updateTable('users').set({ password_hash: passwordHash }).where('id', '=', admin.id).execute();

      const [eng, sales] = await tx
        .insertInto('departments')
        .values([
          { tenant_id: tenant.id, name: 'Engineering', head_user_id: admin.id },
          { tenant_id: tenant.id, name: 'Sales' },
        ])
        .returning('id')
        .execute();
      await tx
        .insertInto('departments')
        .values({ tenant_id: tenant.id, name: 'Platform Engineering', parent_department_id: eng!.id })
        .execute();

      const roles = Object.fromEntries(
        (await tx.selectFrom('roles').select(['id', 'code']).where('tenant_id', 'is', null).execute()).map((r) => [r.code, r.id]),
      );
      const people = [
        { email: 'recruiter@demo.test', name: 'Rahul Recruiter', role: 'internal_recruiter', dept: null },
        { email: 'recruiter2@demo.test', name: 'Sneha Recruiter', role: 'internal_recruiter', dept: null },
        { email: 'ishita@demo.test', name: 'Ishita Interviewer', role: 'interviewer', dept: null },
        { email: 'karan@demo.test', name: 'Karan Interviewer', role: 'interviewer', dept: null },
      ];
      for (const person of people) {
        const user = await tx
          .insertInto('users')
          .values({ tenant_id: tenant.id, email: person.email, full_name: person.name, password_hash: passwordHash })
          .returning('id')
          .executeTakeFirstOrThrow();
        await tx
          .insertInto('user_role_assignments')
          .values({ tenant_id: tenant.id, user_id: user.id, role_id: roles[person.role]!, department_id: person.dept, assigned_by: admin.id })
          .execute();
      }
    });
    console.log('Seeded demo company.');
  }
  console.log(`\nSign in at http://localhost:5180 with company code "${SLUG}" and password "${PASSWORD}":`);
  console.log('  admin@demo.test       HR Lead');
  console.log('  recruiter@demo.test   Company Recruiter');
  console.log('  recruiter2@demo.test  Company Recruiter');
  console.log('  ishita@demo.test      Interviewer');
  console.log('  karan@demo.test       Interviewer');
} finally {
  await db.destroy();
}
