import { BadGatewayException, Inject, Injectable, ServiceUnavailableException } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { RepositoryDownloadTokenError } from '@libs/platform/infrastructure/adapters/services/github/repository-download-token';

import type { OrgTeam, RuntimeRepoTokenIssuer } from '../domain/ports';

/**
 * The cell's download token (ADR-002, ADR-052): one repo, contents:read, 1 h,
 * minted by the product for each Run and never the cached installation token.
 * GitHub only for now; the other platforms answer 503 until each has its own
 * one-repo read-only token.
 */
@Injectable()
export class CodeManagementRepoTokenIssuer implements RuntimeRepoTokenIssuer {
    constructor(
        @Inject(CodeManagementService)
        private readonly codeManagement: Pick<CodeManagementService, 'getTypeIntegration'>,
        @Inject(GithubService)
        private readonly github: Pick<GithubService, 'issueRepositoryDownloadToken'>,
    ) {}

    async issue(input: OrgTeam & { repositoryId: string; repositoryName: string }): Promise<string> {
        const organizationAndTeamData = { organizationId: input.organizationId, teamId: input.teamId };
        const platform = await this.codeManagement.getTypeIntegration(organizationAndTeamData);
        if (platform !== PlatformType.GITHUB) {
            throw new ServiceUnavailableException(
                `The repository download token is not available for ${platform ?? 'an organization without a Git integration'} yet`,
            );
        }
        try {
            const { token } = await this.github.issueRepositoryDownloadToken({
                organizationAndTeamData,
                repositoryId: input.repositoryId,
            });
            return token;
        } catch (error) {
            if (error instanceof RepositoryDownloadTokenError) {
                if (error.reason === 'unexpected_scope') {
                    throw new BadGatewayException('GitHub answered a repository download token wider than asked');
                }
                throw new ServiceUnavailableException(error.message);
            }
            // Never forward the platform error: it may carry request details.
            throw new BadGatewayException('GitHub did not issue the repository download token');
        }
    }
}
