import { NotFoundException } from '@nestjs/common';

import type { CustomAgentRepositoryRef } from '@libs/code-review/domain/custom-agents/contracts';
import { ParametersKey } from '@libs/core/domain/enums';
import type { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { IParametersService } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import type { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/** The stored code review config of a team, or undefined when none exists. */
export async function loadCodeReviewConfigValue(
    parametersService: Pick<IParametersService, 'findByKey'>,
    organizationAndTeamData: OrganizationAndTeamData,
) {
    const parameter = await parametersService.findByKey(
        ParametersKey.CODE_REVIEW_CONFIG,
        organizationAndTeamData,
    );
    return parameter?.configValue;
}

/**
 * The repository a draft is checked against, with its default branch: the
 * branch the next pull request targets, which is where skills and docs are
 * read from at review time.
 */
export async function resolveRepositoryRef(params: {
    configValue: Awaited<ReturnType<typeof loadCodeReviewConfigValue>>;
    codeManagementService: Pick<CodeManagementService, 'getDefaultBranch'>;
    organizationAndTeamData: OrganizationAndTeamData;
    repositoryId: string;
}): Promise<CustomAgentRepositoryRef> {
    const repository = params.configValue?.repositories?.find(
        (candidate) => candidate?.id === params.repositoryId,
    );
    if (!repository) {
        throw new NotFoundException('Repository not found in this team');
    }

    const branch = await params.codeManagementService.getDefaultBranch({
        organizationAndTeamData: params.organizationAndTeamData,
        repository: { id: repository.id, name: repository.name },
    });

    return { id: repository.id, name: repository.name, branch };
}
