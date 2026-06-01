import { createLogger } from '@kodus/flow';
import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import { RuleIdsDto } from '@libs/kodyRules/dtos/rule-ids.dto';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    IKodyRule,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { ChangeStatusKodyRulesUseCase } from './change-status-kody-rules.use-case';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { FindRulesInOrganizationByRuleFilterKodyRulesUseCase } from './find-rules-in-organization-by-filter.use-case';

@Injectable()
export class ConvertPendingUpdatesToMemoriesUseCase {
    private readonly logger = createLogger(
        ConvertPendingUpdatesToMemoriesUseCase.name,
    );

    constructor(
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly findRulesInOrganizationByRuleFilterKodyRulesUseCase: FindRulesInOrganizationByRuleFilterKodyRulesUseCase,
        private readonly changeStatusKodyRulesUseCase: ChangeStatusKodyRulesUseCase,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
        private readonly authorizationService: AuthorizationService,
        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    public async execute(
        body: RuleIdsDto,
    ): Promise<Array<Partial<IKodyRule>> | CentralizedPrMetadata> {
        const organizationId = this.request.user.organization.uuid;
        if (!organizationId) {
            throw new Error('Organization ID not found');
        }

        const teamId =
            body.teamId ||
            (this.request.user as any)?.team?.uuid ||
            (this.request.user as any)?.teamId;

        const rulesToConvert = await this.getRulesByIds(
            organizationId,
            body.ruleIds,
        );

        const repoIds = Array.from(
            new Set(
                rulesToConvert
                    .map((rule) => rule.repositoryId)
                    .filter((repoId): repoId is string => !!repoId),
            ),
        );

        await this.authorizationService.ensure({
            user: this.request.user,
            action: Action.Create,
            resource: ResourceType.KodyRules,
            repoIds,
        });

        const userInfo = {
            userId: this.request.user?.uuid || 'kody-system',
            userEmail: this.request.user?.email || 'kody@kodus.io',
        };

        const createdRules: Array<Partial<IKodyRule>> = [];
        let centralizedPrResult: CentralizedPrMetadata | null = null;

        for (const rule of rulesToConvert) {
            const created = await this.createOrUpdateKodyRulesUseCase.execute(
                {
                    ...rule,
                    uuid: undefined,
                    status: KodyRulesStatus.ACTIVE,
                    type: rule.type,
                    origin: rule.origin,
                    requestType: undefined,
                    targetRuleUuid: undefined,
                    resolvedAt: undefined,
                    resolvedBy: undefined,
                    centralizedConfig: undefined,
                },
                organizationId,
                userInfo,
                true,
                teamId,
            );

            if (created) {
                if (this.isCentralizedPrMetadata(created)) {
                    centralizedPrResult = created;
                } else {
                    createdRules.push(created);
                }

                await this.changeStatusKodyRulesUseCase.execute({
                    ruleIds: [rule.uuid],
                    status: KodyRulesStatus.REJECTED,
                });
            }
        }

        if (centralizedPrResult) {
            return centralizedPrResult;
        }

        return createdRules;
    }

    private isCentralizedPrMetadata(
        value: Partial<IKodyRule> | CentralizedPrMetadata,
    ): value is CentralizedPrMetadata {
        return (
            typeof value === 'object' &&
            value !== null &&
            'mode' in value &&
            (value as { mode?: string }).mode === 'centralized-pr'
        );
    }

    private async getRulesByIds(organizationId: string, ruleIds: string[]) {
        try {
            const allRules =
                await this.findRulesInOrganizationByRuleFilterKodyRulesUseCase.execute(
                    organizationId,
                    {},
                );

            const rulesById = new Map(
                allRules.map((rule) => [rule.uuid, rule]),
            );

            return ruleIds
                .map((id) => {
                    const found = rulesById.get(id);
                    if (!found) {
                        throw new Error(`Rule not found: ${id}`);
                    }
                    return found;
                })
                .filter(Boolean);
        } catch (error) {
            this.logger.error({
                message: 'Could not convert pending updates to new memories',
                context: ConvertPendingUpdatesToMemoriesUseCase.name,
                error,
                metadata: {
                    organizationId,
                    ruleIds,
                },
            });
            throw error;
        }
    }
}
