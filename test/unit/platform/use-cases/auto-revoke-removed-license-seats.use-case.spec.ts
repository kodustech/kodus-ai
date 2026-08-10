import { Test, TestingModule } from '@nestjs/testing';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { ORGANIZATION_PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { AutoRevokeRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/auto-revoke-removed-license-seats.use-case';
import { PruneRemovedLicenseSeatsUseCase } from '@libs/platform/application/use-cases/codeManagement/prune-removed-license-seats.use-case';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-09T12:00:00.000Z');

describe('AutoRevokeRemovedLicenseSeatsUseCase', () => {
    let useCase: AutoRevokeRemovedLicenseSeatsUseCase;
    let mockOrganizationParametersService: {
        findByKey: jest.Mock;
        createOrUpdateConfig: jest.Mock;
    };
    let mockPruneUseCase: { execute: jest.Mock };

    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    const configValue = (overrides: Record<string, unknown> = {}) => ({
        configValue: {
            enabled: true,
            ignoredUsers: ['ignored-1'],
            allowedUsers: ['allowed-1'],
            autoRevokeRemovedUsers: true,
            ...overrides,
        },
    });

    beforeEach(async () => {
        jest.useFakeTimers().setSystemTime(NOW);

        mockOrganizationParametersService = {
            findByKey: jest.fn().mockResolvedValue(configValue()),
            createOrUpdateConfig: jest.fn().mockResolvedValue(undefined),
        };

        mockPruneUseCase = {
            execute: jest.fn().mockResolvedValue({
                status: 'ok',
                candidates: ['gone-1'],
                revoked: [],
                failed: [],
            }),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                AutoRevokeRemovedLicenseSeatsUseCase,
                {
                    provide: ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
                    useValue: mockOrganizationParametersService,
                },
                {
                    provide: PruneRemovedLicenseSeatsUseCase,
                    useValue: mockPruneUseCase,
                },
            ],
        }).compile();

        useCase = module.get(AutoRevokeRemovedLicenseSeatsUseCase);
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe('opt-in gate', () => {
        it('does nothing when auto revoke is not enabled', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({ autoRevokeRemovedUsers: false }),
            );

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.status).toBe('disabled');
            expect(mockPruneUseCase.execute).not.toHaveBeenCalled();
        });

        it('does nothing when the organization has no auto assign config', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(null);

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.status).toBe('disabled');
            expect(mockPruneUseCase.execute).not.toHaveBeenCalled();
        });
    });

    describe('grace period', () => {
        it('starts the clock on a newly missing user instead of revoking', async () => {
            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.status).toBe('ok');
            expect(result.pending).toEqual(['gone-1']);
            expect(result.revoked).toEqual([]);
            expect(mockPruneUseCase.execute).toHaveBeenCalledTimes(1);
            expect(mockPruneUseCase.execute).toHaveBeenCalledWith({
                organizationAndTeamData,
                dryRun: true,
            });
            expect(
                mockOrganizationParametersService.createOrUpdateConfig,
            ).toHaveBeenCalledWith(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                expect.objectContaining({
                    enabled: true,
                    ignoredUsers: ['ignored-1'],
                    allowedUsers: ['allowed-1'],
                    autoRevokeRemovedUsers: true,
                    pendingRevocations: {
                        'gone-1': NOW.toISOString(),
                    },
                }),
                organizationAndTeamData,
            );
        });

        it('keeps waiting while the grace period has not elapsed', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({
                    revokeGraceDays: 7,
                    pendingRevocations: {
                        'gone-1': new Date(NOW.getTime() - 3 * DAY).toISOString(),
                    },
                }),
            );

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.pending).toEqual(['gone-1']);
            expect(result.revoked).toEqual([]);
            expect(mockPruneUseCase.execute).toHaveBeenCalledTimes(1);
        });

        it('revokes once the grace period has elapsed', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({
                    revokeGraceDays: 7,
                    pendingRevocations: {
                        'gone-1': new Date(NOW.getTime() - 8 * DAY).toISOString(),
                    },
                }),
            );
            mockPruneUseCase.execute
                .mockResolvedValueOnce({
                    status: 'ok',
                    candidates: ['gone-1'],
                    revoked: [],
                    failed: [],
                })
                .mockResolvedValueOnce({
                    status: 'ok',
                    candidates: ['gone-1'],
                    revoked: ['gone-1'],
                    failed: [],
                });

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.revoked).toEqual(['gone-1']);
            expect(mockPruneUseCase.execute).toHaveBeenNthCalledWith(2, {
                organizationAndTeamData,
                gitIds: ['gone-1'],
            });
            expect(
                mockOrganizationParametersService.createOrUpdateConfig,
            ).toHaveBeenCalledWith(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                expect.objectContaining({ pendingRevocations: {} }),
                organizationAndTeamData,
            );
        });

        it('revokes immediately when the grace period is zero', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({ revokeGraceDays: 0 }),
            );
            mockPruneUseCase.execute
                .mockResolvedValueOnce({
                    status: 'ok',
                    candidates: ['gone-1'],
                    revoked: [],
                    failed: [],
                })
                .mockResolvedValueOnce({
                    status: 'ok',
                    candidates: ['gone-1'],
                    revoked: ['gone-1'],
                    failed: [],
                });

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.revoked).toEqual(['gone-1']);
        });

        it('clears the timer for a user who rejoined the organization', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({
                    pendingRevocations: {
                        'came-back': new Date(
                            NOW.getTime() - 30 * DAY,
                        ).toISOString(),
                    },
                }),
            );

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.pending).toEqual(['gone-1']);
            expect(
                mockOrganizationParametersService.createOrUpdateConfig,
            ).toHaveBeenCalledWith(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                expect.objectContaining({
                    pendingRevocations: { 'gone-1': NOW.toISOString() },
                }),
                organizationAndTeamData,
            );
        });

        it('keeps a failed revoke pending so the next run retries it', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({
                    revokeGraceDays: 1,
                    pendingRevocations: {
                        'gone-1': new Date(NOW.getTime() - 5 * DAY).toISOString(),
                    },
                }),
            );
            mockPruneUseCase.execute
                .mockResolvedValueOnce({
                    status: 'ok',
                    candidates: ['gone-1'],
                    revoked: [],
                    failed: [],
                })
                .mockResolvedValueOnce({
                    status: 'ok',
                    candidates: ['gone-1'],
                    revoked: [],
                    failed: ['gone-1'],
                });

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.failed).toEqual(['gone-1']);
            // The original timer entry is left in place, so the seat stays due
            // and the next run retries it.
            expect(result.pending).toEqual(['gone-1']);
            expect(
                mockOrganizationParametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });
    });

    describe('safety', () => {
        it('leaves the pending timers untouched when the member list is unavailable', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({
                    pendingRevocations: {
                        'gone-1': new Date(NOW.getTime() - 90 * DAY).toISOString(),
                    },
                }),
            );
            mockPruneUseCase.execute.mockResolvedValue({
                status: 'members_unavailable',
                candidates: [],
                revoked: [],
                failed: [],
            });

            const result = await useCase.execute({ organizationAndTeamData });

            expect(result.status).toBe('members_unavailable');
            expect(result.revoked).toEqual([]);
            expect(mockPruneUseCase.execute).toHaveBeenCalledTimes(1);
            expect(
                mockOrganizationParametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });

        // execute() spends seconds in the git provider and billing before it
        // writes, so it must not persist the config it read at the start.
        it('keeps a seat setting saved while the sweep was running', async () => {
            mockOrganizationParametersService.findByKey
                // read at the top of execute(): auto-revoke on
                .mockResolvedValueOnce(configValue())
                // admin turns auto-revoke off mid-sweep; re-read before writing
                .mockResolvedValueOnce(
                    configValue({
                        autoRevokeRemovedUsers: false,
                        ignoredUsers: ['ignored-1', 'added-mid-sweep'],
                    }),
                );

            await useCase.execute({ organizationAndTeamData });

            expect(
                mockOrganizationParametersService.createOrUpdateConfig,
            ).toHaveBeenCalledWith(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                expect.objectContaining({
                    autoRevokeRemovedUsers: false,
                    ignoredUsers: ['ignored-1', 'added-mid-sweep'],
                    pendingRevocations: { 'gone-1': NOW.toISOString() },
                }),
                organizationAndTeamData,
            );
        });

        it('does not rewrite the config when nothing changed', async () => {
            mockOrganizationParametersService.findByKey.mockResolvedValue(
                configValue({
                    pendingRevocations: { 'gone-1': NOW.toISOString() },
                }),
            );

            await useCase.execute({ organizationAndTeamData });

            expect(
                mockOrganizationParametersService.createOrUpdateConfig,
            ).not.toHaveBeenCalled();
        });
    });
});
