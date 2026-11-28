import { Inject, Injectable } from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { createLogger } from '@libs/core/log/logger';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';
import {
    recordedNameMatches,
    RepositoryNames,
    repositoryNamesOf,
} from '@libs/integrations/domain/integrations/utils/repository-names';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { PullRequestsEntity } from '@libs/platformData/domain/pullRequests/entities/pullRequests.entity';
import { IPullRequests } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { Repositories } from '@libs/platform/domain/platformIntegrations/types/codeManagement/repositories.type';

type Lookup = Partial<IPullRequests> & Record<string, unknown>;

/**
 * The pull request a team key asks about, among its own workspace's. The
 * same repository id, name and number can name a pull request on another
 * server, so every record a lookup finds is checked against the
 * repositories the workspace lists; records that match alike cannot be told
 * apart (they keep no host) and answer none.
 */
@Injectable()
export class FindTeamKeyPullRequestUseCase {
    private readonly logger = createLogger(FindTeamKeyPullRequestUseCase.name);

    constructor(
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    async execute(params: {
        organizationId: string;
        teamId?: string;
        prUrl?: string;
        repositoryId?: string;
        prNumber?: string;
    }): Promise<PullRequestsEntity | null> {
        const { organizationId, teamId } = params;
        if (!teamId) return null;

        let listed: Map<string, RepositoryNames> | undefined;
        for (const lookup of this.lookups(params)) {
            const records =
                (await this.pullRequestsService.find(lookup as any)) ?? [];
            if (!records.length) continue;
            listed ??= await this.workspaceRepositories(organizationId, teamId);
            const matching = records.filter((record) =>
                this.listsRepository(listed!, record.toObject()?.repository),
            );
            if (matching.length > 1) {
                this.logger.warn({
                    message: 'team_key_pull_request_ambiguous',
                    context: FindTeamKeyPullRequestUseCase.name,
                    metadata: {
                        organizationId,
                        teamId,
                        repositoryId: params.repositoryId,
                        prNumber: params.prNumber,
                        candidates: matching.length,
                    },
                });
                return null;
            }
            if (matching.length) return matching[0];
        }
        return null;
    }

    /** The lookups to try, in order: the URL, then what it or the call names. */
    private lookups(params: {
        organizationId: string;
        prUrl?: string;
        repositoryId?: string;
        prNumber?: string;
    }): Lookup[] {
        const { organizationId, prUrl, repositoryId, prNumber } = params;
        if (prUrl) {
            const lookups: Lookup[] = [{ url: prUrl, organizationId }];
            const match = prUrl.match(
                /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i,
            );
            if (match) {
                lookups.push({
                    'number': Number(match[3]),
                    organizationId,
                    'repository.fullName': `${match[1]}/${match[2]}`,
                });
            }
            return lookups;
        }
        const number = prNumber ? parseInt(prNumber, 10) : NaN;
        if (!repositoryId || Number.isNaN(number)) return [];
        return [
            { number, organizationId, 'repository.id': repositoryId },
            // A caller may pass the full name as the repository id.
            { number, organizationId, 'repository.fullName': repositoryId },
        ];
    }

    private async workspaceRepositories(
        organizationId: string,
        teamId: string,
    ): Promise<Map<string, RepositoryNames>> {
        const repositories =
            (await this.integrationConfigService.findIntegrationConfigFormatted<
                Repositories[]
            >(IntegrationConfigKey.REPOSITORIES, { organizationId, teamId })) ??
            [];
        const byId = new Map<string, RepositoryNames>();
        for (const repository of repositories) {
            const id = String(repository.id);
            const names = repositoryNamesOf(
                repository as unknown as Record<string, unknown>,
            );
            const known = byId.get(id);
            byId.set(
                id,
                known
                    ? {
                          full: [...known.full, ...names.full],
                          bare: [...known.bare, ...names.bare],
                      }
                    : names,
            );
        }
        return byId;
    }

    /**
     * The recorded name has to match too; a record without one cannot be
     * told apart and is refused. A listing with no name of the recorded form
     * is matched by id alone.
     */
    private listsRepository(
        listed: Map<string, RepositoryNames>,
        repository: { id?: unknown; fullName?: string } | undefined,
    ): boolean {
        if (repository?.id == null || !repository.fullName) return false;
        const names = listed.get(String(repository.id));
        if (!names) return false;
        return recordedNameMatches(names, repository.fullName) !== false;
    }
}
