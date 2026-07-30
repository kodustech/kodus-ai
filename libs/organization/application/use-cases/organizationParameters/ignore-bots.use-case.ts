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

    public async execute(params: { organizationId: string; teamId: string }) {
        const organizationAndTeamData = {
            organizationId: params.organizationId,
            teamId: params.teamId,
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
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
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

        if (!autoLicenseEntity || !autoLicenseEntity?.configValue) {
            this.logger.warn({
                message:
                    'Auto license assignment config not found, creating one',
                context: IgnoreBotsUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            await this.organizationParametersService.createOrUpdateConfig(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                {
                    enabled: false,
                    ignoredUsers: botIds,
                    allowedUsers: [],
                },
                organizationAndTeamData,
            );
        } else {
            this.logger.debug({
                message: 'Auto license assignment config found',
                context: IgnoreBotsUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                },
            });

            const autoLicenseConfig =
                autoLicenseEntity.configValue as OrganizationParametersAutoAssignConfig;

            autoLicenseConfig.allowedUsers =
                autoLicenseConfig.allowedUsers || [];

            const allIgnored = new Set([
                ...autoLicenseConfig.ignoredUsers,
                ...botIds,
            ]);

            autoLicenseConfig.ignoredUsers = Array.from(allIgnored);

            await this.organizationParametersService.createOrUpdateConfig(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                autoLicenseConfig,
                organizationAndTeamData,
            );
        }
    }
}
