import {
    BadRequestException,
    ForbiddenException,
    UnauthorizedException,
} from '@nestjs/common';
import archiver from 'archiver';
import { CliCentralizedConfigController } from '../cli/cli-centralized-config.controller';
import { TEAM_CLI_KEY_CAPABILITIES } from '@libs/organization/domain/team-cli-key/interfaces/team-cli-key.interface';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@libs/core/domain/enums';

jest.mock('archiver', () => jest.fn());

describe('CliCentralizedConfigController', () => {
    let controller: CliCentralizedConfigController;
    let teamCliKeyService: { validateKey: jest.Mock };
    let codeManagementService: { getTypeIntegration: jest.Mock };
    let integrationConfigService: { findIntegrationConfigFormatted: jest.Mock };
    let parametersService: { findByKey: jest.Mock };
    let createOrUpdateParametersUseCase: { execute: jest.Mock };
    let centralizedConfigInitUseCase: { execute: jest.Mock };
    let centralizedConfigSyncUseCase: { execute: jest.Mock };
    let centralizedConfigDownloadUseCase: { execute: jest.Mock };

    const teamData = {
        team: { uuid: 'team-1' },
        organization: { uuid: 'org-1' },
        config: {
            capabilities: [TEAM_CLI_KEY_CAPABILITIES.CONFIG_REPO_MANAGE],
        },
    };

    const selectedRepositories = [
        {
            id: 'repo-1',
            name: 'kodus-config',
            organizationName: 'kodustech',
            selected: true,
        },
        {
            id: 'repo-2',
            name: 'other',
            organizationName: 'kodustech',
            selected: false,
        },
    ];

    beforeEach(() => {
        teamCliKeyService = {
            validateKey: jest.fn().mockResolvedValue(teamData),
        };

        codeManagementService = {
            getTypeIntegration: jest.fn().mockResolvedValue('github'),
        };

        integrationConfigService = {
            findIntegrationConfigFormatted: jest
                .fn()
                .mockResolvedValue(selectedRepositories),
        };

        parametersService = {
            findByKey: jest.fn().mockResolvedValue(null),
        };

        createOrUpdateParametersUseCase = {
            execute: jest.fn().mockResolvedValue(true),
        };

        centralizedConfigInitUseCase = {
            execute: jest.fn().mockResolvedValue({
                success: true,
                message: 'Centralized config initialized successfully',
                prUrl: 'https://example.com/pr/1',
            }),
        };

        centralizedConfigSyncUseCase = {
            execute: jest.fn().mockResolvedValue({
                success: true,
                message: 'Centralized config sync completed successfully',
            }),
        };

        centralizedConfigDownloadUseCase = {
            execute: jest.fn().mockResolvedValue([
                {
                    path: 'kodus-config.yml',
                    content: 'version: 1',
                },
            ]),
        };

        controller = new CliCentralizedConfigController(
            teamCliKeyService as any,
            codeManagementService as any,
            integrationConfigService as any,
            parametersService as any,
            createOrUpdateParametersUseCase as any,
            centralizedConfigInitUseCase as any,
            centralizedConfigSyncUseCase as any,
            centralizedConfigDownloadUseCase as any,
        );
    });

    it('returns centralized config status with default disabled state', async () => {
        const result = await controller.getStatus('kodus_test_key', undefined);

        expect(parametersService.findByKey).toHaveBeenCalledWith(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        );
        expect(result).toEqual({
            enabled: false,
            repository: null,
        });
    });

    it('initializes centralized config for a selected repository', async () => {
        await controller.initialize(
            {
                repositoryId: 'repo-1',
                syncOption: 'manual',
            },
            'kodus_test_key',
            undefined,
        );

        expect(codeManagementService.getTypeIntegration).toHaveBeenCalledWith({
            organizationId: 'org-1',
            teamId: 'team-1',
        });
        expect(
            integrationConfigService.findIntegrationConfigFormatted,
        ).toHaveBeenCalledWith(IntegrationConfigKey.REPOSITORIES, {
            organizationId: 'org-1',
            teamId: 'team-1',
        });
        expect(centralizedConfigInitUseCase.execute).toHaveBeenCalledWith({
            user: {
                uuid: 'kody',
                email: 'kody@kodus.io',
                organization: {
                    uuid: 'org-1',
                },
            },
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: {
                id: 'repo-1',
                name: 'kodus-config',
            },
            syncOption: 'manual',
            skipAuthorizationForDownload: true,
        });
    });

    it('rejects init when repositoryId is missing', async () => {
        await expect(
            controller.initialize({} as any, 'kodus_test_key', undefined),
        ).rejects.toThrow(BadRequestException);

        expect(centralizedConfigInitUseCase.execute).not.toHaveBeenCalled();
    });

    it('rejects init when syncOption is invalid', async () => {
        await expect(
            controller.initialize(
                {
                    repositoryId: 'repo-1',
                    syncOption: 'invalid' as any,
                },
                'kodus_test_key',
                undefined,
            ),
        ).rejects.toThrow(BadRequestException);

        expect(centralizedConfigInitUseCase.execute).not.toHaveBeenCalled();
    });

    it('syncs centralized config for the team', async () => {
        const result = await controller.sync('kodus_test_key', undefined);

        expect(centralizedConfigSyncUseCase.execute).toHaveBeenCalledWith({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        });
        expect(result).toEqual({
            success: true,
            message: 'Centralized config sync completed successfully',
        });
    });

    it('disables centralized config', async () => {
        const result = await controller.disable('kodus_test_key', undefined);

        expect(createOrUpdateParametersUseCase.execute).toHaveBeenCalledWith(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                enabled: false,
                repository: null,
                activePullRequest: null,
            },
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
        );
        expect(result).toEqual({
            success: true,
            message: 'Centralized config disabled successfully',
        });
    });

    it('streams centralized config download as zip', async () => {
        const archiveMock = {
            on: jest.fn().mockReturnThis(),
            pipe: jest.fn(),
            append: jest.fn(),
            finalize: jest.fn().mockResolvedValue(undefined),
        };

        (archiver as unknown as jest.Mock).mockReturnValue(archiveMock);

        const response = {
            set: jest.fn(),
        } as any;

        await controller.download(response, 'kodus_test_key', undefined);

        expect(response.set).toHaveBeenCalledWith({
            'Content-Type': 'application/zip',
            'Content-Disposition':
                'attachment; filename=centralized-config.zip',
        });
        expect(archiveMock.pipe).toHaveBeenCalledWith(response);
        expect(archiveMock.append).toHaveBeenCalledWith('version: 1', {
            name: 'kodus-config.yml',
        });
        expect(archiveMock.finalize).toHaveBeenCalled();
        expect(centralizedConfigDownloadUseCase.execute).toHaveBeenCalledWith(
            {
                uuid: 'kody',
                email: 'kody@kodus.io',
                organization: {
                    uuid: 'org-1',
                },
            },
            'team-1',
            {
                skipAuthorization: true,
                organizationId: 'org-1',
            },
        );
    });

    it('rejects keys without repository capability', async () => {
        teamCliKeyService.validateKey.mockResolvedValue({
            ...teamData,
            config: {
                capabilities: [],
            },
        });

        await expect(
            controller.getStatus('kodus_test_key', undefined),
        ).rejects.toThrow(ForbiddenException);
    });

    it('rejects invalid team keys', async () => {
        teamCliKeyService.validateKey.mockResolvedValue(null);

        await expect(
            controller.getStatus('kodus_test_key', undefined),
        ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects when no code management integration exists for init', async () => {
        codeManagementService.getTypeIntegration.mockResolvedValue(null);

        await expect(
            controller.initialize(
                {
                    repositoryId: 'repo-1',
                },
                'kodus_test_key',
                undefined,
            ),
        ).rejects.toThrow(BadRequestException);
    });
});
