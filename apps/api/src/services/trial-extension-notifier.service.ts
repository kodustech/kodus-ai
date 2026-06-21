import { Injectable } from '@nestjs/common';

import { createLogger } from '@kodus/flow';

export type TrialExtensionRequestPayload = {
    organizationId?: string;
    organizationName?: string;
    teamId?: string;
    requestedByEmail?: string;
    teamSize?: number;
    message?: string;
};

export type TrialExtensionNotifyResult = {
    success: boolean;
    message?: string;
};

/**
 * Posts "Request more trial reviews" submissions to our Discord via an
 * incoming webhook. The webhook URL is a secret and lives only in the API
 * env (API_DISCORD_TRIAL_REQUEST_WEBHOOK_URL) — it never reaches the browser.
 *
 * When the webhook is not configured we fail honestly (success:false) so the
 * UI can tell the user instead of pretending the request was delivered.
 */
@Injectable()
export class TrialExtensionNotifierService {
    private readonly logger = createLogger(TrialExtensionNotifierService.name);

    async notify(
        payload: TrialExtensionRequestPayload,
    ): Promise<TrialExtensionNotifyResult> {
        const webhookUrl = process.env.API_DISCORD_TRIAL_REQUEST_WEBHOOK_URL;

        if (!webhookUrl) {
            this.logger.warn({
                message:
                    'Trial extension request received but Discord webhook is not configured',
                context: TrialExtensionNotifierService.name,
                metadata: { organizationId: payload.organizationId },
            });

            return {
                success: false,
                message: 'Trial request channel is not configured yet.',
            };
        }

        const note = (payload.message ?? '').trim().slice(0, 1500);
        const lines = [
            '**New trial extension request**',
            `**Org:** ${payload.organizationName ?? '—'} (${payload.organizationId ?? '—'})`,
            `**Team:** ${payload.teamId ?? '—'}`,
            `**Requested by:** ${payload.requestedByEmail ?? '—'}`,
            typeof payload.teamSize === 'number'
                ? `**Team size:** ${payload.teamSize}`
                : null,
            note ? `**Message:** ${note}` : null,
        ].filter(Boolean);

        try {
            const res = await fetch(webhookUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: lines.join('\n') }),
            });

            if (!res.ok) {
                throw new Error(`Discord webhook responded ${res.status}`);
            }

            return { success: true };
        } catch (error) {
            this.logger.error({
                message: 'Failed to deliver trial extension request to Discord',
                context: TrialExtensionNotifierService.name,
                error,
                metadata: { organizationId: payload.organizationId },
            });

            return {
                success: false,
                message: 'Could not deliver the request.',
            };
        }
    }
}
