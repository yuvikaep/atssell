import net from 'node:net';
import type { FileScanner, ScanResult } from '../storage.js';

/**
 * Scans through a clamd daemon using the INSTREAM protocol: the file is streamed in length-prefixed
 * chunks and clamd answers "stream: OK" or "stream: <name> FOUND". Anything else (connection refused,
 * timeout, "ERROR") is reported as 'failed', never as clean, so an unreachable scanner cannot let a
 * file through.
 */
export class ClamAvScanner implements FileScanner {
  constructor(private readonly opts: { host: string; port: number; timeoutMs?: number }) {}

  scan(data: Buffer): Promise<ScanResult> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.opts.host, port: this.opts.port });
      let reply = '';
      let settled = false;
      const done = (r: ScanResult) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(r);
      };
      socket.setTimeout(this.opts.timeoutMs ?? 30_000, () => done('failed'));
      socket.on('error', () => done('failed'));
      socket.on('data', (d) => { reply += d.toString('utf8'); });
      socket.on('end', () => {
        const text = reply.replace(/\0/g, '').trim();
        if (/^stream: OK$/.test(text)) done('clean');
        else if (/FOUND$/.test(text)) done('infected');
        else done('failed');
      });
      socket.on('connect', () => {
        socket.write('zINSTREAM\0');
        const CHUNK = 64 * 1024;
        for (let i = 0; i < data.length; i += CHUNK) {
          const chunk = data.subarray(i, i + CHUNK);
          const len = Buffer.alloc(4);
          len.writeUInt32BE(chunk.length);
          socket.write(len);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
      });
    });
  }
}
