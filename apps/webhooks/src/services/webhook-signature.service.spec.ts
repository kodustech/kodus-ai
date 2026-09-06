import { createHmac } from 'crypto';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { WebhookSignatureService } from './webhook-signature.service';

function serviceWith(values: Record<string, string | undefined>) {
    return new WebhookSignatureService({
        get: (key: string) => values[key],
    } as any);
}

function request(raw: string, headers: Record<string, string> = {}): any {
    return { rawBody: Buffer.from(raw), headers };
}

describe('WebhookSignatureService', () => {
    it('accepts a valid GitHub sha256 signature', () => {
        const raw = '{"ok":true}';
        const secret = 'secret';
        const signature = `sha256=${createHmac('sha256', secret)
            .update(raw)
            .digest('hex')}`;
        const service = serviceWith({
            WEBHOOK_SIGNATURE_VALIDATION_MODE: 'when-configured',
            GITHUB_WEBHOOK_SECRET: secret,
        });

        expect(
            service.validate(
                PlatformType.GITHUB,
                request(raw, { 'x-hub-signature-256': signature }),
            ),
        ).toEqual({ valid: true, reason: undefined });
    });

    it('rejects a missing signature when a secret is configured', () => {
        const service = serviceWith({
            WEBHOOK_SIGNATURE_VALIDATION_MODE: 'when-configured',
            GITLAB_WEBHOOK_SECRET: 'secret',
        });

        expect(service.validate(PlatformType.GITLAB, request('{}'))).toEqual({
            valid: false,
            reason: 'missing-signature',
        });
    });

    it('fails closed without a secret in required mode', () => {
        const service = serviceWith({
            WEBHOOK_SIGNATURE_VALIDATION_MODE: 'required',
        });

        expect(service.validate(PlatformType.FORGEJO, request('{}'))).toEqual({
            valid: false,
            reason: 'missing-secret',
        });
    });

    it('keeps legacy installations working when no mode is configured', () => {
        const service = serviceWith({});

        expect(service.validate(PlatformType.BITBUCKET, request('{}'))).toEqual(
            { valid: true },
        );
    });

    it('does not enforce a newly configured secret until rollout is enabled', () => {
        const service = serviceWith({ GITHUB_WEBHOOK_SECRET: 'new-secret' });

        expect(service.validate(PlatformType.GITHUB, request('{}'))).toEqual({
            valid: true,
        });
    });

    it('warns only once when validation is disabled with a configured secret', () => {
        const service = serviceWith({
            WEBHOOK_SIGNATURE_VALIDATION_MODE: 'invalid-mode',
            CODE_MANAGEMENT_WEBHOOK_SIGNATURE_SECRET: 'shared-secret',
        });
        const warn = jest
            .spyOn((service as any).logger, 'warn')
            .mockImplementation();

        service.validate(PlatformType.GITHUB, request('{}'));
        service.validate(PlatformType.GITHUB, request('{}'));

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                message:
                    'Webhook signature validation is disabled while one or more webhook secrets are configured',
                metadata: { mode: 'disabled' },
            }),
        );
    });
});
