import { createLogger } from '@kodus/flow';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { ChangeStatusKodyRulesDTO } from '@libs/kodyRules/dtos/change-status-kody-rules.dto';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';

export class ChangeStatusKodyRulesUseCase {
    private readonly logger = createLogger(ChangeStatusKodyRulesUseCase.name);
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly authorizationService: AuthorizationService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid?: string;
                email?: string;
            };
        },
    ) {}

    async execute(body: ChangeStatusKodyRulesDTO) {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            const { ruleIds, status } = body;
            const organizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
            };

            const rules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    this.request.user.organization.uuid,
                    {},
                );

            const rulesMap = new Map(rules.map((rule) => [rule.uuid, rule]));

            const targetRules = ruleIds.map((ruleId) => {
                const rule = rulesMap.get(ruleId);

                if (!rule) {
                    throw new Error(`Rule not found: ${ruleId}`);
                }

                return rule;
            });

            const repoIds = Array.from(
                new Set(
                    targetRules
                        .map((rule) => rule.repositoryId)
                        .filter((repoId): repoId is string => !!repoId),
                ),
            );

            await this.authorizationService.ensure({
                user: this.request.user,
                action: Action.Update,
                resource: ResourceType.KodyRules,
                repoIds,
            });

            const updated = [];
            const userInfo = {
                userId: this.request.user?.uuid || 'kody-system',
                userEmail: this.request.user?.email || 'kody@kodus.io',
            };

            for (const rule of targetRules) {
                const result = await this.kodyRulesService.createOrUpdate(
                    organizationAndTeamData,
                    {
                        ...rule,
                        status,
                    },
                    userInfo,
                );

                if (!result) {
                    throw new Error(
                        'Failed to change status pending Kody rule',
                    );
                }

                updated.push(result);
            }

            return updated;
        } catch (error) {
            this.logger.error({
                message: 'Could not change status pending Kody rules',
                context: ChangeStatusKodyRulesUseCase.name,
                serviceName: 'ChangeStatusPendingKodyRulesUseCase',
                error: error,
                metadata: {
                    body,
                },
            });
            throw error;
        }
    }
}
