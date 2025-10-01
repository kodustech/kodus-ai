import { Injectable, Inject } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { IParametersService, PARAMETERS_SERVICE_TOKEN } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CodeReviewConfig } from '@/config/types/general/codeReview.type';
import { AuthorizationService } from '@/core/infrastructure/adapters/services/permissions/authorization.service';
import { Action, ResourceType } from '@/core/domain/permissions/enums/permissions.enum';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { BadRequestException, ForbiddenException } from '@nestjs/common';

@Injectable()
export class UpdateFineTuningToggleUseCase implements IUseCase {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly authorizationService: AuthorizationService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(params: {
        user: IUser;
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        fineTuningEnabled: boolean;
    }): Promise<boolean> {
        const { user, organizationAndTeamData, repositoryId, fineTuningEnabled } = params;

        try {
            // Check if user has permission to update code review settings for this repository
            await this.authorizationService.ensure({
                user,
                action: Action.Update,
                resource: ResourceType.CodeReviewSettings,
                repoIds: [repositoryId],
            });

            // Get current code review configuration
            const currentConfig = await this.parametersService.findOne({
                configKey: ParametersKey.CODE_REVIEW_CONFIG,
                team: { uuid: organizationAndTeamData.teamId },
            });

            if (!currentConfig) {
                throw new BadRequestException('Code review configuration not found');
            }

            const configValue = currentConfig.configValue as {
                repositories: any[];
                global: any;
            };

            // Find and update the specific repository configuration
            const repositoryIndex = configValue.repositories.findIndex(
                (repo) => repo.id === repositoryId,
            );

            if (repositoryIndex === -1) {
                throw new BadRequestException('Repository not found in configuration');
            }

            // Update the fine-tuning toggle for this repository
            if (!configValue.repositories[repositoryIndex].kodyFineTuningConfig) {
                configValue.repositories[repositoryIndex].kodyFineTuningConfig = {};
            }

            configValue.repositories[repositoryIndex].kodyFineTuningConfig.fineTuningEnabled = fineTuningEnabled;

            // Save the updated configuration
            await this.parametersService.createOrUpdateConfig(
                ParametersKey.CODE_REVIEW_CONFIG,
                configValue,
                organizationAndTeamData,
            );

            this.logger.info({
                message: 'Fine-tuning toggle updated successfully',
                context: UpdateFineTuningToggleUseCase.name,
                metadata: {
                    repositoryId,
                    fineTuningEnabled,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            return true;
        } catch (error) {
            if (error instanceof ForbiddenException) {
                throw error;
            }

            this.logger.error({
                message: 'Error updating fine-tuning toggle',
                context: UpdateFineTuningToggleUseCase.name,
                error: error.message,
                metadata: {
                    repositoryId,
                    fineTuningEnabled,
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            throw new BadRequestException('Failed to update fine-tuning toggle');
        }
    }
}
