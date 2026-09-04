import { createHmac, timingSafeEqual } from 'crypto';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { createLogger } from '@libs/core/log/logger';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';

export type RawBodyRequest = Request & { rawBody?: Buffer };

type ValidationMode = 'disabled' | 'when-configured' | 'required';

export interface WebhookSignatureValidation {
    valid: boolean;
    reason?: 'missing-secret' | 'missing-signature' | 'invalid-signature';
}

const PLATFORM_SECRET_KEYS: Partial<Record<PlatformType, string>> = {
    [PlatformType.GITHUB]: 'GITHUB_WEBHOOK_SECRET',
    [PlatformType.GITLAB]: 'GITLAB_WEBHOOK_SECRET',
    [PlatformType.BITBUCKET]: 'BITBUCKET_WEBHOOK_SECRET',
    [PlatformType.FORGEJO]: 'FORGEJO_WEBHOOK_SECRET',
};

/**
 * Verifies provider webhook signatures before a payload is acknowledged.
 *
 * Validation is disabled by default so configuring a secret cannot
 * accidentally reject deliveries from existing hooks that have not been
 * reprovisioned yet. Operators must sync the secret to every provider hook
 * before explicitly selecting `required` (or the legacy `when-configured`
 * mode).
 */
@Injectable()
export class WebhookSignatureService {
    private readonly logger = createLogger(WebhookSignatureService.name);
    private readonly warnedMissingSecrets = new Set<PlatformType>();

    constructor(private readonly configService: ConfigService) {}

    validate(
        platformType: PlatformType,
        req: RawBodyRequest,
    ): WebhookSignatureValidation {
        if (platformType === PlatformType.AZURE_REPOS) {
            // Azure Repos uses the encrypted query-token flow in its controller.
            return { valid: true };
        }

        const mode = this.validationMode();
        if (mode === 'disabled') {
            return { valid: true };
        }

        const secret = this.secretFor(platformType);
        if (!secret) {
            if (mode === 'required') {
                return { valid: false, reason: 'missing-secret' };
            }

            if (!this.warnedMissingSecrets.has(platformType)) {
                this.warnedMissingSecrets.add(platformType);
                this.logger.warn({
                    message: `Webhook signature validation is not configured for ${platformType}`,
                    context: WebhookSignatureService.name,
                    metadata: { platformType, mode },
                });
            }
            return { valid: true };
        }

        const provided = this.signatureFor(platformType, req);
        if (!provided) {
            return { valid: false, reason: 'missing-signature' };
        }

        if (platformType === PlatformType.GITLAB) {
            const valid = this.safeEqual(provided, secret);
            return {
                valid,
                reason: valid ? undefined : 'invalid-signature',
            };
        }

        if (!req.rawBody) {
            return { valid: false, reason: 'invalid-signature' };
        }

        const digest = createHmac('sha256', secret)
            .update(req.rawBody)
            .digest('hex');
        const normalized = provided.startsWith('sha256=')
            ? provided.slice('sha256='.length)
            : provided;
        const valid = this.safeEqual(normalized.toLowerCase(), digest);

        return {
            valid,
            reason: valid ? undefined : 'invalid-signature',
        };
    }

    private validationMode(): ValidationMode {
        const raw = this.configService
            .get<string>('WEBHOOK_SIGNATURE_VALIDATION_MODE')
            ?.trim()
            .toLowerCase();

        if (
            raw === 'disabled' ||
            raw === 'when-configured' ||
            raw === 'required'
        ) {
            return raw;
        }
        return 'disabled';
    }

    private secretFor(platformType: PlatformType): string | undefined {
        const providerKey = PLATFORM_SECRET_KEYS[platformType];
        const value =
            (providerKey
                ? this.configService.get<string>(providerKey)
                : undefined) ||
            this.configService.get<string>(
                'CODE_MANAGEMENT_WEBHOOK_SIGNATURE_SECRET',
            );

        return value?.trim() || undefined;
    }

    private signatureFor(
        platformType: PlatformType,
        req: RawBodyRequest,
    ): string | undefined {
        const header = (name: string) => {
            const value = req.headers[name];
            return Array.isArray(value) ? value[0] : value;
        };

        switch (platformType) {
            case PlatformType.GITHUB:
                return header('x-hub-signature-256');
            case PlatformType.GITLAB:
                return header('x-gitlab-token');
            case PlatformType.BITBUCKET:
                return header('x-hub-signature');
            case PlatformType.FORGEJO:
                return (
                    header('x-forgejo-signature') ||
                    header('x-gitea-signature') ||
                    header('x-gogs-signature') ||
                    header('x-hub-signature-256')
                );
            default:
                return undefined;
        }
    }

    private safeEqual(left: string, right: string): boolean {
        const leftBuffer = Buffer.from(left);
        const rightBuffer = Buffer.from(right);
        return (
            leftBuffer.length === rightBuffer.length &&
            timingSafeEqual(leftBuffer, rightBuffer)
        );
    }
}
