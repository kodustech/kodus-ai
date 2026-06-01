import { createLogger } from '@kodus/flow';
import { CentralizedPrMetadata } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRule,
    KodyRuleRequestType,
    KodyRulesOrigin,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { RuleIdsDto } from '@libs/kodyRules/dtos/rule-ids.dto';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';

@Injectable()
export class ApplyPendingKodyRulesUseCase {
    private readonly logger = createLogger(ApplyPendingKodyRulesUseCase.name);

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly authorizationService: AuthorizationService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    async execute(
        body: RuleIdsDto,
    ): Promise<Array<Partial<IKodyRule> | IKodyRule> | CentralizedPrMetadata> {
        try {
            const organizationId = this.request.user.organization.uuid;
            if (!organizationId) {
                throw new Error('Organization ID not found');
            }

            const teamId =
                body.teamId ||
                (this.request.user as any)?.team?.uuid ||
                (this.request.user as any)?.teamId;
            const organizationAndTeamData = { organizationId, teamId };
            const userInfo = {
                userId: this.request.user?.uuid || 'kody-system',
                userEmail: this.request.user?.email || 'kody@kodus.io',
            };

            const allRules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    organizationId,
                    {},
                );

            const rulesById = new Map(
                allRules.map((rule) => [rule.uuid, rule]),
            );
            const pendingRules = body.ruleIds.map((ruleId) => {
                const rule = rulesById.get(ruleId);
                if (!rule) {
                    throw new Error(`Rule not found: ${ruleId}`);
                }
                return rule;
            });

            const repoIds = Array.from(
                new Set([
                    ...pendingRules
                        .map((rule) => rule.repositoryId)
                        .filter((repoId): repoId is string => !!repoId),
                    ...pendingRules
                        .map((rule) =>
                            rule.targetRuleUuid
                                ? rulesById.get(rule.targetRuleUuid)
                                      ?.repositoryId
                                : undefined,
                        )
                        .filter((repoId): repoId is string => !!repoId),
                ]),
            );

            await this.authorizationService.ensure({
                user: this.request.user,
                action: Action.Update,
                resource: ResourceType.KodyRules,
                repoIds,
            });

            const applied: Array<Partial<IKodyRule> | IKodyRule> = [];
            let centralizedPrResult: CentralizedPrMetadata | null = null;

            for (const pendingRule of pendingRules) {
                if (
                    pendingRule.requestType ===
                        KodyRuleRequestType.MEMORY_UPDATE &&
                    pendingRule.targetRuleUuid
                ) {
                    const targetRule = rulesById.get(
                        pendingRule.targetRuleUuid,
                    );

                    if (!targetRule?.uuid) {
                        throw new Error(
                            `Target rule not found: ${pendingRule.targetRuleUuid}`,
                        );
                    }

                    const updatedTarget =
                        await this.createOrUpdateKodyRulesUseCase.execute(
                            this.toCreateOrUpdateDto({
                                ...targetRule,
                                title:
                                    pendingRule.title !== undefined
                                        ? pendingRule.title
                                        : targetRule.title,
                                rule:
                                    pendingRule.rule !== undefined
                                        ? pendingRule.rule
                                        : targetRule.rule,
                                path:
                                    pendingRule.path !== undefined
                                        ? pendingRule.path
                                        : targetRule.path,
                                directoryId:
                                    pendingRule.directoryId !== undefined
                                        ? pendingRule.directoryId
                                        : targetRule.directoryId,
                                status: KodyRulesStatus.ACTIVE,
                                requestType: undefined,
                                targetRuleUuid: undefined,
                                resolvedAt: undefined,
                                resolvedBy: undefined,
                            }),
                            organizationId,
                            userInfo,
                            true,
                            teamId,
                        );

                    if (!updatedTarget) {
                        throw new Error('Failed to apply pending update');
                    }

                    if (this.isCentralizedPrMetadata(updatedTarget)) {
                        centralizedPrResult = updatedTarget;
                    } else {
                        applied.push(updatedTarget);
                    }

                    const appliedPending =
                        await this.kodyRulesService.createOrUpdate(
                            organizationAndTeamData,
                            this.toCreateOrUpdateDto({
                                ...pendingRule,
                                status: KodyRulesStatus.APPLIED,
                                resolvedAt: new Date(),
                                resolvedBy: userInfo.userId,
                            }),
                            userInfo,
                        );

                    if (!appliedPending) {
                        throw new Error(
                            'Failed to mark pending update request as applied',
                        );
                    }
                    continue;
                }

                const activatedRule =
                    await this.createOrUpdateKodyRulesUseCase.execute(
                        this.toCreateOrUpdateDto({
                            ...pendingRule,
                            status: KodyRulesStatus.ACTIVE,
                        }),
                        organizationId,
                        userInfo,
                        true,
                        teamId,
                    );

                if (!activatedRule) {
                    throw new Error('Failed to apply pending rule');
                }

                if (this.isCentralizedPrMetadata(activatedRule)) {
                    centralizedPrResult = activatedRule;
                } else {
                    applied.push(activatedRule);
                }
            }

            if (centralizedPrResult) {
                return centralizedPrResult;
            }

            return applied;
        } catch (error) {
            this.logger.error({
                message: 'Could not apply pending kody rules',
                context: ApplyPendingKodyRulesUseCase.name,
                error,
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

    private toCreateOrUpdateDto(rule: Partial<IKodyRule>): CreateKodyRuleDto {
        if (!rule.uuid) {
            throw new Error('Rule ID is required');
        }
        if (!rule.title || !rule.rule || !rule.repositoryId) {
            throw new Error(`Invalid rule payload for rule ${rule.uuid}`);
        }

        return {
            ...(rule as CreateKodyRuleDto),
            type: rule.type || KodyRulesType.STANDARD,
            origin: rule.origin || KodyRulesOrigin.GENERATED,
            severity: (rule.severity as any) || 'medium',
            path: rule.path || '',
            examples: (rule.examples as any) || [],
        };
    }
}
