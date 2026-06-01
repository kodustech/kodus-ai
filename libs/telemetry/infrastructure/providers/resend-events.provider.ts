import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class ResendEventsProvider {
    private readonly logger = createLogger(ResendEventsProvider.name);
    private client: Resend | null = null;

    constructor(private readonly configService: ConfigService) {}

    get isEnabled(): boolean {
        return !!this.configService.get<string>('RESEND_API_KEY');
    }

    private getClient(): Resend | null {
        if (this.client) return this.client;

        const apiKey = this.configService.get<string>('RESEND_API_KEY');
        if (!apiKey) return null;

        this.client = new Resend(apiKey);
        return this.client;
    }

    async send(
        event: string,
        email: string,
        payload: Record<string, unknown> = {},
    ): Promise<void> {
        const client = this.getClient();
        if (!client) return;

        try {
            const { error } = await client.events.send({
                event,
                email,
                payload,
            });

            if (error) {
                this.logger.warn({
                    message: `Resend events.send failed for "${event}"`,
                    context: ResendEventsProvider.name,
                    metadata: {
                        event,
                        email,
                        error: error.message,
                    },
                });
            }
        } catch (error) {
            this.logger.warn({
                message: `Resend events.send threw for "${event}"`,
                context: ResendEventsProvider.name,
                metadata: {
                    event,
                    email,
                    error: error instanceof Error ? error.message : String(error),
                },
            });
        }
    }
}
