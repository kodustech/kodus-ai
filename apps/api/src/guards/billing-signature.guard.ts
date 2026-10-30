import { createHmac, timingSafeEqual } from 'crypto';

import {
    CanActivate,
    ExecutionContext,
    Injectable,
    InternalServerErrorException,
    UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

import {
    BILLING_SIGNATURE_HEADER,
    BILLING_TIMESTAMP_HEADER,
    billingSignaturePayload,
} from '@libs/common/utils/billing-signature';
import { createLogger } from '@libs/core/log/logger';

/** Request with the exact bytes captured by the raw-body parser mounted on
 *  the billing route in `apps/api/src/main.ts`. */
export type BillingCallbackRequest = Request & { rawBody?: Buffer };

/** How far a callback's timestamp may be from our clock, either direction.
 *  Same window billing enforces on the calls it receives. */
export const BILLING_SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * Authenticates kodus-service-billing callbacks with the scheme both
 * directions share (`libs/common/utils/billing-signature.ts`, and
 * `src/config/utils/serviceToken.ts` in billing): HMAC-SHA256 keyed by
 * `API_BILLING_WEBHOOK_SECRET` over `METHOD\n/path\n<query>\n<timestamp>\n<raw body>`.
 *
 * - method + path: a signature captured on one route cannot be replayed on
 *   another;
 * - timestamp (5-minute window): a leaked signature stops working;
 * - raw body bytes as received, never a re-serialization of the parsed body.
 *
 * Fails closed: no secret or no captured raw body is a 500
 * (misconfiguration); a missing, stale or wrong signature is a 401.
 */
@Injectable()
export class BillingSignatureGuard implements CanActivate {
    private readonly logger = createLogger(BillingSignatureGuard.name);

    constructor(private readonly configService: ConfigService) {}

    canActivate(context: ExecutionContext): boolean {
        const req = context
            .switchToHttp()
            .getRequest<BillingCallbackRequest>();
        const organizationId = req.body?.organizationId;

        const secret = this.configService.get<string>(
            'API_BILLING_WEBHOOK_SECRET',
        );
        if (!secret) {
            this.logger.error({
                message:
                    'API_BILLING_WEBHOOK_SECRET is not configured — refusing billing webhook',
                context: BillingSignatureGuard.name,
                metadata: { organizationId },
            });
            throw new InternalServerErrorException(
                'Webhook secret not configured',
            );
        }

        const provided = req.headers[BILLING_SIGNATURE_HEADER] as
            | string
            | undefined;
        if (!provided) {
            throw new UnauthorizedException('Missing signature');
        }

        const timestamp = String(
            req.headers[BILLING_TIMESTAMP_HEADER] ?? '',
        ).trim();
        const timestampMs = Number(timestamp);
        if (
            !timestamp ||
            !Number.isFinite(timestampMs) ||
            Math.abs(Date.now() - timestampMs) > BILLING_SIGNATURE_MAX_SKEW_MS
        ) {
            // Billing does not retry a 401, so the reason must be diagnosable
            // (a dropped header or clock skew between the two deployments).
            this.logger.warn({
                message:
                    'Rejected a billing callback: missing or stale timestamp',
                context: BillingSignatureGuard.name,
                metadata: {
                    organizationId,
                    method: req.method,
                    path: req.originalUrl,
                    skewMs: Number.isFinite(timestampMs)
                        ? Date.now() - timestampMs
                        : null,
                },
            });
            throw new UnauthorizedException('Missing or stale timestamp');
        }

        const rawBody = req.rawBody;
        if (!rawBody) {
            this.logger.error({
                message:
                    'Raw body not captured for a billing callback — check the billing parser mount in apps/api/src/main.ts',
                context: BillingSignatureGuard.name,
                metadata: { organizationId },
            });
            throw new InternalServerErrorException('Raw body not captured');
        }

        // Full path as the caller addressed it; split on the FIRST "?" only.
        const target = req.originalUrl || req.url;
        const mark = target.indexOf('?');
        const expected = createHmac('sha256', secret)
            .update(
                billingSignaturePayload({
                    method: req.method,
                    path: mark === -1 ? target : target.slice(0, mark),
                    query: mark === -1 ? '' : target.slice(mark + 1),
                    timestamp,
                    rawBody: rawBody.toString('utf8'),
                }),
            )
            .digest('hex');

        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            throw new UnauthorizedException('Invalid signature');
        }

        return true;
    }
}
