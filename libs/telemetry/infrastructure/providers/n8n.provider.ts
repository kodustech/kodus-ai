import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Forwards lifecycle events to an n8n webhook for routing (Discord, Slack,
 * warehouse writes, etc.). Fire-and-forget: on failure we log and move on so
 * the signup/review flow is never blocked.
 *
 * Env precedence: `N8N_WEBHOOK_URL` (current) → `API_SIGNUP_NOTIFICATION_WEBHOOK`
 * (legacy, kept for compat while the old name is phased out of prod env).
 */
@Injectable()
export class N8nProvider {
    private readonly logger = createLogger(N8nProvider.name);

    constructor(private readonly configService: ConfigService) {
        const url = this.getUrl();
        if (url) {
            const source = this.configService.get<string>('N8N_WEBHOOK_URL')
                ? 'N8N_WEBHOOK_URL'
                : 'API_SIGNUP_NOTIFICATION_WEBHOOK (legacy fallback)';
            this.logger.log({
                message: `N8nProvider initialized → ${url} (from ${source})`,
                context: N8nProvider.name,
            });
        } else {
            this.logger.log({
                message:
                    'N8nProvider initialized — disabled (no N8N_WEBHOOK_URL / API_SIGNUP_NOTIFICATION_WEBHOOK)',
                context: N8nProvider.name,
            });
        }
    }

    private getUrl(): string | null {
        return (
            this.configService.get<string>('N8N_WEBHOOK_URL') ||
            this.configService.get<string>('API_SIGNUP_NOTIFICATION_WEBHOOK') ||
            null
        );
    }

    get isEnabled(): boolean {
        return !!this.getUrl();
    }

    async notify(
        eventId: string,
        props: Record<string, unknown>,
    ): Promise<void> {
        const url = this.getUrl();
        if (!url) return;

        const body = JSON.stringify({
            eventId,
            props,
            timestamp: new Date().toISOString(),
        });

        const attempts = 2;
        for (let i = 0; i < attempts; i++) {
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (response.ok) return;

                if (i < attempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }

                this.logger.warn({
                    message: `n8n webhook returned ${response.status} for "${eventId}"`,
                    context: N8nProvider.name,
                    metadata: { eventId, status: response.status },
                });
            } catch (error) {
                if (i < attempts - 1) {
                    await new Promise((resolve) => setTimeout(resolve, 500));
                    continue;
                }
                this.logger.warn({
                    message: `n8n webhook threw for "${eventId}"`,
                    context: N8nProvider.name,
                    metadata: {
                        eventId,
                        error:
                            error instanceof Error
                                ? error.message
                                : String(error),
                    },
                });
            }
        }
    }
}
