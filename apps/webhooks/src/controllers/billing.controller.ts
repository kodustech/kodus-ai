import { createHmac, timingSafeEqual } from 'crypto';

import { createLogger } from '@libs/core/log/logger';
import { Controller, HttpStatus, Post, Req, Res } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request, Response } from 'express';

import { Public } from '@libs/identity/infrastructure/adapters/services/auth/public.decorator';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';

/**
 * Express request shape with the raw-body capture from
 * `apps/webhooks/src/main.ts` body-parser verify hook. The HMAC must
 * cover the bytes the billing service signed, not a re-stringified
 * copy of the parsed body (which would be subject to key ordering /
 * whitespace differences).
 */
type WebhookRequest = Request & { rawBody?: Buffer };

const SIGNATURE_HEADER = 'x-kodus-signature';

interface PaymentFailedBody {
    organizationId?: string;
    amount?: number;
    currency?: string;
    failureReason?: string;
    nextRetryAt?: string;
    updatePaymentUrl?: string;
}

interface TrialExpiringBody {
    organizationId?: string;
    trialEndsAt?: string;
    daysRemaining?: number;
    upgradeUrl?: string;
}

/**
 * Receives outbound notifications from kodus-service-billing.
 *
 * The billing service signs the raw request body with HMAC-SHA256
 * keyed by `API_BILLING_WEBHOOK_SECRET`. Invalid / missing signatures
 * return 401. Valid requests emit the corresponding notification with
 * `role:OWNER + role:BILLING_MANAGER` as the audience.
 *
 * The endpoint is intentionally tolerant of notification-side failures
 * — when `notificationService.emit` throws (outbox down, etc.) we
 * still return 200 so the billing service doesn't retry forever. The
 * failure is logged for ops; the billing state is already committed
 * upstream regardless.
 */
@Public()
@Controller('billing/webhook')
export class BillingController {
    private readonly logger = createLogger(BillingController.name);

    constructor(
        private readonly notificationService: NotificationService,
        private readonly configService: ConfigService,
    ) {}

    @Post('/payment-failed')
    async paymentFailed(
        @Req() req: WebhookRequest,
        @Res() res: Response,
    ): Promise<Response> {
        const verification = this.verifySignature(req);
        if (verification.status !== 'ok') {
            return res.status(verification.status).send(verification.reason);
        }

        const body = req.body as PaymentFailedBody;
        if (!body?.organizationId) {
            return res
                .status(HttpStatus.BAD_REQUEST)
                .send('Missing organizationId');
        }

        await this.safeEmit(() =>
            this.notificationService.emit({
                event: NotificationEvent.BILLING_PAYMENT_FAILED,
                payload: {
                    amount: body.amount ?? 0,
                    currency: body.currency ?? '',
                    failureReason:
                        body.failureReason ?? 'Unknown payment failure',
                    nextRetryAt: body.nextRetryAt,
                    updatePaymentUrl: body.updatePaymentUrl,
                },
                organizationId: body.organizationId,
            }),
        );

        return res.status(HttpStatus.OK).send('ok');
    }

    @Post('/trial-expiring')
    async trialExpiring(
        @Req() req: WebhookRequest,
        @Res() res: Response,
    ): Promise<Response> {
        const verification = this.verifySignature(req);
        if (verification.status !== 'ok') {
            return res.status(verification.status).send(verification.reason);
        }

        const body = req.body as TrialExpiringBody;
        if (!body?.organizationId) {
            return res
                .status(HttpStatus.BAD_REQUEST)
                .send('Missing organizationId');
        }

        await this.safeEmit(() =>
            this.notificationService.emit({
                event: NotificationEvent.BILLING_TRIAL_EXPIRING,
                payload: {
                    trialEndsAt: body.trialEndsAt ?? '',
                    daysRemaining: body.daysRemaining ?? 0,
                    upgradeUrl: body.upgradeUrl,
                },
                organizationId: body.organizationId,
            }),
        );

        return res.status(HttpStatus.OK).send('ok');
    }

    /**
     * Verifies the X-Kodus-Signature header against the raw request
     * body using HMAC-SHA256 with the shared secret. Constant-time
     * comparison so timing attacks can't enumerate valid bytes.
     */
    private verifySignature(
        req: WebhookRequest,
    ): { status: 'ok' } | { status: HttpStatus; reason: string } {
        const secret = this.configService.get<string>(
            'API_BILLING_WEBHOOK_SECRET',
        );
        if (!secret) {
            this.logger.error({
                message:
                    'API_BILLING_WEBHOOK_SECRET is not configured — refusing billing webhook',
                context: BillingController.name,
            });
            return {
                status: HttpStatus.INTERNAL_SERVER_ERROR,
                reason: 'Webhook secret not configured',
            };
        }

        const provided = req.headers[SIGNATURE_HEADER] as string | undefined;
        if (!provided) {
            return {
                status: HttpStatus.UNAUTHORIZED,
                reason: 'Missing signature',
            };
        }

        const rawBody =
            req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {}));
        const expected = createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex');

        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            return {
                status: HttpStatus.UNAUTHORIZED,
                reason: 'Invalid signature',
            };
        }

        return { status: 'ok' };
    }

    /**
     * Wrap the emit so notification-side failures never propagate to
     * the billing service. If emit throws, we log and return — the
     * caller (Stripe → billing → us) sees a 200 and won't retry.
     */
    private async safeEmit(fn: () => Promise<void>): Promise<void> {
        try {
            await fn();
        } catch (error) {
            this.logger.error({
                message: 'Failed to emit billing notification',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: BillingController.name,
            });
        }
    }
}
