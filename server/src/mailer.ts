import { AppError } from './errors.js';

export interface InvitationEmail {
  to: string;
  companyName: string;
  inviterName: string;
  roleName: string;
  link: string;
  expiresAt: Date;
}

export interface PasswordResetEmail {
  to: string;
  companyName: string;
  link: string;
  expiresAt: Date;
}

export interface FeedbackRequestEmail {
  to: string;
  interviewerName: string;
  candidateName: string;
  jobTitle: string;
  roundName: string;
  scheduledStart: Date | null;
  link: string;
  expiresAt: Date;
}

/** A plain notice: reminders, "feedback submitted", approvals. Links go to the app, never carry a token. */
export interface NoticeEmail {
  to: string;
  subject: string;
  text: string;
  link?: string;
}

export interface Mailer {
  sendInvitation(email: InvitationEmail): Promise<void>;
  sendPasswordReset(email: PasswordResetEmail): Promise<void>;
  sendFeedbackRequest(email: FeedbackRequestEmail): Promise<void>;
  sendNotice(email: NoticeEmail): Promise<void>;
}

/**
 * Development mailer: prints emails to the API console so links can be clicked locally.
 * Refuses to run in production, where links contain live tokens. AWS SES replaces it before pilot.
 */
export class ConsoleMailer implements Mailer {
  constructor(nodeEnv: string) {
    if (nodeEnv === 'production') {
      throw new Error('ConsoleMailer must not be used in production; configure an email provider');
    }
  }

  async sendInvitation(e: InvitationEmail) {
    this.print(e.to, `You're invited to ${e.companyName} on JobsMato as ${e.roleName}`, e.link);
  }

  async sendPasswordReset(e: PasswordResetEmail) {
    this.print(e.to, `Reset your JobsMato password for ${e.companyName}`, e.link);
  }

  async sendFeedbackRequest(e: FeedbackRequestEmail) {
    this.print(e.to, `Feedback requested: ${e.candidateName} for ${e.jobTitle} (${e.roundName})`, e.link);
  }

  async sendNotice(e: NoticeEmail) {
    this.print(e.to, e.subject, e.link ?? '(no link)');
  }

  private print(to: string, subject: string, link: string) {
    console.log(`\n[dev-mail] To: ${to}\n[dev-mail] Subject: ${subject}\n[dev-mail] Link: ${link}\n`);
  }
}

/**
 * MAIL_DRIVER=off: no email provider is configured. Sending fails with a clear message (the invitation
 * or link already exists and can be resent later). A password reset is dropped silently instead, so the
 * response does not reveal whether the account exists.
 */
export class OffMailer implements Mailer {
  async sendInvitation(): Promise<void> {
    throw emailNotConfigured();
  }

  async sendPasswordReset(e: PasswordResetEmail) {
    console.warn(`[mail-off] password reset email not sent (MAIL_DRIVER=off) for ${e.companyName}`);
  }

  async sendFeedbackRequest(): Promise<void> {
    throw emailNotConfigured();
  }

  async sendNotice(): Promise<void> {
    throw emailNotConfigured();
  }
}

const emailNotConfigured = () =>
  new AppError(503, 'EMAIL_NOT_CONFIGURED', 'Email is not set up on this server yet, so nothing was sent. You can resend once it is configured.');

/** Test mailer: keeps sent emails in memory. */
export class MemoryMailer implements Mailer {
  invitations: InvitationEmail[] = [];
  resets: PasswordResetEmail[] = [];
  feedbackRequests: FeedbackRequestEmail[] = [];
  notices: NoticeEmail[] = [];
  /** Set to make every send fail, to exercise retry and fallback paths. */
  failing = false;

  async sendInvitation(e: InvitationEmail) {
    this.maybeFail();
    this.invitations.push(e);
  }

  async sendPasswordReset(e: PasswordResetEmail) {
    this.maybeFail();
    this.resets.push(e);
  }

  async sendFeedbackRequest(e: FeedbackRequestEmail) {
    this.maybeFail();
    this.feedbackRequests.push(e);
  }

  async sendNotice(e: NoticeEmail) {
    this.maybeFail();
    this.notices.push(e);
  }

  private maybeFail() {
    if (this.failing) throw new Error('mail provider unavailable');
  }
}

/**
 * While email is off, the inviter is shown the invitation link to pass on themselves (as with
 * feedback links). With SMTP on, the link only goes to the invitee's inbox.
 */
export function inviteLinkToCopy(config: { MAIL_DRIVER: string; WEB_ORIGIN: string }, token: string) {
  return config.MAIL_DRIVER === 'smtp' ? null : `${config.WEB_ORIGIN}/invite#${token}`;
}
