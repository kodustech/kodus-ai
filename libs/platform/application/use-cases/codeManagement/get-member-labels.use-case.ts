import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { createLogger } from '@libs/core/log/logger';
import {
    IPullRequestsService,
    PULL_REQUESTS_SERVICE_TOKEN,
} from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';

const MAX_IDS = 500;

/**
 * Names a seat holder the member list no longer has, from the PRs the
 * organization stored. Read only from storage: the provider is what failed or
 * forgot this person, so asking it again would hit the same limit. Anyone who
 * never opened a PR has no stored name and is left out.
 */
@Injectable()
export class GetMemberLabelsUseCase implements IUseCase {
    private readonly logger = createLogger(GetMemberLabelsUseCase.name);

    constructor(
        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    public async execute(
        teamId: string | undefined,
        ids: string[],
    ): Promise<Record<string, string>> {
        const organizationId = this.request.user.organization.uuid;
        const uniqueIds = [...new Set(ids.map((id) => id.trim()))]
            .filter(Boolean)
            .slice(0, MAX_IDS);

        if (!uniqueIds.length) {
            return {};
        }

        try {
            const rows =
                await this.pullRequestsService.findPullRequestAuthorLabelsByIds(
                    organizationId,
                    uniqueIds,
                );

            const labels: Record<string, string> = {};
            for (const row of rows) {
                const name = row.name?.trim();
                const username = row.username?.trim();
                const label =
                    name && username && name !== username
                        ? `${name} (${username})`
                        : name || username;
                if (label) {
                    labels[row.id] = label;
                }
            }

            return labels;
        } catch (error) {
            this.logger.warn({
                message: 'Could not read stored names for seat holders',
                context: GetMemberLabelsUseCase.name,
                error,
                metadata: { organizationId, teamId },
            });

            return {};
        }
    }
}
