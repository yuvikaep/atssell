// Builds the web app and the API into Vercel's Build Output API layout (.vercel/output), so one
// Vercel project serves both however it was imported (repository root or web/ as Root Directory).
// https://vercel.com/docs/build-output-api
import { execSync } from 'node:child_process';
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Vercel reads .vercel/output from the project's Root Directory, where this build runs.
const out = path.resolve(process.cwd(), '.vercel/output');
const run = (cmd) => execSync(cmd, { cwd: repo, stdio: 'inherit' });

run('npm run -w api typecheck');
run('npm run -w web build');

// Optional: with the owner connection set for production builds only, bring the schema up to date
// before this code goes live. Migrations are idempotent; a failed one fails the deployment.
if (process.env.DATABASE_URL_ADMIN && process.env.VERCEL_ENV === 'production') {
  run('npx tsx api/src/migrate-cli.ts');
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(path.join(repo, 'web/dist'), path.join(out, 'static'), { recursive: true });

const fn = path.join(out, 'functions/api.func');
await build({
  entryPoints: [path.join(repo, 'api/src/vercel.ts')],
  outfile: path.join(fn, 'index.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // pg loads pg-native only when asked to; it is not installed.
  external: ['pg-native'],
  // Some dependencies are CommonJS and call require().
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  logLevel: 'info',
});
await writeFile(path.join(fn, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  maxDuration: 30,
}, null, 2));

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};
await writeFile(path.join(out, 'config.json'), JSON.stringify({
  version: 3,
  // Runs the worker once a day (allowed on every plan); on Pro use '* * * * *'. Needs CRON_SECRET.
  crons: [{ path: '/api/v1/cron/worker', schedule: '0 3 * * *' }],
  routes: [
    { src: '^/(.*)$', headers: securityHeaders, continue: true },
    // The API keeps its own paths; the function restores them from __path.
    { src: '^/(api(?:/.*)?|health)$', dest: '/api?__path=/$1' },
    { handle: 'filesystem' },
    // Frontend routes such as /login load the single-page app.
    { src: '^/(.*)$', dest: '/index.html' },
  ],
}, null, 2));
console.log(`Vercel output written to ${out}`);
