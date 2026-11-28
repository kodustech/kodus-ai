import { Inject, Injectable } from '@nestjs/common';

import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationParametersAutoAssignConfig } from '@libs/organization/domain/organizationParameters/types/organizationParameters.types';
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

        if (!botIds.length) return;

        const autoLicenseEntity =
            await this.organizationParametersService.findByKey(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                organizationAndTeamData,
            );
        const stored = autoLicenseEntity?.configValue as
            OrganizationParametersAutoAssignConfig | undefined;

        // A connection added beside others, or one that already has lists of
        // its own, is seeded into them; the workspace's first, into the
        // organization's.
        const ownLists =
            params.integrationId &&
            (params.separateConnection ||
                Boolean(stored?.connections?.[params.integrationId]));
        const target = ownLists ? params.integrationId : undefined;

        // Written in one statement against the stored lists: only bots never
        // seeded before are ignored (an admin may have chosen to review one,
        // e.g. an app authoring PRs on a paid seat), and the allow list is
        // never touched, so a filters save landing meanwhile stays.
        await this.organizationParametersService.seedBotIds(
            params.organizationId,
            botIds,
            target ? { connectionId: target } : {},
        );

        this.logger.log({
            message: 'pr_author_bots_seeded',
            context: IgnoreBotsUseCase.name,
            metadata: {
                ...organizationAndTeamData,
                connectionLists: Boolean(target),
                bots: botIds.length,
            },
        });
    }

    /**
     * A connection added beside others gets lists of its own at once, empty,
     * so until its bots are found it never reads another connection's (an
     * allow-list there would skip every PR on it).
     */
    async claimConnectionLists(params: {
        organizationId: string;
        integrationId: string;
    }): Promise<void> {
        await this.organizationParametersService.mergeConfigValue(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            params.organizationId,
            { ignoredUsers: [], allowedUsers: [], seededBotIds: [] },
            { connectionId: params.integrationId, onlyIfAbsent: true },
        );
    }
}
