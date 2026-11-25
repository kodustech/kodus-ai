import { Inject, Injectable } from '@nestjs/common';

import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationParametersAutoAssignConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';
import {
    authorFiltersFor,
    withConnectionAuthorFilters,
} from '@libs/organization/domain/organizationParameters/utils/author-filters';
import { PULL_REQUEST_MANAGER_SERVICE_TOKEN } from '@libs/code-review/domain/contracts/PullRequestManagerService.contract';
import { PullRequestHandlerService } from '@libs/code-review/infrastructure/adapters/services/pullRequestManager.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';

@Injectable()
export class IgnoreBotsUseCase implements IUseCase {
    private readonly logger = createLogger(IgnoreBotsUseCase.name);

    constructor(
        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private readonly pullRequestHandlerService: PullRequestHandlerService,

        private readonly codeManagementService: CodeManagementService,

        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {}

    /**
     * Seeds the bots found on a Git connection into the PR author ignore list.
     * A connection added beside the workspace's others (`separateConnection`),
     * or one that already has lists of its own, is seeded into its own lists:
     * git ids differ per provider and host. Otherwise the organization's.
     */
    public async execute(params: {
        organizationId: string;
        teamId: string;
        integrationId?: string;
        separateConnection?: boolean;
    }) {
        const organizationAndTeamData = {
            organizationId: params.organizationId,
            teamId: params.teamId,
            ...(params.integrationId
                ? { integrationId: params.integrationId }
                : {}),
        };

        const orgMembers = await this.codeManagementService.getListMembers({
            organizationAndTeamData,
            determineBots: true,
        });

        const prMembers =
            await this.pullRequestHandlerService.getPullRequestAuthorsWithCache(
                organizationAndTeamData,
                true,
            );

        const users = [...orgMembers, ...prMembers];

        if (users.length === 0) {
            this.logger.warn({
                message: 'No users found',
                context: IgnoreBotsUseCase.name,
                metadata: organizationAndTeamData,
            });
        }

        const botIds: string[] = Array.from(
            new Set(
                users.filter((user) => user.type === 'bot').map((b) => b.id),
            ),
        );

        const autoLicenseEntity =
            await this.organizationParametersService.findByKey(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                organizationAndTeamData,
            );

        const stored = autoLicenseEntity?.configValue as
            OrganizationParametersAutoAssignConfig | undefined;

        const ownLists =
            params.integrationId &&
            (params.separateConnection ||
                Boolean(stored?.connections?.[params.integrationId]));
        const target = ownLists ? params.integrationId : undefined;

        const current =
            target && !stored?.connections?.[target]
                ? { ignoredUsers: [], allowedUsers: [], seededBotIds: [] }
                : authorFiltersFor(stored, target);

        // Only bots never seeded before are added. Re-adding every bot found
        // would undo an admin's decision to review one, the case that matters
        // being an app authoring PRs on a paid seat.
        const seededBotIds = new Set(current.seededBotIds);
        const newBotIds = botIds.filter((id) => !seededBotIds.has(id));

        const base: OrganizationParametersAutoAssignConfig = stored ?? {
            enabled: false,
            ignoredUsers: [],
            allowedUsers: [],
        };

        const next = withConnectionAuthorFilters(base, target, {
            ignoredUsers: Array.from(
                new Set([...current.ignoredUsers, ...newBotIds]),
            ),
            allowedUsers: current.allowedUsers,
            seededBotIds: Array.from(new Set([...seededBotIds, ...botIds])),
        });

        this.logger.log({
            message: 'pr_author_bots_seeded',
            context: IgnoreBotsUseCase.name,
            metadata: {
                ...organizationAndTeamData,
                connectionLists: Boolean(target),
                created: !stored,
                newBots: newBotIds.length,
            },
        });

        await this.organizationParametersService.createOrUpdateConfig(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            next,
            organizationAndTeamData,
        );
    }
}
