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
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import {
    GlobalRulesSourceConfig,
    GlobalRulesSourceRepository,
} from '../../domain/interfaces/global-rules-source.interface';

/**
 * Manual "resync global rules" action: re-scan every configured source
 * repository into the global scope. The per-file SHA short-circuit keeps this
 * cheap when nothing changed, and it also covers the direct-push gap (changes
 * pushed to a source repo's default branch without a PR).
 */
@Injectable()
export class ResyncGlobalRulesUseCase {
    private readonly logger = createLogger(ResyncGlobalRulesUseCase.name);

    constructor(
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        teamId: string;
        organizationId?: string;
    }): Promise<{ repositories: number }> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId:
                params.organizationId ?? this.request.user?.organization?.uuid,
            teamId: params.teamId,
        };

        const parameter = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.GLOBAL_RULES_SOURCE_REPOSITORIES,
            organizationAndTeamData,
        );
        const config = parameter?.configValue as
            | GlobalRulesSourceConfig
            | undefined;
        const repositories: GlobalRulesSourceRepository[] = Array.isArray(
            config?.repositories,
        )
            ? config.repositories
            : [];

        // Detached so the endpoint returns immediately — a full re-scan across
        // several source repos can take a while under the LLM path.
        setImmediate(async () => {
            for (const repo of repositories) {
                await this.kodyRulesSyncService.syncRepositoryGlobal({
                    organizationAndTeamData,
                    repository: {
                        id: String(repo.id),
                        name: repo.name,
                        fullName: repo.fullName,
                    },
                });
            }
        });

        this.logger.log({
            message: `[kody-rules-global-sync] manual resync kicked off for ${repositories.length} source repo(s)`,
            context: ResyncGlobalRulesUseCase.name,
            metadata: { organizationAndTeamData },
        });

        return { repositories: repositories.length };
    }
}
