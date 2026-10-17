import net from 'node:net';
import nodemailer from 'nodemailer';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createMailer, createScanner, createStorage } from '../src/providers/index.js';
import { ClamAvScanner } from '../src/providers/clamav.js';
import { S3Storage } from '../src/providers/s3.js';
import { SmtpMailer } from '../src/providers/smtp.js';

const base = { DATABASE_URL: 'postgres://x', WEB_ORIGIN: 'http://localhost:5180', IP_HASH_SALT: 'a-random-salt-value', FILE_URL_SECRET: 'a-random-secret-value-123' };

// A minimal clamd: reads INSTREAM chunks, answers by a rule on the content.
function fakeClamd(answer: (data: Buffer) => string | null) {
  const server = net.createServer((sock) => {
    let buf: Buffer = Buffer.alloc(0);
    sock.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      const cmd = 'zINSTREAM\0';
      if (buf.length < cmd.length || buf.subarray(0, cmd.length).toString() !== cmd) return;
      let off = cmd.length;
      const parts: Buffer[] = [];
      for (;;) {
        if (buf.length < off + 4) return;
        const len = buf.readUInt32BE(off);
        if (len === 0) break;
        if (buf.length < off + 4 + len) return;
        parts.push(buf.subarray(off + 4, off + 4 + len));
        off += 4 + len;
      }
      const reply = answer(Buffer.concat(parts));
      if (reply === null) return sock.destroy();
      sock.end(reply + '\0');
    });
  });
  return new Promise<{ port: number; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

describe('ClamAvScanner', () => {
  const servers: { close: () => Promise<void> }[] = [];
  afterAll(() => Promise.all(servers.map((s) => s.close())));

  it('reports clean, infected and failed distinctly, streaming large files whole', async () => {
    const s = await fakeClamd((data) => (data.includes('VIRUS') ? 'stream: Eicar-Test FOUND' : data.length === 300_000 ? 'stream: OK' : 'stream: ERROR'));
    servers.push(s);
    const scanner = new ClamAvScanner({ host: '127.0.0.1', port: s.port });
    expect(await scanner.scan(Buffer.alloc(300_000, 'a'))).toBe('clean');
    expect(await scanner.scan(Buffer.from('xx VIRUS xx'))).toBe('infected');
    expect(await scanner.scan(Buffer.from('other'))).toBe('failed');
  });

  it('never calls a file clean when the scanner is down or drops the connection', async () => {
    const dead = await fakeClamd(() => 'stream: OK');
    const port = dead.port;
    await dead.close();
    expect(await new ClamAvScanner({ host: '127.0.0.1', port, timeoutMs: 500 }).scan(Buffer.from('x'))).toBe('failed');
    const dropping = await fakeClamd(() => null);
    servers.push(dropping);
    expect(await new ClamAvScanner({ host: '127.0.0.1', port: dropping.port, timeoutMs: 500 }).scan(Buffer.from('x'))).toBe('failed');
  });
});

describe('S3Storage', () => {
  function fake() {
    const objects = new Map<string, { body: Buffer; type: string; sse?: string }>();
    return {
      objects,
      async send(cmd: { constructor: { name: string }; input: Record<string, any> }) {
        const i = cmd.input;
        if (cmd.constructor.name === 'PutObjectCommand') { objects.set(`${i.Bucket}/${i.Key}`, { body: i.Body, type: i.ContentType, sse: i.ServerSideEncryption }); return {}; }
        const o = objects.get(`${i.Bucket}/${i.Key}`);
        return o ? { Body: { transformToByteArray: async () => new Uint8Array(o.body) } } : {};
      },
    };
  }

  it('round-trips an object encrypted at rest under the prefix', async () => {
    const c = fake();
    const s = new S3Storage(c as never, 'bucket', 'jm/');
    await s.put('documents/t1/abc', Buffer.from('hello'), 'application/pdf');
    expect(c.objects.get('bucket/jm/documents/t1/abc')).toMatchObject({ type: 'application/pdf', sse: 'AES256' });
    expect((await s.get('documents/t1/abc')).toString()).toBe('hello');
  });

  it('refuses keys that could escape the prefix, and reports a missing object', async () => {
    const s = new S3Storage(fake() as never, 'bucket', 'jm/');
    await expect(s.put('../x', Buffer.from('a'), 't')).rejects.toThrow('invalid storage key');
    await expect(s.get('a b')).rejects.toThrow('invalid storage key');
    await expect(s.get('documents/none')).rejects.toThrow('missing object');
  });
});

describe('SmtpMailer', () => {
  const send = async (fn: (m: SmtpMailer) => Promise<void>) => {
    const transport = nodemailer.createTransport({ jsonTransport: true });
    const sent: { subject: string; text: string; to: string; from: string }[] = [];
    const spy = { sendMail: async (o: never) => { const r = await transport.sendMail(o); sent.push(JSON.parse(r.message as string)); return r; } };
    await fn(new SmtpMailer(spy as never, 'JobsMato <no-reply@example.com>'));
    return sent[0]!;
  };

  it('puts the link and expiry in the invitation and flattens header injection in subjects', async () => {
    const mail = await send((m) => m.sendInvitation({ to: 'a@b.test', companyName: 'Acme\r\nBcc: evil@x.test', inviterName: 'Priya', roleName: 'Recruiter', link: 'https://app.test/invite#tok', expiresAt: new Date('2030-01-01T00:00:00Z') }));
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain('https://app.test/invite#tok');
    expect(mail.text).toContain('2030');
    expect(JSON.stringify(mail.to)).toContain('a@b.test');
  });

  it('sends feedback requests and notices', async () => {
    const fb = await send((m) => m.sendFeedbackRequest({ to: 'k@x.test', interviewerName: 'Kiran', candidateName: 'Rohan', jobTitle: 'Analyst', roundName: 'Tech', scheduledStart: null, link: 'https://app.test/feedback#t', expiresAt: new Date() }));
    expect(fb.text).toContain('feedback#t');
    const n = await send((m) => m.sendNotice({ to: 'k@x.test', subject: 'Feedback pending', text: 'Please respond.', link: 'https://app.test/my-interviews' }));
    expect(n.text).toContain('Please respond.');
    expect(n.text).toContain('my-interviews');
  });
});

describe('production configuration', () => {
  it('refuses development providers in production', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', STORAGE_DRIVER: 'local' })).toThrow(/STORAGE_DRIVER=s3/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', SCANNER_DRIVER: 'dev' })).toThrow(/SCANNER_DRIVER=clamav/);
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', MAIL_DRIVER: 'console' })).toThrow(/MAIL_DRIVER=smtp/);
  });

  it('turns unconfigured services off in production, and off refuses the feature instead of failing to start', async () => {
    const config = loadConfig({ ...base, NODE_ENV: 'production' });
    expect([config.STORAGE_DRIVER, config.SCANNER_DRIVER, config.MAIL_DRIVER]).toEqual(['off', 'off', 'off']);
    await expect(createStorage(config, '/').put('k', Buffer.from('x'), 'text/plain')).rejects.toMatchObject({ status: 503, code: 'FILES_NOT_CONFIGURED' });
    await expect(createScanner(config).scan(Buffer.from('x'))).rejects.toMatchObject({ status: 503, code: 'FILES_NOT_CONFIGURED' });
    const mailer = createMailer(config);
    await expect(mailer.sendNotice({ to: 'a@b.test', subject: 's', text: 't' })).rejects.toMatchObject({ status: 503, code: 'EMAIL_NOT_CONFIGURED' });
    // Silent, so a reset request does not reveal whether the account exists.
    await expect(mailer.sendPasswordReset({ to: 'a@b.test', companyName: 'C', link: 'https://x', expiresAt: new Date() })).resolves.toBeUndefined();
    expect(loadConfig(base).STORAGE_DRIVER).toBe('local');
  });

  it('on Vercel, defaults WEB_ORIGIN to the production domain and also allows the deployment URLs', () => {
    const { WEB_ORIGIN: _, ...rest } = base;
    const vercel = { ...rest, VERCEL: '1', VERCEL_PROJECT_PRODUCTION_URL: 'ats.vercel.app', VERCEL_URL: 'ats-abc123.vercel.app', VERCEL_BRANCH_URL: 'ats-git-main.vercel.app' };
    const config = loadConfig(vercel);
    expect(config.WEB_ORIGIN).toBe('https://ats.vercel.app');
    expect(config.NODE_ENV).toBe('production');
    expect(config.ALLOWED_ORIGINS).toEqual(['https://ats.vercel.app', 'https://ats-abc123.vercel.app', 'https://ats-git-main.vercel.app']);
    expect(loadConfig({ ...vercel, WEB_ORIGIN: 'https://jobs.example.com/' }).WEB_ORIGIN).toBe('https://jobs.example.com');
    expect(loadConfig(base).ALLOWED_ORIGINS).toEqual(['http://localhost:5180']);
    expect(() => loadConfig(rest)).toThrow(/WEB_ORIGIN/);
  });

  it('accepts a complete production setup and requires the settings each driver needs', () => {
    const ok = loadConfig({ ...base, NODE_ENV: 'production', STORAGE_DRIVER: 's3', S3_BUCKET: 'b', SCANNER_DRIVER: 'clamav', MAIL_DRIVER: 'smtp', SMTP_URL: 'smtp://h', MAIL_FROM: 'a@b.test' });
    expect(ok.STORAGE_DRIVER).toBe('s3');
    expect(() => loadConfig({ ...base, STORAGE_DRIVER: 's3' })).toThrow(/S3_BUCKET/);
    expect(() => loadConfig({ ...base, MAIL_DRIVER: 'smtp' })).toThrow(/SMTP_URL/);
  });
});
