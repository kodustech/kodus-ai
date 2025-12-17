import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { OrganizationParametersAutoAssignConfig } from '@/core/domain/organizationParameters/types/organizationParameters.types';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';

@Injectable()
export class UpdateAutoLicenseAllowedUsersUseCase {
    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        includeCurrentUser?: boolean;
    }) {
        const { organizationAndTeamData } = params;

        this.logger.log({
            message: 'Updating auto license allowed users',
            context: 'UpdateAutoLicenseAllowedUsersUseCase',
            metadata: {
                organizationAndTeamData,
            },
        });

        if (!organizationAndTeamData?.organizationId) {
            throw new BadRequestException('organizationId is required');
        }

        const existing = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            organizationAndTeamData,
        );

        const config: OrganizationParametersAutoAssignConfig = {
            enabled: existing?.configValue?.enabled ?? false,
            ignoredUsers: existing?.configValue?.ignoredUsers ?? [],
            allowedUsers: existing?.configValue?.allowedUsers ?? [],
        };

        const merged = new Set<string>(
            (Array.isArray(config.allowedUsers) ? config.allowedUsers : []).map(
                (id) => String(id),
            ),
        );

        const shouldIncludeCurrentUser =
            params.includeCurrentUser !== false; /* default true */

        if (shouldIncludeCurrentUser) {
            const currentUser = await this.codeManagementService.getCurrentUser(
                {
                    organizationAndTeamData,
                },
            );

            const currentId =
                currentUser?.id ||
                currentUser?.uuid ||
                currentUser?.login ||
                currentUser?.username ||
                currentUser?.email;

            if (!currentId) {
                throw new BadRequestException(
                    'Unable to resolve current code-management user',
                );
            }

            merged.add(String(currentId));
        }

        config.allowedUsers = Array.from(merged);

        return this.organizationParametersService.createOrUpdateConfig(
            OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT,
            config,
            organizationAndTeamData,
        );
    }
}
