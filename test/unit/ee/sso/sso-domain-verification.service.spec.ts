import { BadRequestException } from '@nestjs/common';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
    }),
}));

const mockEnvironment = {
    API_CLOUD_MODE: false,
    API_DEVELOPMENT_MODE: false,
};
jest.mock('@libs/ee/configs/environment', () => ({
    get environment() {
        return mockEnvironment;
    },
}));

import { SSODomainVerificationService } from '@libs/ee/sso/services/sso-domain-verification.service';

const buildCacheService = () => {
    const store = new Map<string, unknown>();
    return {
        addToCache: jest.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
        getFromCache: jest.fn(async (key: string) => store.get(key)),
        removeFromCache: jest.fn(async (key: string) => {
            store.delete(key);
        }),
        store,
    };
};

const buildNotifcationService = () => ({
    emit: jest.fn(async () => undefined),
});

const ORG = 'org-1';
const DOMAIN = 'acme.com';

describe('SSODomainVerificationService.requestDomainVerification', () => {
    let cacheService: ReturnType<typeof buildCacheService>;
    let notificationService: ReturnType<typeof buildNotifcationService>;
    let service: SSODomainVerificationService;

    beforeEach(() => {
        cacheService = buildCacheService();
        notificationService = buildNotifcationService();
        service = new SSODomainVerificationService(
            cacheService as any,
            notificationService as any,
        );
    });

    describe('cloud mode', () => {
        beforeEach(() => {
            mockEnvironment.API_CLOUD_MODE = true;
        });

        it('creates a verification token, sends an email, and returns sent:true when contact email belongs to the domain', async () => {
            const result = await service.requestDomainVerification({
                organizationId: ORG,
                organizationName: 'Acme',
                domain: DOMAIN,
                contactEmail: 'admin@acme.com',
            });

            expect(result).toEqual({
                domain: DOMAIN,
                contactEmail: 'admin@acme.com',
                sent: true,
            });

            // Email actually went out.
            expect(notificationService.emit).toHaveBeenCalledTimes(1);

            // Cache holds a *token* (pending state), not yet a verified status record.
            const tokenWrites = (
                cacheService.addToCache as jest.Mock
            ).mock.calls
                .map((c) => c[0] as string)
                .filter((k) => k.startsWith('sso:domain-verification:token:'));
            const statusWrites = (
                cacheService.addToCache as jest.Mock
            ).mock.calls
                .map((c) => c[0] as string)
                .filter((k) => k.startsWith('sso:domain-verification:status:'));
            expect(tokenWrites).toHaveLength(1);
            expect(statusWrites).toHaveLength(0);
        });

        it('rejects with 400 when contact email does not belong to the domain (David B-style guard)', async () => {
            await expect(
                service.requestDomainVerification({
                    organizationId: ORG,
                    organizationName: 'Acme',
                    domain: DOMAIN,
                    contactEmail: 'admin@somewhere-else.com',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(notificationService.emit).not.toHaveBeenCalled();
        });
    });

    describe('self-hosted mode', () => {
        beforeEach(() => {
            mockEnvironment.API_CLOUD_MODE = false;
        });

        it('auto-verifies the domain, skips the email send, and returns sent:false', async () => {
            const result = await service.requestDomainVerification({
                organizationId: ORG,
                organizationName: 'Acme',
                domain: DOMAIN,
                contactEmail: 'admin@acme.com',
            });

            expect(result).toEqual({
                domain: DOMAIN,
                contactEmail: 'admin@acme.com',
                sent: false,
            });

            // No outbound email — the whole point of the self-hosted skip.
            expect(notificationService.emit).not.toHaveBeenCalled();

            // Cache holds a *status* record (verified), not a pending token.
            const statusWrite = (
                cacheService.addToCache as jest.Mock
            ).mock.calls.find((c) =>
                (c[0] as string).startsWith('sso:domain-verification:status:'),
            );
            expect(statusWrite).toBeDefined();
            const [, record] = statusWrite!;
            expect(record).toMatchObject({
                domain: DOMAIN,
                verifiedByEmail: 'admin@acme.com',
            });
            expect(record.verifiedAt).toBeInstanceOf(Date);

            // Followup status query reflects the verification immediately.
            const status = await service.getDomainVerificationStatus({
                organizationId: ORG,
                domain: DOMAIN,
            });
            expect(status).toMatchObject({
                domain: DOMAIN,
                verifiedByEmail: 'admin@acme.com',
            });
        });

        it('accepts a contact email that does NOT belong to the domain (Dmitry/scorpion case)', async () => {
            // The admin running self-hosted often wants to use their own
            // work email even if the SSO domain belongs to another brand
            // they manage. Cloud rejects this; self-hosted should allow.
            const result = await service.requestDomainVerification({
                organizationId: ORG,
                organizationName: 'Acme',
                domain: DOMAIN,
                contactEmail: 'wellington@kodus.io',
            });

            expect(result.sent).toBe(false);
            expect(notificationService.emit).not.toHaveBeenCalled();
        });

        it('still rejects requests with a missing/invalid email (basic shape validation stays)', async () => {
            await expect(
                service.requestDomainVerification({
                    organizationId: ORG,
                    organizationName: 'Acme',
                    domain: DOMAIN,
                    contactEmail: '',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);

            await expect(
                service.requestDomainVerification({
                    organizationId: ORG,
                    organizationName: 'Acme',
                    domain: DOMAIN,
                    contactEmail: 'not-an-email',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);

            expect(notificationService.emit).not.toHaveBeenCalled();
        });

        it('still rejects requests with a missing domain (basic shape validation stays)', async () => {
            await expect(
                service.requestDomainVerification({
                    organizationId: ORG,
                    organizationName: 'Acme',
                    domain: '',
                    contactEmail: 'admin@acme.com',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });
    });
});
