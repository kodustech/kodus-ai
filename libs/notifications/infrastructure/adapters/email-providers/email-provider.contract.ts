export interface SendEmailPayload {
    from: string;
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
}

/**
 * Abstraction over the actual email transport.
 * Cloud uses Resend; self-hosted uses SMTP.
 */
export interface IEmailProvider {
    send(input: SendEmailPayload): Promise<{ id: string }>;
}

export const EMAIL_PROVIDER_TOKEN = Symbol.for('EmailProvider');
