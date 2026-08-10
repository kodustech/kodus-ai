import { Inject, Injectable } from '@nestjs/common';

import { IContextResolutionService } from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';
import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';

@Injectable()
export class ContextResolutionService implements IContextResolutionService {
    constructor(
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async getTeamIdByOrganizationAndRepository(
        organizationId: string,
        repositoryId: string,
    ): Promise<string> {
        // Prior version fetched active integrations first, then issued
        // one `find({ integration: { uuid } })` per integration inside a
        // sequential loop — a textbook 1+N on the code-review hot path.
        // The repository method below collapses it to a single JOIN
        // query over integration_configs → integrations → organization.
        const integrationConfigs =
            await this.integrationConfigService.findByOrganizationAndConfigKey(
                organizationId,
                IntegrationConfigKey.REPOSITORIES,
            );

        if (!integrationConfigs || integrationConfigs.length === 0) {
            throw new Error('No active integrations found for organization');
        }

        for (const config of integrationConfigs) {
            const repositories = config.configValue;

            if (Array.isArray(repositories)) {
                const foundRepository = repositories.find(
                    (repo: any) =>
                        repo.id === repositoryId ||
                        repo.id === repositoryId.toString(),
                );

                if (foundRepository) {
                    return config?.team?.uuid;
                }
            }
        }

        throw new Error(
            `Repository with id ${repositoryId} not found in any integration config`,
        );
    }

    async getDirectoryPathByOrganizationAndRepository(
        organizationId: string,
        repositoryId: string,
        directoryId: string,
    ): Promise<string> {
        if (!organizationId || !repositoryId || !directoryId) {
            return '';
        }

        // 1. Get the teamId using the previous method
        const teamId = await this.getTeamIdByOrganizationAndRepository(
            organizationId,
            repositoryId,
        );

        // 2. Search the PARAMETERS table for the CODE_REVIEW_CONFIG key
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            { organizationId, teamId },
        );

        if (!codeReviewConfig) {
            throw new Error('Code review config not found');
        }

        // 3. Search the repository list for the one matching repositoryId
        const repositories = codeReviewConfig.configValue.repositories;
        if (!repositories || !Array.isArray(repositories)) {
            throw new Error('No repositories found in code review config');
        }

        const targetRepository = repositories.find(
            (repo: any) =>
                repo.id === repositoryId || repo.id === repositoryId.toString(),
        );

        if (!targetRepository) {
            throw new Error(
                `Repository with id ${repositoryId} not found in code review config`,
            );
        }

        // 4. Search the directories node for the path matching directoryId
        const directories = targetRepository.directories;
        if (!directories || !Array.isArray(directories)) {
            throw new Error(
                `No directories found for repository ${repositoryId}`,
            );
        }

        const targetDirectory = directories.find(
            (dir: any) =>
                dir.id === directoryId || dir.id === directoryId.toString(),
        );

        if (!targetDirectory) {
            throw new Error(
                `Directory with id ${directoryId} not found for repository ${repositoryId}`,
            );
        }

        return targetDirectory.path;
    }

    async getRepositoryNameByOrganizationAndRepository(
        organizationId: string,
        repositoryId: string,
    ): Promise<string> {
        if (!organizationId || !repositoryId) {
            return '';
        }

        // 1. Get the teamId using the previous method
        const teamId = await this.getTeamIdByOrganizationAndRepository(
            organizationId,
            repositoryId,
        );

        // 2. Search the PARAMETERS table for the CODE_REVIEW_CONFIG key
        const codeReviewConfig = await this.parametersService.findByKey(
            ParametersKey.CODE_REVIEW_CONFIG,
            { organizationId, teamId },
        );

        if (!codeReviewConfig) {
            throw new Error('Code review config not found');
        }

        // 3. Search the repository list for the one matching repositoryId
        const repositories = codeReviewConfig.configValue.repositories;
        if (!repositories || !Array.isArray(repositories)) {
            throw new Error('No repositories found in code review config');
        }

        const targetRepository = repositories.find(
            (repo: any) =>
                repo.id === repositoryId || repo.id === repositoryId.toString(),
        );

        if (!targetRepository) {
            throw new Error(
                `Repository with id ${repositoryId} not found in code review config`,
            );
        }

        return targetRepository.name;
    }
}
