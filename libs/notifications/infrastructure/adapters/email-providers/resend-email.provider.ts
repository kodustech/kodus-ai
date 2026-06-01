import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

import { IEmailProvider, SendEmailPayload } from './email-provider.contract';

/**
 * Resend transport. Designed to be safe to instantiate without
 * RESEND_API_KEY set so the app boots on self-hosted installs where
 * notifications aren't configured. The first call to send() will
 * throw with a clear error if the key is still missing.
 *
 * Cloud always has RESEND_API_KEY in production; self-hosted may or
 * may not — both cases must boot.
 */
@Injectable()
export class ResendEmailProvider implements IEmailProvider {
    private readonly logger = createLogger(ResendEmailProvider.name);
    private client: Resend | null = null;

    constructor(private readonly configService: ConfigService) {
        // Defer Resend instantiation to first send() — see class doc.
        const apiKey = this.configService.get<string>('RESEND_API_KEY');
        if (!apiKey) {
            this.logger.warn({
                message:
                    'RESEND_API_KEY is not set — email sending is disabled. ' +
                    'Set RESEND_API_KEY in your environment to enable.',
                context: ResendEmailProvider.name,
            });
        }
    }

    private getClient(): Resend {
        if (!this.client) {
            const apiKey = this.configService.get<string>('RESEND_API_KEY');
            if (!apiKey) {
                throw new Error(
                    'Cannot send email: RESEND_API_KEY is not configured. ' +
                        'Set it in your environment to enable notifications.',
                );
            }
            this.client = new Resend(apiKey);
        }
        return this.client;
    }

    async send(input: SendEmailPayload): Promise<{ id: string }> {
        const result = await this.getClient().emails.send({
            from: input.from,
            to: input.to,
            subject: input.subject,
            html: input.html,
            replyTo: input.replyTo,
        });

        if (result.error) {
            throw new Error(
                `Resend send failed: ${result.error.name} — ${result.error.message}`,
            );
        }

        return { id: result.data?.id ?? 'unknown' };
    }
}
