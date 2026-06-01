import { createLogger } from '@kodus/flow';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { CentralizedPrMetadata } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IKodyRule,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { ChangeStatusKodyRulesDTO } from '@libs/kodyRules/dtos/change-status-kody-rules.dto';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from './delete-rule-in-organization-by-id.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';

export class ChangeStatusKodyRulesUseCase {
    private readonly logger = createLogger(ChangeStatusKodyRulesUseCase.name);
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly deleteRuleInOrganizationByIdKodyRulesUseCase: DeleteRuleInOrganizationByIdKodyRulesUseCase,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
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

    async execute(
        body: ChangeStatusKodyRulesDTO,
    ): Promise<Array<Partial<IKodyRule> | IKodyRule> | CentralizedPrMetadata> {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            const { ruleIds, status } = body;
            const teamId =
                body.teamId ||
                (this.request.user as any)?.team?.uuid ||
                (this.request.user as any)?.teamId;
            const organizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
                teamId,
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
            let centralizedPrResult: CentralizedPrMetadata | null = null;
            const userInfo = {
                userId: this.request.user?.uuid || 'kody-system',
                userEmail: this.request.user?.email || 'kody@kodus.io',
            };

            const shouldUseCentralizedDelete =
                status === KodyRulesStatus.DELETED &&
                Boolean(
                    await this.centralizedConfigPrService.getCentralizedRepositoryIfEnabled(
                        organizationAndTeamData,
                    ),
                );

            for (const rule of targetRules) {
                let result:
                    | Partial<IKodyRule>
                    | IKodyRule
                    | CentralizedPrMetadata
                    | boolean
                    | null = null;

                if (status === KodyRulesStatus.ACTIVE) {
                    result = await this.createOrUpdateKodyRulesUseCase.execute(
                        {
                            ...(rule as any),
                            status,
                        },
                        organizationAndTeamData.organizationId,
                        userInfo,
                        true,
                        teamId,
                    );
                } else if (shouldUseCentralizedDelete) {
                    result =
                        await this.deleteRuleInOrganizationByIdKodyRulesUseCase.execute(
                            rule.uuid,
                            {
                                source: 'web',
                                organizationId:
                                    organizationAndTeamData.organizationId,
                                teamId,
                                userId: userInfo.userId,
                                userEmail: userInfo.userEmail,
                            },
                        );

                    if (typeof result === 'boolean') {
                        // Centralized delete routing should never return direct boolean.
                        throw new Error(
                            'Expected centralized PR metadata for delete operation',
                        );
                    }
                } else {
                    result = await this.kodyRulesService.createOrUpdate(
                        organizationAndTeamData,
                        {
                            ...rule,
                            status,
                        },
                        userInfo,
                    );
                }

                if (!result) {
                    throw new Error(
                        'Failed to change status pending Kody rule',
                    );
                }

                if (this.isCentralizedPrMetadata(result)) {
                    centralizedPrResult = result;
                } else {
                    updated.push(result);
                }
            }

            if (centralizedPrResult) {
                return centralizedPrResult;
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

    private isCentralizedPrMetadata(
        value: Partial<IKodyRule> | IKodyRule | CentralizedPrMetadata,
    ): value is CentralizedPrMetadata {
        return (
            typeof value === 'object' &&
            value !== null &&
            'mode' in value &&
            (value as { mode?: string }).mode === 'centralized-pr'
        );
    }
}
