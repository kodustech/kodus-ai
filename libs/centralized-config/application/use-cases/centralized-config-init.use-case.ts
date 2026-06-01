import { createLogger } from '@kodus/flow';
import { ParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { Inject, Injectable } from '@nestjs/common';
import { CentralizedConfigDownloadUseCase } from './centralized-config-download.use-case';
import { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { CentralizedConfigPrService } from '../../infrastructure/adapters/services/centralized-config-pr.service';

@Injectable()
export class CentralizedConfigInitUseCase {
    private readonly logger = createLogger(CentralizedConfigInitUseCase.name);

    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly centralizedConfigDownloadUseCase: CentralizedConfigDownloadUseCase,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
    ) {}

    async execute(params: {
        user: Partial<IUser>;
        organizationAndTeamData: OrganizationAndTeamData;
        repository: {
            id: string;
            name: string;
        };
        syncOption: 'pr' | 'manual';
        skipAuthorizationForDownload?: boolean;
    }): Promise<{
        success: boolean;
        message: string;
        prUrl?: string;
    }> {
        const { user, organizationAndTeamData, repository, syncOption } =
            params;
        const { organizationId, teamId } = organizationAndTeamData;

        let shouldRollbackEnable = false;

        try {
            const wasInitiallyEnabled =
                await this.checkIfCentralizedConfigEnabled(
                    organizationAndTeamData,
                );

            if (wasInitiallyEnabled) {
                const message =
                    'Centralized config already enabled for this team, skipping initialization';

                this.logger.log({
                    message,
                    context: CentralizedConfigInitUseCase.name,
                    metadata: {
                        organizationId,
                        teamId,
                        repositoryId: repository ? repository.id : 'unknown',
                        repositoryName: repository
                            ? repository.name
                            : 'unknown',
                    },
                });

                return {
                    success: false,
                    message,
                };
            }

            await this.enableCentralizedConfigForRepository(
                organizationAndTeamData,
                repository,
            );
            shouldRollbackEnable = true;

            if (syncOption === 'manual') {
                const message =
                    'Centralized config initialized with manual method, skipping sync';

                this.logger.log({
                    message,
                    context: CentralizedConfigInitUseCase.name,
                    metadata: {
                        organizationId,
                        teamId,
                        repositoryId: repository ? repository.id : 'unknown',
                        repositoryName: repository
                            ? repository.name
                            : 'unknown',
                        method: syncOption,
                    },
                });

                return {
                    success: true,
                    message,
                };
            }

            const configs = await this.centralizedConfigDownloadUseCase.execute(
                user,
                organizationAndTeamData.teamId,
                {
                    skipAuthorization:
                        params.skipAuthorizationForDownload ?? false,
                    organizationId: organizationAndTeamData.organizationId,
                    markRulesAsPendingWithSourcePath: true,
                },
            );

            const pr = await this.createPullRequestForCentralizedConfigInit({
                organizationAndTeamData,
                repository,
                configs,
            });

            if (!pr) {
                const message =
                    'Failed to create pull request for centralized config initialization';

                this.logger.error({
                    message,
                    context: CentralizedConfigInitUseCase.name,
                    metadata: {
                        organizationId,
                        teamId,
                        repositoryId: repository ? repository.id : 'unknown',
                        repositoryName: repository
                            ? repository.name
                            : 'unknown',
                    },
                });

                await this.disableCentralizedConfigForRepository(
                    organizationAndTeamData,
                );
                shouldRollbackEnable = false;

                return {
                    success: false,
                    message,
                };
            }

            const message =
                'Centralized config initialization pull request created successfully';

            this.logger.log({
                message,
                context: CentralizedConfigInitUseCase.name,
                metadata: {
                    organizationId,
                    teamId,
                    repositoryId: repository ? repository.id : 'unknown',
                    repositoryName: repository ? repository.name : 'unknown',
                    prUrl: pr.prUrl,
                },
            });

            return {
                success: true,
                message,
                prUrl: pr.prUrl,
            };
        } catch (error) {
            const message = 'Failed to initialize centralized config';

            this.logger.error({
                message,
                context: CentralizedConfigInitUseCase.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: {
                    organizationId,
                    teamId,
                    repositoryId: repository ? repository.id : 'unknown',
                    repositoryName: repository ? repository.name : 'unknown',
                },
            });

            if (shouldRollbackEnable) {
                await this.disableCentralizedConfigForRepository(
                    organizationAndTeamData,
                );
            }

            return {
                success: false,
                message,
            };
        }
    }

    private async checkIfCentralizedConfigEnabled(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const existingParameter = await this.parametersService.findByKey(
            ParametersKey.CENTRALIZED_CONFIG,
            organizationAndTeamData,
        );

        return existingParameter?.configValue?.enabled === true;
    }

    private async enableCentralizedConfigForRepository(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: { id: string; name: string },
    ) {
        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                enabled: true,
                repository: {
                    id: repository.id,
                    name: repository.name,
                },
                activePullRequest: null,
            },
            organizationAndTeamData,
        );
    }

    private async disableCentralizedConfigForRepository(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                enabled: false,
                repository: null,
                activePullRequest: null,
            },
            organizationAndTeamData,
        );
    }

    private async createPullRequestForCentralizedConfigInit(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        configs: Array<{ path: string; content: string }>;
    }): Promise<{ prUrl: string }> {
        const { organizationAndTeamData, repository, configs } = params;

        const title = `Initialize Centralized Config for Kodus Code Review`;
        const description = `This pull request initializes the centralized configuration for Kodus Code Review. It adds the existing configuration set via the UI as YAML files in the repository.`;
        const commitMessage = `Initialize Centralized Config for Kodus Code Review`;
        const sourceBranch = `kodus-centralized-config-init-${Date.now()}`;

        return await this.centralizedConfigPrService.createPullRequestInCentralizedRepo(
            {
                organizationAndTeamData,
                repository,
                files: configs,
                title,
                description,
                commitMessage,
                sourceBranch,
                author: {
                    name: 'kody',
                    email: 'kody@kodus.io',
                },
            },
        );
    }
}
