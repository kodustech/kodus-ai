import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import { PULL_REQUEST_MESSAGES_SERVICE_TOKEN } from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { IPullRequestMessagesService } from '@libs/code-review/domain/pullRequestMessages/contracts/pullRequestMessages.service.contract';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { ConfigLevel } from '@libs/core/infrastructure/config/types/general/pullRequestMessages.type';
import { IParametersService } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

import { DeleteIntegrationUseCase } from './delete-integration.use-case';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { CreateOrUpdateParametersUseCase } from '@libs/organization/application/use-cases/parameters/create-or-update-use-case';

@Injectable()
export class DeleteIntegrationAndRepositoriesUseCase {
    private readonly logger = createLogger(
        DeleteIntegrationAndRepositoriesUseCase.name,
    );
    constructor(
        private readonly deleteIntegrationUseCase: DeleteIntegrationUseCase,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        @Inject(PULL_REQUEST_MESSAGES_SERVICE_TOKEN)
        private readonly pullRequestMessagesService: IPullRequestMessagesService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async execute(params: {
        organizationId: string;
        teamId: string;
    }): Promise<void> {
        const { organizationId, teamId } = params;

        try {
            // 1. First, get the list of repositories before deleting the configurations
            const repositoriesIds = await this.getRepositoriesIds(
                teamId,
                organizationId,
            );

            this.logger.log({
                message:
                    'Starting complete integration and repositories deletion',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                metadata: {
                    organizationId,
                    teamId,
                    repositoriesCount: repositoriesIds.length,
                },
            });

            // 2. Execute the existing deleteIntegrationUseCase (remove integration and config repositories)
            try {
                await this.deleteIntegrationUseCase.execute(params);

                this.logger.log({
                    message: 'Integration deleted successfully',
                    context: DeleteIntegrationAndRepositoriesUseCase.name,
                    metadata: { organizationId, teamId },
                });
            } catch (error) {
                this.logger.error({
                    message:
                        'Error deleting integration — proceeding with remaining cleanup',
                    context: DeleteIntegrationAndRepositoriesUseCase.name,
                    error,
                    metadata: { organizationId, teamId },
                });
            }

            // 3. Remove the repositories array from the code_review_config parameter
            await this.removeRepositoriesFromCodeReviewConfig(
                teamId,
                organizationId,
            );

            this.logger.log({
                message: 'Repositories removed from code review config',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                metadata: { organizationId, teamId },
            });

            // 4. Delete pullRequestMessages associated with the repositories
            await this.deletePullRequestMessages(
                organizationId,
                repositoriesIds,
            );

            this.logger.log({
                message: 'Pull request messages deleted successfully',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                metadata: {
                    organizationId,
                    teamId,
                    repositoriesCount: repositoriesIds.length,
                },
            });

            // 5. Inativar Kody rules associadas aos repositórios
            await this.inactivateKodyRules(organizationId, repositoriesIds);

            this.logger.log({
                message: 'Kody rules inactivated successfully',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                metadata: {
                    organizationId,
                    teamId,
                    repositoriesCount: repositoriesIds.length,
                },
            });

            this.logger.log({
                message:
                    'Complete integration and repositories deletion finished successfully',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                metadata: {
                    organizationId,
                    teamId,
                    repositoriesCount: repositoriesIds.length,
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Error during complete integration and repositories deletion',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                error: error,
                metadata: { organizationId, teamId },
            });
            throw error;
        }
    }

    private async getRepositoriesIds(
        teamId: string,
        organizationId: string,
    ): Promise<string[]> {
        try {
            // Get the code_review_config parameter to get the list of repositories
            const codeReviewConfig = await this.parametersService.findOne({
                configKey: ParametersKey.CODE_REVIEW_CONFIG,
                team: { uuid: teamId },
            });

            if (!codeReviewConfig?.configValue?.repositories) {
                this.logger.warn({
                    message: 'No repositories found in code review config',
                    context: DeleteIntegrationAndRepositoriesUseCase.name,
                    metadata: { teamId },
                });
                return [];
            }

            const repositories = codeReviewConfig.configValue.repositories;
            return repositories.map((repo: any) => repo.id.toString());
        } catch (error) {
            this.logger.error({
                message: 'Error getting repositories IDs',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                error: error,
                metadata: {
                    organizationAndTeamData: {
                        teamId,
                        organizationId,
                    },
                },
            });
            throw error;
        }
    }

    private async removeRepositoriesFromCodeReviewConfig(
        teamId: string,
        organizationId: string,
    ): Promise<void> {
        try {
            const codeReviewConfig = await this.parametersService.findOne({
                configKey: ParametersKey.CODE_REVIEW_CONFIG,
                team: { uuid: teamId },
            });

            if (!codeReviewConfig) {
                this.logger.warn({
                    message: 'Code review config not found',
                    context: DeleteIntegrationAndRepositoriesUseCase.name,
                    metadata: {
                        organizationAndTeamData: {
                            teamId,
                            organizationId,
                        },
                    },
                });
                return;
            }

            // Remove the repositories array from the configValue
            const updatedConfigValue = {
                ...codeReviewConfig.configValue,
                repositories: [],
            };

            await this.createOrUpdateParametersUseCase.execute(
                ParametersKey.CODE_REVIEW_CONFIG,
                updatedConfigValue,
                {
                    organizationId,
                    teamId,
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error removing repositories from code review config',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                error: error,
                metadata: {
                    organizationAndTeamData: {
                        teamId,
                        organizationId,
                    },
                },
            });
            throw error;
        }
    }

    private async deletePullRequestMessages(
        organizationId: string,
        repositoriesIds: string[],
    ): Promise<void> {
        try {
            const deletionPromises = repositoriesIds.map(
                async (repositoryId) => {
                    try {
                        const wasDeleted =
                            await this.pullRequestMessagesService.deleteByFilter(
                                {
                                    organizationId,
                                    repositoryId,
                                    configLevel: ConfigLevel.REPOSITORY,
                                },
                            );

                        this.logger.log({
                            message: 'Pull request messages deletion attempt',
                            context:
                                DeleteIntegrationAndRepositoriesUseCase.name,
                            metadata: {
                                organizationId,
                                repositoryId,
                                wasDeleted,
                            },
                        });

                        return wasDeleted;
                    } catch (error) {
                        this.logger.error({
                            message:
                                'Error deleting pull request messages for repository',
                            context:
                                DeleteIntegrationAndRepositoriesUseCase.name,
                            error: error,
                            metadata: {
                                organizationId,
                                repositoryId,
                            },
                        });
                        return false;
                    }
                },
            );

            await Promise.all(deletionPromises);
        } catch (error) {
            this.logger.error({
                message: 'Error deleting pull request messages',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                error: error,
                metadata: {
                    organizationId,
                    repositoriesCount: repositoriesIds.length,
                },
            });
            throw error;
        }
    }

    private async inactivateKodyRules(
        organizationId: string,
        repositoriesIds: string[],
    ): Promise<void> {
        try {
            const inactivationPromises = repositoriesIds.map(
                async (repositoryId) => {
                    try {
                        const result =
                            await this.kodyRulesService.updateRulesStatusByFilter(
                                organizationId,
                                repositoryId,
                                undefined,
                                KodyRulesStatus.DELETED,
                            );

                        this.logger.log({
                            message: 'Kody rules inactivation attempt',
                            context:
                                DeleteIntegrationAndRepositoriesUseCase.name,
                            metadata: {
                                organizationId,
                                repositoryId,
                                wasInactivated: !!result,
                            },
                        });

                        return result;
                    } catch (error) {
                        this.logger.error({
                            message:
                                'Error inactivating Kody rules for repository',
                            context:
                                DeleteIntegrationAndRepositoriesUseCase.name,
                            error: error,
                            metadata: {
                                organizationId,
                                repositoryId,
                            },
                        });
                        // Do not fail the main process if there is an error in a specific repository
                        return null;
                    }
                },
            );

            await Promise.all(inactivationPromises);
        } catch (error) {
            this.logger.error({
                message: 'Error inactivating Kody rules',
                context: DeleteIntegrationAndRepositoriesUseCase.name,
                error: error,
                metadata: {
                    organizationId,
                    repositoriesCount: repositoriesIds.length,
                },
            });
            throw error;
        }
    }
}
