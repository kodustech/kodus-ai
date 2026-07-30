import { Inject, Injectable } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
} from '../interfaces/license.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { createLogger } from '@libs/core/log/logger';

@Injectable()
export class AutoAssignLicenseUseCase {
    private readonly logger = createLogger(AutoAssignLicenseUseCase.name);

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        userGitId: string;
        prNumber: number;
        prCount: number;
        repositoryName: string;
        provider: string;
    }): Promise<{
        shouldProceed: boolean;
        reason:
            | 'FREEBIE'
            | 'ASSIGNED'
            | 'ALREADY_LICENSED'
            | 'ASSIGNMENT_FAILED'
            | 'AUTO_ASSIGN_DISABLED'
            | 'NOT_ENOUGH_PRS'
            | 'IGNORED_USER'
            | 'NOT_ALLOWED_USER';
    }> {
        const { organizationAndTeamData, userGitId, provider } = params;

        try {
            // 1. Check if Auto License Assignment is enabled
            const config = await this.organizationParametersService.findByKey(
                OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
                organizationAndTeamData,
            );

            if (!config?.configValue?.enabled) {
                return { shouldProceed: false, reason: 'AUTO_ASSIGN_DISABLED' };
            }

            // 2. If allowedUsers is set, only those users are eligible
            if (
                Array.isArray(config?.configValue?.allowedUsers) &&
                config.configValue.allowedUsers.length > 0 &&
                !config.configValue.allowedUsers.includes(userGitId)
            ) {
                return { shouldProceed: false, reason: 'NOT_ALLOWED_USER' };
            }

            // 3. Check if user already has a license (double check)
            const usersWithLicense =
                await this.licenseService.getAllUsersWithLicense(
                    organizationAndTeamData,
                );
            const hasLicense = usersWithLicense.some(
                (u) => u.git_id === userGitId,
            );

            if (hasLicense) {
                return { shouldProceed: true, reason: 'ALREADY_LICENSED' };
            }

            // 4. Check if user is ignored
            if (config?.configValue?.ignoredUsers?.length > 0) {
                if (config?.configValue?.ignoredUsers.includes(userGitId)) {
                    return { shouldProceed: false, reason: 'IGNORED_USER' };
                }
            }

            // 5. Use the provided PR count
            const { prCount } = params;

            // If it's the first PR (or less), it's a freebie
            if (prCount <= 1) {
                return { shouldProceed: true, reason: 'FREEBIE' };
            }

            // 6. If user has 2 or more PRs, assign license
            this.logger.log({
                message: `Auto-assigning license to user ${userGitId}`,
                context: AutoAssignLicenseUseCase.name,
                metadata: {
                    ...organizationAndTeamData,
                    userGitId,
                    prCount,
                },
            });
            const assigned = await this.licenseService.assignLicense(
                organizationAndTeamData,
                userGitId,
                provider,
            );

            if (assigned) {
                return { shouldProceed: true, reason: 'ASSIGNED' };
            } else {
                return { shouldProceed: false, reason: 'ASSIGNMENT_FAILED' };
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to auto-assign license',
                error,
                context: AutoAssignLicenseUseCase.name,
                metadata: { ...organizationAndTeamData, userGitId },
            });
            return { shouldProceed: false, reason: 'ASSIGNMENT_FAILED' };
        }
    }
}
