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

import { createLogger } from '@libs/core/log/logger';

/** Request with the exact bytes captured by the raw-body parser mounted on
 *  the billing route in `apps/api/src/main.ts`. */
export type BillingCallbackRequest = Request & { rawBody?: Buffer };

export const BILLING_SIGNATURE_HEADER = 'x-kodus-signature';

/**
 * Authenticates kodus-service-billing callbacks: HMAC-SHA256 of the raw
 * request body keyed by `API_BILLING_WEBHOOK_SECRET`, in `x-kodus-signature`.
 * Compared in constant time so timing cannot enumerate valid bytes.
 *
 * Fails closed: no secret or no captured raw body is a 500 (misconfiguration,
 * never a re-serialized body that may differ from what billing signed); a
 * missing or wrong signature is a 401.
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

        const expected = createHmac('sha256', secret)
            .update(rawBody)
            .digest('hex');
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !timingSafeEqual(a, b)) {
            throw new UnauthorizedException('Invalid signature');
        }

        return true;
    }
}
