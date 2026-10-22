// Checks the SMTP settings in .env: signs in to the mail server, then sends one test email.
// Usage: npm run -w server mail:test -- --to you@example.com
import { parseArgs } from 'node:util';
import nodemailer from 'nodemailer';
import { loadConfig } from '../src/config.js';
import { smtpTransportOptions } from '../src/providers/index.js';
import { SmtpMailer } from '../src/providers/smtp.js';

const { values } = parseArgs({ options: { to: { type: 'string' } } });
if (!values.to) { console.error('Usage: mail:test -- --to <email address>'); process.exit(1); }

const config = loadConfig();
if (config.MAIL_DRIVER !== 'smtp') {
  console.error(`MAIL_DRIVER is "${config.MAIL_DRIVER}". Set MAIL_DRIVER=smtp and the SMTP settings in .env (see docs/EMAIL.md).`);
  process.exit(1);
}

const transport = nodemailer.createTransport(smtpTransportOptions(config));
try {
  await transport.verify();
  console.log(`Signed in to ${config.SMTP_URL ? 'the SMTP_URL server' : `${config.SMTP_HOST}:${config.SMTP_PORT} as ${config.SMTP_USER}`}.`);
  await new SmtpMailer(transport, config.MAIL_FROM!).sendNotice({
    to: values.to,
    subject: 'RMS test email',
    text: `This is a test email from RMS, sent from ${config.MAIL_FROM}. If you can read it, email is set up.`,
    link: config.WEB_ORIGIN,
  });
  console.log(`Sent a test email to ${values.to} from ${config.MAIL_FROM}.`);
} catch (err) {
  const e = err as { code?: string; responseCode?: number; message: string };
  console.error(`Sending failed: ${e.message}`);
  if (e.responseCode === 535 || e.code === 'EAUTH') {
    console.error('The server refused the user name or password. For Gmail, SMTP_PASSWORD must be an app password (16 letters), not your Google password, and 2-Step Verification must be on.');
  }
  process.exitCode = 1;
} finally {
  transport.close();
}
