// Serverless hosting has no long-running process, so the in-process worker timer cannot run. Instead,
// the worker is driven by the API's own traffic: after a signed-in request, run one pass for that
// company in the background, at most once a minute per instance. A scheduled call to /cron/worker covers
// quiet periods. Every pass is idempotent and uses row locks, so overlapping passes are safe.
import { runTenantTick, type WorkerDeps } from './worker.js';

export function serverlessWorker(
  deps: WorkerDeps,
  opts: { everyMs?: number; waitUntil: (p: Promise<unknown>) => void; now?: () => number },
): (tenantId: string) => void {
  const everyMs = opts.everyMs ?? 60_000;
  const now = opts.now ?? Date.now;
  const lastRun = new Map<string, number>();
  return (tenantId) => {
    const t = now();
    if (t - (lastRun.get(tenantId) ?? 0) < everyMs) return;
    lastRun.set(tenantId, t);
    opts.waitUntil(runTenantTick(deps, tenantId, new Date(t)).catch((err: Error) => deps.log?.('background pass failed', { error: err.message })));
  };
}
