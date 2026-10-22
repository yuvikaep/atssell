# Email

RMS sends invitations, password resets, interview feedback requests and notifications by email.
Until email is set up, invitation and feedback links are shown in the app to copy instead.

| Setting | Development default | Production default |
|---|---|---|
| `MAIL_DRIVER` | `console`: emails are printed to the API console (`[dev-mail]` lines) | `off`: nothing is sent |

Set `MAIL_DRIVER=smtp` to send real email through an SMTP server.

## Gmail with an app password

1. **Turn on 2-Step Verification** for the Google account that will send the email:
   <https://myaccount.google.com/signinoptions/two-step-verification>. App passwords need it.
2. **Create an app password**: <https://myaccount.google.com/apppasswords>. Name it "RMS".
   Google shows 16 letters in four groups. Copy them; they are shown only once.
   This is not your Google password, and it only works for this account's mail.
3. **Add the settings** to `.env` (local) or to the Vercel project's environment variables (production):

   ```bash
   MAIL_DRIVER=smtp
   SMTP_HOST=smtp.gmail.com
   SMTP_PORT=465
   SMTP_USER=you@gmail.com
   SMTP_PASSWORD=abcd efgh ijkl mnop      # the app password; spaces are fine, they are removed
   # MAIL_FROM="Acme Hiring <you@gmail.com>"   # optional, defaults to "RMS <SMTP_USER>"
   ```

4. **Restart the API**, then send yourself a test email:

   ```bash
   npm run -w server mail:test -- --to you@example.com
   ```

   It signs in to Gmail first and says plainly if the user name or app password is wrong.

### Things to know about Gmail

- **From address.** Gmail sends only as the signed-in account, or as an address you have added
  under Gmail → Settings → Accounts → "Send mail as". Any other `MAIL_FROM` is replaced with the account's address.
- **Daily limit.** A personal Gmail account can send about 500 emails a day; Google Workspace about 2,000.
  Above that Gmail refuses mail for up to a day. Failed sends are retried (see docs/RUNBOOK.md).
  For a large rollout, use a sending service (Amazon SES, Postmark, SendGrid, Brevo): the same `SMTP_*` settings work.
- **Revoking.** Deleting the app password in the Google account stops RMS sending at once; your Google password is unaffected.
  If the account's Google password is changed, Google revokes its app passwords, so create a new one.
- **Keep the app password secret.** It goes in `.env` (not committed) or Vercel's encrypted environment variables, never in the repository.

## Any other SMTP server

Use the same settings with the provider's host, port, user and password. Port 465 uses TLS from the start;
any other port (usually 587) must upgrade with STARTTLS, and the password is never sent without TLS.

Alternatively, one URL: `SMTP_URL=smtps://user:password@host:465` with `MAIL_FROM` set. Characters such as `@`
in the user name must then be URL-encoded (`%40`), which is why the separate settings are easier.
