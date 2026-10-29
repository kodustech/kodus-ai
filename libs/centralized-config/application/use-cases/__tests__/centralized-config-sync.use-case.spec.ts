import { CentralizedConfigSyncUseCase } from '../centralized-config-sync.use-case';

describe('CentralizedConfigSyncUseCase', () => {
    const organizationAndTeamData = {
        organizationId: 'org-1',
        teamId: 'team-1',
    };

    it('syncs centralized config successfully', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest.fn().mockResolvedValue({
                success: true,
                message: 'Centralized config is valid and enabled',
            }),
            getCentralizedConfigRepository: jest.fn().mockResolvedValue({
                id: 'central-repo-id',
                name: 'kodus',
            }),
            discoverConfigFiles: jest.fn().mockResolvedValue([
                {}, // global config
                {
                    repositoryId: 'repo-1-id',
                    centralizedDirectoryPath: 'repo1',
                }, // repo config
            ]),
            discoverKodyRulesFiles: jest.fn().mockResolvedValue([]),
            synchronizeConfigs: jest.fn().mockResolvedValue({
                success: true,
                message: 'Config files synchronized successfully',
            }),
            synchronizeKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Kody rules synchronized successfully',
            }),
            removeStaleConfigs: jest.fn().mockResolvedValue({
                success: true,
                message: 'Stale configs removed successfully',
            }),
            removeStaleKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Stale Kody rules removed successfully',
            }),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(true);
        expect(result.message).toBe(
            'Centralized config sync completed successfully',
        );
        expect(
            centralizedConfigService.validateCentralizedConfig,
        ).toHaveBeenCalledWith({
            organizationAndTeamData,
        });
        expect(
            centralizedConfigService.getCentralizedConfigRepository,
        ).toHaveBeenCalledWith(organizationAndTeamData);
        expect(centralizedConfigService.discoverConfigFiles).toHaveBeenCalled();
        expect(centralizedConfigService.synchronizeConfigs).toHaveBeenCalled();
        expect(centralizedConfigService.removeStaleConfigs).toHaveBeenCalled();
    });

    it('fails when centralized config is not enabled', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest.fn().mockResolvedValue({
                success: false,
                message: 'Centralized config is not enabled for this team',
            }),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(false);
        expect(result.message).toBe(
            'Centralized config is not enabled for this team',
        );
        expect(
            centralizedConfigService.validateCentralizedConfig,
        ).toHaveBeenCalledWith({
            organizationAndTeamData,
        });
    });

    it('handles errors during sync', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest.fn().mockResolvedValue({
                success: true,
                message: 'Centralized config is valid and enabled',
            }),
            getCentralizedConfigRepository: jest
                .fn()
                .mockRejectedValue(new Error('Repository not found')),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(false);
        expect(result.message).toBe('Error syncing centralized config');
    });

    it('fails when synchronizeConfigs fails', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest.fn().mockResolvedValue({
                success: true,
                message: 'Centralized config is valid and enabled',
            }),
            getCentralizedConfigRepository: jest.fn().mockResolvedValue({
                id: 'central-repo-id',
                name: 'kodus',
            }),
            discoverConfigFiles: jest.fn().mockResolvedValue([]),
            discoverKodyRulesFiles: jest.fn().mockResolvedValue([]),
            synchronizeConfigs: jest.fn().mockResolvedValue({
                success: false,
                message: 'Failed to update parameters',
            }),
            synchronizeKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Kody rules synchronized successfully',
            }),
            removeStaleConfigs: jest.fn().mockResolvedValue({
                success: true,
                message: 'Stale configs removed successfully',
            }),
            removeStaleKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Stale Kody rules removed successfully',
            }),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(false);
        expect(result.message).toBe(
            'Failed to synchronize configs: Failed to update parameters',
        );
        expect(centralizedConfigService.synchronizeConfigs).toHaveBeenCalled();
    });

    it('fails when removeStaleConfigs fails', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest.fn().mockResolvedValue({
                success: true,
                message: 'Centralized config is valid and enabled',
            }),
            getCentralizedConfigRepository: jest.fn().mockResolvedValue({
                id: 'central-repo-id',
                name: 'kodus',
            }),
            discoverConfigFiles: jest.fn().mockResolvedValue([]),
            discoverKodyRulesFiles: jest.fn().mockResolvedValue([]),
            synchronizeConfigs: jest.fn().mockResolvedValue({
                success: true,
                message: 'Config files synchronized successfully',
            }),
            synchronizeKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Kody rules synchronized successfully',
            }),
            removeStaleConfigs: jest.fn().mockResolvedValue({
                success: false,
                message: 'Failed to clean up configs',
            }),
            removeStaleKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Stale Kody rules removed successfully',
            }),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(false);
        expect(result.message).toBe(
            'Failed to remove stale configs: Failed to clean up configs',
        );
        expect(centralizedConfigService.removeStaleConfigs).toHaveBeenCalled();
    });

    it('merges rule-only scopes into config sync', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest.fn().mockResolvedValue({
                success: true,
                message: 'Centralized config is valid and enabled',
            }),
            getCentralizedConfigRepository: jest.fn().mockResolvedValue({
                id: 'central-repo-id',
                name: 'kodus',
            }),
            discoverConfigFiles: jest.fn().mockResolvedValue([
                {},
                {
                    repositoryId: 'repo-1-id',
                    centralizedDirectoryPath: 'repo-1',
                },
            ]),
            discoverKodyRulesFiles: jest.fn().mockResolvedValue([
                {
                    repositoryId: 'repo-1-id',
                    directoryPath: '/src',
                    centralizedDirectoryPath: 'repo-1/src/.kody-rules/review',
                    ruleType: 'standard',
                    ruleFilePath: 'repo-1/src/.kody-rules/review/rule.yml',
                    path: 'repo-1/src/.kody-rules/review/rule.yml',
                },
                {
                    repositoryId: 'repo-1-id',
                    directoryPath: '/src',
                    centralizedDirectoryPath: 'repo-1/src/.kody-rules/memories',
                    ruleType: 'memory',
                    ruleFilePath: 'repo-1/src/.kody-rules/memories/rule.yml',
                    path: 'repo-1/src/.kody-rules/memories/rule.yml',
                },
            ]),
            synchronizeConfigs: jest.fn().mockResolvedValue({
                success: true,
                message: 'Config files synchronized successfully',
            }),
            synchronizeKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Kody rules synchronized successfully',
            }),
            removeStaleConfigs: jest.fn().mockResolvedValue({
                success: true,
                message: 'Stale configs removed successfully',
            }),
            removeStaleKodyRules: jest.fn().mockResolvedValue({
                success: true,
                message: 'Stale Kody rules removed successfully',
            }),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(true);
        expect(
            centralizedConfigService.synchronizeConfigs,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                configFiles: [
                    {},
                    {
                        repositoryId: 'repo-1-id',
                        centralizedDirectoryPath: 'repo-1',
                    },
                    {
                        repositoryId: 'repo-1-id',
                        directoryPath: '/src',
                        centralizedDirectoryPath:
                            'repo-1/src/.kody-rules/review',
                    },
                ],
            }),
        );
        expect(
            centralizedConfigService.removeStaleConfigs,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                configFiles: [
                    {},
                    {
                        repositoryId: 'repo-1-id',
                        centralizedDirectoryPath: 'repo-1',
                    },
                    {
                        repositoryId: 'repo-1-id',
                        directoryPath: '/src',
                        centralizedDirectoryPath:
                            'repo-1/src/.kody-rules/review',
                    },
                ],
            }),
        );
    });

    it('aborts before ANY deletion when discovery fails (issue #1518 safety net)', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest
                .fn()
                .mockResolvedValue({ success: true, message: 'ok' }),
            getCentralizedConfigRepository: jest
                .fn()
                .mockResolvedValue({ id: 'central-repo-id', name: 'kodus' }),
            discoverConfigFiles: jest.fn().mockResolvedValue([]),
            // A transient read failure now THROWS (scanRepositoryTree) instead
            // of returning [] — the use-case must abort before any removeStale
            // runs, or it would wipe every rule + the org's global config.
            discoverKodyRulesFiles: jest
                .fn()
                .mockRejectedValue(
                    new Error(
                        'repositories integration config unavailable',
                    ),
                ),
            synchronizeConfigs: jest.fn(),
            synchronizeKodyRules: jest.fn(),
            removeStaleConfigs: jest.fn(),
            removeStaleKodyRules: jest.fn(),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(false);
        // The critical safety property: nothing destructive ran.
        expect(
            centralizedConfigService.removeStaleKodyRules,
        ).not.toHaveBeenCalled();
        expect(
            centralizedConfigService.removeStaleConfigs,
        ).not.toHaveBeenCalled();
        expect(
            centralizedConfigService.synchronizeKodyRules,
        ).not.toHaveBeenCalled();
    });

    it('surfaces a partial Kody-rules sync as a failure and skips stale removal (#1518)', async () => {
        const centralizedConfigService = {
            validateCentralizedConfig: jest
                .fn()
                .mockResolvedValue({ success: true, message: 'ok' }),
            getCentralizedConfigRepository: jest
                .fn()
                .mockResolvedValue({ id: 'r', name: 'kodus' }),
            discoverConfigFiles: jest.fn().mockResolvedValue([]),
            discoverKodyRulesFiles: jest
                .fn()
                .mockResolvedValue([{ path: 'a.yml' }]),
            synchronizeConfigs: jest
                .fn()
                .mockResolvedValue({ success: true, message: 'ok' }),
            // 27 of 61 materialized, the rest failed — must NOT be success.
            synchronizeKodyRules: jest.fn().mockResolvedValue({
                success: false,
                message: 'Kody rules sync incomplete — synced 27, failed 34',
            }),
            removeStaleConfigs: jest.fn(),
            removeStaleKodyRules: jest.fn(),
        };

        const useCase = new CentralizedConfigSyncUseCase(
            centralizedConfigService as any,
        );

        const result = await useCase.execute({
            organizationAndTeamData,
        } as any);

        expect(result.success).toBe(false);
        expect(result.message).toContain('incomplete');
        // A partial materialization must not trigger stale deletion.
        expect(
            centralizedConfigService.removeStaleKodyRules,
        ).not.toHaveBeenCalled();
        expect(
            centralizedConfigService.removeStaleConfigs,
        ).not.toHaveBeenCalled();
    });
});

/**
 * Production 2026-09-28: one org's 22 rule files failed the rule schema on every
 * sync, and each sync logged "Failed to synchronize Kody rules" at error — 81
 * error events in twelve hours for YAML only the org can fix. A file the
 * repository gets wrong is a warning with the per-file reasons; an exception
 * inside the sync is still an error.
 */
describe('CentralizedConfigSyncUseCase — log level of a failed rule sync', () => {
    function makeUseCase(syncRulesResult: Record<string, unknown>) {
        const service = {
            validateCentralizedConfig: jest
                .fn()
                .mockResolvedValue({ success: true, message: 'ok' }),
            getCentralizedConfigRepository: jest
                .fn()
                .mockResolvedValue({ id: 'central', name: 'kodus' }),
            discoverConfigFiles: jest.fn().mockResolvedValue([]),
            discoverKodyRulesFiles: jest.fn().mockResolvedValue([]),
            synchronizeConfigs: jest
                .fn()
                .mockResolvedValue({ success: true, message: 'ok' }),
            synchronizeKodyRules: jest.fn().mockResolvedValue(syncRulesResult),
            removeStaleConfigs: jest.fn(),
            removeStaleKodyRules: jest.fn(),
        };
        const useCase = new CentralizedConfigSyncUseCase(service as any);
        const logger = (useCase as any).logger;
        return { useCase, logger };
    }

    const run = (useCase: CentralizedConfigSyncUseCase) =>
        useCase.execute({
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        } as any);

    const failureDetails = [
        {
            file: 'app-baseline/.kody-rules/review/add-tests.yml',
            error: 'Rule file does not comply with required schema: severity: Invalid option',
        },
    ];

    it('warns, with the per-file reasons, when rule files were rejected', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Kody rules sync incomplete — synced 7, failed 1',
            failureDetails,
        });

        const result = await run(useCase);

        expect(result.success).toBe(false);
        expect(logger.error).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({ failureDetails }),
            }),
        );
    });

    it('still errors when the sync itself threw', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Error synchronizing Kody rules',
            failureDetails: [{ file: 'general', error: 'boom' }],
        });

        await run(useCase);

        expect(logger.error).toHaveBeenCalled();
    });

    it('still errors when a thrown sync sits beside rejected files', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Error synchronizing Kody rules',
            failureDetails: [...failureDetails, { file: 'general', error: 'boom' }],
        });

        await run(useCase);

        expect(logger.error).toHaveBeenCalled();
        expect(logger.warn).not.toHaveBeenCalled();
    });

    it('still errors on a failure that names no file', async () => {
        const { useCase, logger } = makeUseCase({
            success: false,
            message: 'Error synchronizing Kody rules',
        });

        await run(useCase);

        expect(logger.error).toHaveBeenCalled();
    });
});
