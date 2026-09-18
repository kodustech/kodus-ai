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
