import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import {
    GlobalRulesSourceConfig,
    GlobalRulesSourceRepository,
} from '../../domain/interfaces/global-rules-source.interface';

@Injectable()
export class GetGlobalRulesSourceRepositoriesUseCase {
    private readonly logger = createLogger(
        GetGlobalRulesSourceRepositoriesUseCase.name,
    );

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        teamId: string;
        organizationId?: string;
    }): Promise<GlobalRulesSourceRepository[]> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId:
                params.organizationId ?? this.request.user?.organization?.uuid,
            teamId: params.teamId,
        };

        try {
            const parameter =
                await this.organizationParametersService.findByKey(
                    OrganizationParametersKey.GLOBAL_RULES_SOURCE_REPOSITORIES,
                    organizationAndTeamData,
                );

            const config = parameter?.configValue as
                | GlobalRulesSourceConfig
                | undefined;

            return Array.isArray(config?.repositories)
                ? config.repositories
                : [];
        } catch (error) {
            this.logger.error({
                message: 'Failed to get global rules source repositories',
                context: GetGlobalRulesSourceRepositoriesUseCase.name,
                error,
                metadata: { organizationAndTeamData },
            });
            return [];
        }
    }
}
