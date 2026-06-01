import { CodeReviewHandlerService } from '@libs/code-review/infrastructure/adapters/services/codeReviewHandlerService.service';
import { OrganizationParametersKey } from '@libs/core/domain/enums';

const mockLogger = {
    log: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
};

jest.mock('@kodus/flow', () => ({
    createLogger: () => mockLogger,
}));

/**
 * `captureFirstReviewIfNeeded` is the org-level "aha moment" milestone.
 * It runs after every successful code review pipeline and must:
 *   - fire telemetry exactly once per organization
 *   - persist a marker so subsequent SUCCESS reviews skip
 *   - never throw — the pipeline already finished, telemetry is gravy
 *
 * Tested directly via `(service as any)` per the project convention for
 * private methods on services.
 */
describe('CodeReviewHandlerService.captureFirstReviewIfNeeded', () => {
    const buildService = (overrides: { org?: any; owner?: any } = {}) => {
        const orgParams = {
            findByKey: jest.fn(),
            createOrUpdateConfig: jest.fn().mockResolvedValue(true),
        };
        const telemetry = { firstReviewCompleted: jest.fn() };
        const orgService = {
            findOne: jest.fn().mockResolvedValue(
                overrides.org ?? { uuid: 'org-1', name: 'Acme Corp' },
            ),
        };
        const usersService = {
            findOne: jest.fn().mockResolvedValue(
                overrides.owner ?? {
                    uuid: 'owner-1',
                    email: 'owner@acme.com',
                },
            ),
        };
        const service = new CodeReviewHandlerService(
            {} as any,
            {} as any,
            orgParams as any,
            telemetry as any,
            orgService as any,
            usersService as any,
        );
        return { service, orgParams, telemetry, orgService, usersService };
    };

    const orgAndTeam = { organizationId: 'org-1', teamId: 'team-1' };
    const repository = { id: 'repo-1', name: 'alpha' };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('first review (no marker yet)', () => {
        it('writes the marker, then fires telemetry hydrated with org name + owner email + repo name', async () => {
            const { service, orgParams, telemetry } = buildService();
            orgParams.findByKey.mockResolvedValueOnce(undefined);

            await (service as any).captureFirstReviewIfNeeded(
                orgAndTeam,
                repository,
                42,
                'github',
            );

            // Marker was written exactly once with the correct key + scope.
            expect(orgParams.createOrUpdateConfig).toHaveBeenCalledTimes(1);
            const [key, value, scope] =
                orgParams.createOrUpdateConfig.mock.calls[0];
            expect(key).toBe(OrganizationParametersKey.FIRST_REVIEW_AT);
            expect(scope).toEqual({ organizationId: 'org-1' });
            expect(typeof value).toBe('string');
            expect(new Date(value).toString()).not.toBe('Invalid Date');

            // Telemetry fired with the hydrated shape (names + owner contact).
            expect(telemetry.firstReviewCompleted).toHaveBeenCalledTimes(1);
            expect(telemetry.firstReviewCompleted).toHaveBeenCalledWith({
                organizationId: 'org-1',
                organizationName: 'Acme Corp',
                teamId: 'team-1',
                repositoryId: 'repo-1',
                repositoryName: 'alpha',
                pullRequestNumber: 42,
                platform: 'github',
                ownerId: 'owner-1',
                ownerEmail: 'owner@acme.com',
            });
        });

        it('still fires telemetry with undefined names when hydration lookups fail', async () => {
            const { service, orgParams, telemetry, orgService, usersService } =
                buildService();
            orgParams.findByKey.mockResolvedValueOnce(undefined);
            orgService.findOne.mockRejectedValueOnce(new Error('db slow'));
            usersService.findOne.mockRejectedValueOnce(new Error('db slow'));

            await (service as any).captureFirstReviewIfNeeded(
                orgAndTeam,
                repository,
                42,
                'github',
            );

            expect(telemetry.firstReviewCompleted).toHaveBeenCalledTimes(1);
            const arg = telemetry.firstReviewCompleted.mock.calls[0][0];
            expect(arg.organizationId).toBe('org-1');
            expect(arg.organizationName).toBeUndefined();
            expect(arg.ownerEmail).toBeUndefined();
        });
    });

    // ─── Idempotency invariant ──────────────────────────────────────────
    // The whole reason for the marker. If a second SUCCESS review fires
    // and we already flagged the org, we must NOT fire again — otherwise
    // the "first review" milestone becomes "every successful review".
    describe('subsequent reviews (marker exists)', () => {
        it('does not write the marker again and does not fire telemetry', async () => {
            const { service, orgParams, telemetry } = buildService();
            orgParams.findByKey.mockResolvedValueOnce({
                configKey: OrganizationParametersKey.FIRST_REVIEW_AT,
                configValue: '2026-04-29T10:00:00.000Z',
            });

            await (service as any).captureFirstReviewIfNeeded(
                orgAndTeam,
                repository,
                42,
                'github',
            );

            expect(orgParams.createOrUpdateConfig).not.toHaveBeenCalled();
            expect(telemetry.firstReviewCompleted).not.toHaveBeenCalled();
        });
    });

    describe('guards', () => {
        it('returns early without DB calls when organizationId is missing', async () => {
            const { service, orgParams, telemetry } = buildService();

            await (service as any).captureFirstReviewIfNeeded(
                { organizationId: undefined, teamId: 'team-1' },
                repository,
                42,
                'github',
            );

            expect(orgParams.findByKey).not.toHaveBeenCalled();
            expect(orgParams.createOrUpdateConfig).not.toHaveBeenCalled();
            expect(telemetry.firstReviewCompleted).not.toHaveBeenCalled();
        });
    });

    // ─── Resilience ─────────────────────────────────────────────────────
    // The pipeline already finished successfully when we get here. A
    // failure to read or write the marker must NOT propagate — the user
    // must still see their PR review.
    describe('resilience', () => {
        it('swallows findByKey errors and does not fire telemetry', async () => {
            const { service, orgParams, telemetry } = buildService();
            orgParams.findByKey.mockRejectedValueOnce(new Error('db down'));

            await expect(
                (service as any).captureFirstReviewIfNeeded(
                    orgAndTeam,
                    repository,
                    42,
                    'github',
                ),
            ).resolves.toBeUndefined();

            expect(orgParams.createOrUpdateConfig).not.toHaveBeenCalled();
            expect(telemetry.firstReviewCompleted).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: expect.stringContaining(
                        'Failed to capture first-review milestone',
                    ),
                }),
            );
        });

        it('swallows createOrUpdateConfig errors after a clean findByKey', async () => {
            const { service, orgParams, telemetry } = buildService();
            orgParams.findByKey.mockResolvedValueOnce(undefined);
            orgParams.createOrUpdateConfig.mockRejectedValueOnce(
                new Error('write conflict'),
            );

            await expect(
                (service as any).captureFirstReviewIfNeeded(
                    orgAndTeam,
                    repository,
                    42,
                    'github',
                ),
            ).resolves.toBeUndefined();

            // The write was attempted but failed; telemetry must not fire,
            // otherwise we'd report a milestone we didn't actually mark.
            expect(orgParams.createOrUpdateConfig).toHaveBeenCalledTimes(1);
            expect(telemetry.firstReviewCompleted).not.toHaveBeenCalled();
            expect(mockLogger.warn).toHaveBeenCalled();
        });
    });
});
