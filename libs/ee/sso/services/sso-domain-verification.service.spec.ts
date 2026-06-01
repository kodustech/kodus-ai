import { BadRequestException, NotFoundException } from '@nestjs/common';

// environment.ts is gitignored; mock it so the suite runs without the file and
// so we can toggle cloud vs self-hosted per test. We import the mocked object
// below and mutate API_CLOUD_MODE — the service reads the same reference.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

import { environment } from '@libs/ee/configs/environment';
import { SSODomainVerificationService } from './sso-domain-verification.service';

// In-memory cache so the request→confirm→status token lifecycle is real.
function makeCache() {
    const store = new Map<string, unknown>();
    return {
        store,
        addToCache: jest.fn(async (k: string, v: unknown) => {
            store.set(k, v);
        }),
        getFromCache: jest.fn(async (k: string) => store.get(k) ?? null),
        removeFromCache: jest.fn(async (k: string) => {
            store.delete(k);
        }),
    };
}

// Guards the CLOUD-ONLY SSO domain-verification flow (requireDomainMatch +
// emailed-token handshake) that the self-hosted E2E never exercises — it
// auto-verifies. See sso-domain-verification.service.ts:104/114.
describe('SSODomainVerificationService', () => {
    const orgTeam = {
        organizationId: 'org-1',
        organizationName: 'Acme',
        domain: 'acme.com',
    };

    const make = () => {
        const cache = makeCache();
        const notification = { emit: jest.fn(async () => {}) };
        const svc = new SSODomainVerificationService(
            cache as any,
            notification as any,
        );
        return { svc, cache, notification };
    };

    const emittedToken = (notification: { emit: jest.Mock }): string =>
        notification.emit.mock.calls[0][0].payload.token;

    beforeEach(() => {
        (environment as any).API_CLOUD_MODE = true;
    });

    describe('cloud mode (API_CLOUD_MODE=true)', () => {
        it('rejects a contact email that is not at the domain', async () => {
            const { svc, notification } = make();
            await expect(
                svc.requestDomainVerification({
                    organizationId: orgTeam.organizationId,
                    organizationName: orgTeam.organizationName,
                    domain: 'acme.com',
                    contactEmail: 'admin@evil.com',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(notification.emit).not.toHaveBeenCalled();
        });

        it('rejects a malformed contact email', async () => {
            const { svc } = make();
            await expect(
                svc.requestDomainVerification({
                    organizationId: orgTeam.organizationId,
                    organizationName: orgTeam.organizationName,
                    domain: 'acme.com',
                    contactEmail: 'not-an-email',
                }),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('emails a token (does NOT auto-verify) when the email is at the domain', async () => {
            const { svc, notification } = make();
            const res = await svc.requestDomainVerification({
                organizationId: orgTeam.organizationId,
                organizationName: orgTeam.organizationName,
                domain: 'acme.com',
                contactEmail: 'admin@acme.com',
            });
            expect(res.sent).toBe(true);
            expect(notification.emit).toHaveBeenCalledTimes(1);
            expect(emittedToken(notification)).toBeTruthy();
            // Not verified yet — only requested.
            const status = await svc.getDomainVerificationStatus({
                organizationId: orgTeam.organizationId,
                domain: 'acme.com',
            });
            expect(status).toBeNull();
        });

        it('verifies the domain only after confirm(token), then status reflects it', async () => {
            const { svc, notification } = make();
            await svc.requestDomainVerification({
                organizationId: orgTeam.organizationId,
                organizationName: orgTeam.organizationName,
                domain: 'acme.com',
                contactEmail: 'admin@acme.com',
            });
            const token = emittedToken(notification);

            const record = await svc.confirmDomainVerification(token);
            expect(record.domain).toBe('acme.com');
            expect(record.verifiedByEmail).toBe('admin@acme.com');

            const status = await svc.getDomainVerificationStatus({
                organizationId: orgTeam.organizationId,
                domain: 'acme.com',
            });
            expect(status?.verifiedByEmail).toBe('admin@acme.com');
        });

        it('rejects an unknown/expired token on confirm', async () => {
            const { svc } = make();
            await expect(
                svc.confirmDomainVerification('not-a-real-token'),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('consumes the token — a second confirm fails', async () => {
            const { svc, notification } = make();
            await svc.requestDomainVerification({
                organizationId: orgTeam.organizationId,
                organizationName: orgTeam.organizationName,
                domain: 'acme.com',
                contactEmail: 'admin@acme.com',
            });
            const token = emittedToken(notification);
            await svc.confirmDomainVerification(token);
            await expect(
                svc.confirmDomainVerification(token),
            ).rejects.toBeInstanceOf(NotFoundException);
        });
    });

    describe('self-hosted mode (API_CLOUD_MODE=false)', () => {
        beforeEach(() => {
            (environment as any).API_CLOUD_MODE = false;
        });

        it('auto-verifies without emailing a token', async () => {
            const { svc, notification } = make();
            const res = await svc.requestDomainVerification({
                organizationId: orgTeam.organizationId,
                organizationName: orgTeam.organizationName,
                domain: 'acme.com',
                contactEmail: 'admin@acme.com',
            });
            expect(res.sent).toBe(false);
            expect(notification.emit).not.toHaveBeenCalled();
            // Verified immediately — no confirm step.
            const status = await svc.getDomainVerificationStatus({
                organizationId: orgTeam.organizationId,
                domain: 'acme.com',
            });
            expect(status?.verifiedByEmail).toBe('admin@acme.com');
        });

        it('allows a contact email outside the SSO domain (no requireDomainMatch)', async () => {
            const { svc } = make();
            const res = await svc.requestDomainVerification({
                organizationId: orgTeam.organizationId,
                organizationName: orgTeam.organizationName,
                domain: 'acme.com',
                contactEmail: 'admin@my-msp.com',
            });
            expect(res.sent).toBe(false);
        });
    });

    describe('getDomainsVerificationStatus', () => {
        it('reports verified/unverified per domain', async () => {
            const { svc, notification } = make();
            await svc.requestDomainVerification({
                organizationId: orgTeam.organizationId,
                organizationName: orgTeam.organizationName,
                domain: 'acme.com',
                contactEmail: 'admin@acme.com',
            });
            await svc.confirmDomainVerification(emittedToken(notification));

            const statuses = await svc.getDomainsVerificationStatus({
                organizationId: orgTeam.organizationId,
                domains: ['acme.com', 'unverified.com'],
            });
            const byDomain = Object.fromEntries(
                statuses.map((s) => [s.domain, s.verified]),
            );
            expect(byDomain['acme.com']).toBe(true);
            expect(byDomain['unverified.com']).toBe(false);
        });
    });
});
