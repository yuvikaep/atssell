// Provisions a company. Platform-admin tool: uses the owner connection.
// Usage: npm run tenant:create -- --name "Acme Corp" --slug acme --admin-email a@acme.com --admin-name "Asha Rao"
import { parseArgs } from 'node:util';
import { createDb } from '../src/db.js';
import { createTenant } from '../src/services/tenants.js';

const { values } = parseArgs({
  options: {
    name: { type: 'string' },
    slug: { type: 'string' },
    'admin-email': { type: 'string' },
    'admin-name': { type: 'string' },
  },
});

const name = values.name;
const slug = values.slug;
const adminEmail = values['admin-email'];
const adminName = values['admin-name'];
if (!name || !slug || !adminEmail || !adminName) {
  console.error('Usage: npm run tenant:create -- --name "Acme Corp" --slug acme --admin-email a@acme.com --admin-name "Asha Rao"');
  process.exit(1);
}

const adminUrl = process.env.DATABASE_URL_ADMIN;
if (!adminUrl) throw new Error('DATABASE_URL_ADMIN is not set');
const db = createDb(adminUrl, 1);
try {
  const result = await createTenant(db, { name, slug, adminEmail, adminName });
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:5180';
  console.log(`Created company "${result.tenant.name}" (company code: ${result.tenant.slug})`);
  console.log(`Company Admin: ${result.admin.email}`);
  console.log(`Send the admin this one-time link to set their password (valid until ${result.setupExpiresAt.toISOString()}):`);
  console.log(`${origin}/reset-password#${result.setupToken}`);
} finally {
  await db.destroy();
}
