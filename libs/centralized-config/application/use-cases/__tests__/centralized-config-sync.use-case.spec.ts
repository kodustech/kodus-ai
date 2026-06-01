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
});
