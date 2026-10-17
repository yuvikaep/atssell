// Production tenant provisioning: docker compose run --rm tenant --name "Acme" --slug acme --admin-email a@acme.com --admin-name "Asha"
import { parseArgs } from 'node:util';
import { createDb } from './db.js';
import { createTenant } from './services/tenants.js';

const { values } = parseArgs({ options: { name: { type: 'string' }, slug: { type: 'string' }, 'admin-email': { type: 'string' }, 'admin-name': { type: 'string' } } });
if (!values.name || !values.slug || !values['admin-email'] || !values['admin-name']) {
  console.error('Usage: --name "Acme Corp" --slug acme --admin-email a@acme.com --admin-name "Asha Rao"');
  process.exit(1);
}
const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');
const db = createDb(adminUrl, 1);
try {
  const r = await createTenant(db, { name: values.name, slug: values.slug, adminEmail: values['admin-email'], adminName: values['admin-name'] });
  console.log(`Created company "${r.tenant.name}" (company code: ${r.tenant.slug}), admin ${r.admin.email}`);
  console.log(`One-time set-password link (valid until ${r.setupExpiresAt.toISOString()}):\n${process.env.WEB_ORIGIN}/reset-password#${r.setupToken}`);
} finally {
  await db.destroy();
}
