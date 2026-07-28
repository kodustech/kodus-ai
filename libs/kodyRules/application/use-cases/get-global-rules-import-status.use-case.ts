import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { KodyRulesSyncService } from '@libs/kodyRules/infrastructure/adapters/services/kodyRulesSync.service';
import {
    GLOBAL_RULES_TRIAL_IMPORT_LIMIT,
    GlobalRulesImportStatus,
} from '../../domain/interfaces/global-rules-source.interface';

/**
 * Reports the org's global-rules import quota so the UI can render the right
 * state: gray-out + upgrade CTA (free), a counter + confirmation (trial), or an
 * unrestricted control (paid). The backend stays the single source of truth —
 * the client never re-derives the plan.
 */
@Injectable()
export class GetGlobalRulesImportStatusUseCase {
    private readonly logger = createLogger(
        GetGlobalRulesImportStatusUseCase.name,
    );

    constructor(
        private readonly permissionValidationService: PermissionValidationService,
        private readonly kodyRulesSyncService: KodyRulesSyncService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        teamId: string;
        organizationId?: string;
    }): Promise<GlobalRulesImportStatus> {
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId:
                params.organizationId ?? this.request.user?.organization?.uuid,
            teamId: params.teamId,
        };

        try {
            const tier =
                await this.permissionValidationService.resolveGlobalRulesImportTier(
                    organizationAndTeamData,
                    GetGlobalRulesImportStatusUseCase.name,
                );

            const used =
                await this.kodyRulesSyncService.countGlobalSyncedRules(
                    organizationAndTeamData,
                );

            const limit =
                tier === 'free'
                    ? 0
                    : tier === 'trial'
                      ? GLOBAL_RULES_TRIAL_IMPORT_LIMIT
                      : null;

            const remaining =
                limit === null ? null : Math.max(0, limit - used);

            return { tier, limit, used, remaining };
        } catch (error) {
            this.logger.error({
                message: 'Failed to resolve global rules import status',
                context: GetGlobalRulesImportStatusUseCase.name,
                error,
                metadata: { organizationAndTeamData },
            });
            // Fail closed: treat as Free (feature locked) if we can't tell.
            return { tier: 'free', limit: 0, used: 0, remaining: 0 };
        }
    }
}
