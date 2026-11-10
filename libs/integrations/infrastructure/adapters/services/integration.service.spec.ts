import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { IntegrationService } from './integration.service';

/**
 * Regression coverage: `getPlatformAuthDetails` used to swallow its catch
 * block into `console.log('platformkeys', error)`, which bypasses the
 * structured JSON logger entirely — these failures were invisible to
 * CloudWatch's JSON-based log queries (found while investigating a
 * production incident, 2026-09-17). The fix routes the failure through the
 * same structured logger every other adapter in this codebase uses.
 */
const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
};

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => mockLogger,
}));

describe('IntegrationService.getPlatformAuthDetails — error observability', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('logs the failure through the structured logger, not console.log', async () => {
        const boom = new Error('connection refused');
        const integrationRepository = {
            findOne: jest.fn().mockRejectedValue(boom),
        };
        const service = new IntegrationService(
            integrationRepository as any,
            {} as any,
        );

        const consoleSpy = jest.spyOn(console, 'log').mockImplementation();

        const result = await service.getPlatformAuthDetails(
            { organizationId: 'org-1', teamId: 'team-1' },
            PlatformType.GITHUB,
        );

        expect(result).toBeUndefined();
        expect(consoleSpy).not.toHaveBeenCalled();
        expect(mockLogger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: expect.any(String),
                context: 'IntegrationService',
                error: boom,
                metadata: {
                    organizationAndTeamData: {
                        organizationId: 'org-1',
                        teamId: 'team-1',
                    },
                    platform: PlatformType.GITHUB,
                },
            }),
        );

        consoleSpy.mockRestore();
    });
});

describe('IntegrationService.getPlatformAuthDetails — credential identity', () => {
    const updatedAt = new Date('2026-11-10T15:30:00.000Z');
    const makeService = (integration: unknown) =>
        new IntegrationService(
            { findOne: jest.fn().mockResolvedValue(integration) } as any,
            {} as any,
        );

    it('returns the stored auth details unchanged, plus the row id and last write', async () => {
        const authDetails = {
            authToken: 'encrypted',
            authMode: 'token',
            org: 'acme',
        };
        const service = makeService({
            uuid: 'integration-1',
            authIntegration: { uuid: 'auth-row-1', updatedAt, authDetails },
        });

        const result = await service.getPlatformAuthDetails<any>(
            { organizationId: 'org-1', teamId: 'team-1' },
            PlatformType.GITHUB,
        );

        expect(result).toEqual({
            integrationId: 'integration-1',
            ...authDetails,
            authIntegrationId: 'auth-row-1',
            authUpdatedAt: updatedAt,
        });
    });

    it('does not let a stored field shadow the row identity', async () => {
        const service = makeService({
            uuid: 'integration-1',
            authIntegration: {
                uuid: 'auth-row-1',
                updatedAt,
                authDetails: {
                    authIntegrationId: 'spoofed',
                    authUpdatedAt: 'spoofed',
                },
            },
        });

        const result = await service.getPlatformAuthDetails<any>(
            { organizationId: 'org-1', teamId: 'team-1' },
            PlatformType.GITHUB,
        );

        expect(result.authIntegrationId).toBe('auth-row-1');
        expect(result.authUpdatedAt).toBe(updatedAt);
    });

    it('still returns null when there is no integration', async () => {
        const service = makeService(null);
        await expect(
            service.getPlatformAuthDetails(
                { organizationId: 'org-1', teamId: 'team-1' },
                PlatformType.GITHUB,
            ),
        ).resolves.toBeNull();
    });
});
