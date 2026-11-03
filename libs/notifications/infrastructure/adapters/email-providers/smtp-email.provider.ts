import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { IEmailProvider, SendEmailPayload } from './email-provider.contract';
import { Address } from 'nodemailer/lib/mailer';
import { createTransport, Transporter } from 'nodemailer';

const DEFAULT_FROM = 'noreply@notifications.kodus.io';

/**
 * SMTP email provider using nodemailer.
 */
@Injectable()
export class SmtpEmailProvider implements IEmailProvider {
    private readonly logger = createLogger(SmtpEmailProvider.name);
    private transporter: Transporter | null = null;
    private readonly configuredFrom: string | undefined;

    constructor(private readonly configService: ConfigService) {
        this.configuredFrom =
            configService.get<string>('API_SMTP_FROM')?.trim() || undefined;
    }

    /**
     * Templates always pass the Kodus cloud sender in `payload.from`. On
     * self-hosted SMTP the operator's API_SMTP_FROM must win: most servers
     * reject or rewrite a sender the authenticated account doesn't own.
     * The template's display name ("Kody from Kodus") is kept.
     */
    private resolveFrom(payloadFrom: string | undefined): string | Address {
        if (!this.configuredFrom) return payloadFrom || DEFAULT_FROM;
        if (this.configuredFrom.includes('<')) return this.configuredFrom;

        const name = payloadFrom?.match(/^\s*"?([^"<]*?)"?\s*<[^>]*>\s*$/)?.[1];
        return name
            ? { name, address: this.configuredFrom }
            : this.configuredFrom;
    }

    private async getTransporter(): Promise<Transporter> {
        if (this.transporter) return this.transporter;

        this.transporter = createTransport({
            host: this.configService.get<string>('API_SMTP_HOST'),
            port: parseInt(
                this.configService.get<string>('API_SMTP_PORT', '587'),
                10,
            ),
            secure:
                this.configService.get<string>('API_SMTP_SECURE') === 'true',
            auth: {
                user: this.configService.get<string>('API_SMTP_USER'),
                pass: this.configService.get<string>('API_SMTP_PASS'),
            },
        });

        return this.transporter;
    }

    async send(payload: SendEmailPayload): Promise<{ id: string }> {
        try {
            const transport = await this.getTransporter();
            const info = await transport.sendMail({
                from: this.resolveFrom(payload.from),
                to: payload.to,
                subject: payload.subject,
                html: payload.html,
                replyTo: payload.replyTo,
            });

            this.logger.log({
                message: 'Email sent via SMTP',
                context: SmtpEmailProvider.name,
                metadata: {
                    to: payload.to,
                    subject: payload.subject,
                    messageId: info?.messageId,
                },
            });

            return { id: info?.messageId ?? '' };
        } catch (error) {
            this.logger.error({
                message: 'SMTP email send failed',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: SmtpEmailProvider.name,
                metadata: {
                    to: payload.to,
                    subject: payload.subject,
                },
            });
            throw error;
        }
    }
}
