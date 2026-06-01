import { Inject, Injectable, Optional } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    CONTEXT_REFERENCE_SERVICE_TOKEN,
    IContextReferenceService,
} from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
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
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { createLogger } from '@kodus/flow';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { enrichRulesWithContextReferences } from './utils/enrich-rules-with-context-references.util';

@Injectable()
export class FindRulesInOrganizationByRuleFilterKodyRulesUseCase implements IUseCase {
    private readonly logger = createLogger(
        FindRulesInOrganizationByRuleFilterKodyRulesUseCase.name,
    );

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        @Optional()
        @Inject(REQUEST)
        private readonly request: UserRequest,

        @Inject(CONTEXT_REFERENCE_SERVICE_TOKEN)
        private readonly contextReferenceService: IContextReferenceService,

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(
        organizationId: string,
        filter: Partial<IKodyRule>,
        repositoryId?: string,
        directoryId?: string,
    ) {
        try {
            let allowedRepoScope: string[] | null | undefined;

            if (this.request?.user) {
                if (repositoryId) {
                    await this.authorizationService.ensure({
                        user: this.request.user,
                        action: Action.Read,
                        resource: ResourceType.KodyRules,
                        repoIds: [repositoryId],
                    });
                } else {
                    allowedRepoScope =
                        await this.authorizationService.getRepositoryScope({
                            user: this.request.user,
                            action: Action.Read,
                            resource: ResourceType.KodyRules,
                        });
                }
            }

            const ruleFilters: Partial<IKodyRule>[] = [];

            if (repositoryId && directoryId) {
                ruleFilters.push({ repositoryId, directoryId });
            } else if (repositoryId) {
                ruleFilters.push({ repositoryId });
            } else if (directoryId) {
                ruleFilters.push({ directoryId });
            }

            const existingRules = await this.kodyRulesService.find({
                organizationId,
                ...(ruleFilters.length ? { rules: ruleFilters } : {}),
            });

            if (!existingRules || existingRules.length === 0) {
                return [];
            }

            const allRules = existingRules.reduce((acc, entity) => {
                return [...acc, ...entity.rules];
            }, []);

            let filteredRules = allRules;

            if (Array.isArray(allowedRepoScope)) {
                const allowed = new Set([...allowedRepoScope, 'global']);
                filteredRules = filteredRules.filter(
                    (rule) =>
                        !rule.repositoryId || allowed.has(rule.repositoryId),
                );
            }

            if (repositoryId && !directoryId) {
                filteredRules = filteredRules.filter(
                    (rule) =>
                        rule.repositoryId === 'global' ||
                        (rule.repositoryId === repositoryId &&
                            !rule.directoryId),
                );
            } else if (repositoryId && directoryId) {
                filteredRules = filteredRules.filter(
                    (rule) =>
                        rule.repositoryId === 'global' ||
                        (rule.repositoryId === repositoryId &&
                            rule.directoryId === directoryId),
                );
            }

            const includeDeleted = Object.prototype.hasOwnProperty.call(
                filter,
                'status',
            );

            const filteredByStatus = includeDeleted
                ? filteredRules
                : filteredRules.filter(
                      (rule) =>
                          rule.status !== KodyRulesStatus.DELETED &&
                          rule.status !== KodyRulesStatus.APPLIED,
                  );

            const rules = filteredByStatus.filter((rule) => {
                for (const key in filter) {
                    const actual =
                        key === 'type'
                            ? (rule.type ?? KodyRulesType.STANDARD)
                            : rule[key];
                    if (actual !== filter[key]) {
                        return false;
                    }
                }
                return true;
            });

            return await enrichRulesWithContextReferences(
                rules,
                this.contextReferenceService,
                this.logger,
            );
        } catch (error) {
            this.logger.error({
                message:
                    'Error finding Kody Rules in organization by rule filter',
                context:
                    FindRulesInOrganizationByRuleFilterKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId,
                    filter,
                },
            });
            throw error;
        }
    }
}
