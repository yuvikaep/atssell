import type { FileScanner, ScanResult } from '../storage.js';

/**
 * Scans through a small HTTPS service in front of ClamAV (see scanner-service/). For hosts such as Vercel
 * whose functions cannot reach clamd's plain TCP port safely. Anything other than a clear "clean" or
 * "infected" answer (timeout, error status, odd body) is 'failed', never clean.
 */
export class HttpScanner implements FileScanner {
  constructor(private readonly opts: { url: string; token: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {}

  async scan(data: Buffer): Promise<ScanResult> {
    const f = this.opts.fetchImpl ?? fetch;
    try {
      const res = await f(this.opts.url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.opts.token}`, 'content-type': 'application/octet-stream' },
        body: new Uint8Array(data),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
      });
      if (!res.ok) return 'failed';
      const body = (await res.json()) as { status?: string };
      return body.status === 'clean' ? 'clean' : body.status === 'infected' ? 'infected' : 'failed';
    } catch {
      return 'failed';
    }
  }
}
