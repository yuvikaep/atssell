import type { Transporter } from 'nodemailer';
import type { FeedbackRequestEmail, InvitationEmail, Mailer, NoticeEmail, PasswordResetEmail } from '../mailer.js';

const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
const when = (d: Date | null) => (d ? d.toUTCString() : 'a time to be confirmed');

/** Sends plain-text email over SMTP. Subjects are flattened to one line so user text cannot add headers. */
export class SmtpMailer implements Mailer {
  constructor(private readonly transport: Pick<Transporter, 'sendMail'>, private readonly from: string) {}

  private send(to: string, subject: string, text: string) {
    return this.transport.sendMail({ from: this.from, to, subject: oneLine(subject), text }).then(() => undefined);
  }

  sendInvitation(e: InvitationEmail) {
    return this.send(e.to, `You're invited to ${e.companyName} on JobsMato`,
      `${e.inviterName} invited you to join ${e.companyName} on JobsMato as ${e.roleName}.\n\nAccept the invitation: ${e.link}\n\nThe link works once and expires ${e.expiresAt.toUTCString()}.\n`);
  }

  sendPasswordReset(e: PasswordResetEmail) {
    return this.send(e.to, `Reset your JobsMato password for ${e.companyName}`,
      `Someone asked to reset your password for ${e.companyName}.\n\nChoose a new password: ${e.link}\n\nThe link works once and expires ${e.expiresAt.toUTCString()}. If this was not you, ignore this email.\n`);
  }

  sendFeedbackRequest(e: FeedbackRequestEmail) {
    return this.send(e.to, `Feedback requested: ${e.candidateName} for ${e.jobTitle} (${e.roundName})`,
      `Hello ${e.interviewerName},\n\nPlease share your feedback on ${e.candidateName} for ${e.jobTitle} (${e.roundName}), interviewed ${when(e.scheduledStart)}.\n\nGive feedback: ${e.link}\n\nThis link is personal to you and expires ${e.expiresAt.toUTCString()}. Do not forward it.\n`);
  }

  sendNotice(e: NoticeEmail) {
    return this.send(e.to, e.subject, `${e.text}${e.link ? `\n\nOpen: ${e.link}\n` : '\n'}`);
  }
}
