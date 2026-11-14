import { Inject, Injectable } from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    INTEGRATION_CONFIG_SERVICE_TOKEN,
    type IIntegrationConfigService,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import type { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';

import type {
    PublishRepository,
    RepositoryResolver,
} from '../domain/runtime-publish.ports';

/** Resolves a repository from the REPOSITORIES integration config of the org and team. */
@Injectable()
export class IntegrationConfigRepositoryResolver implements RepositoryResolver {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async resolve(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<PublishRepository | null> {
        const repos =
            await this.integrationConfigService.findIntegrationConfigFormatted<
                Partial<Repositories>[]
            >(IntegrationConfigKey.REPOSITORIES, organizationAndTeamData);
        const repo = Array.isArray(repos)
            ? repos.find(
                  (r) =>
                      r?.id !== undefined &&
                      String(r.id) === String(repositoryId),
              )
            : undefined;
        if (!repo?.name) {
            return null;
        }
        return toPublishRepository(
            repo as Partial<Repositories> & { name: string },
        );
    }
}

export function toPublishRepository(
    repo: Partial<Repositories> & { name: string },
): PublishRepository {
    const fullName =
        repo.full_name ||
        (repo.organizationName
            ? `${repo.organizationName}/${repo.name}`
            : repo.name);
    const slash = fullName.lastIndexOf('/');
    return {
        id: String(repo.id),
        name: repo.name,
        owner:
            slash > 0
                ? fullName.slice(0, slash)
                : (repo.organizationName ?? ''),
        fullName,
    };
}
