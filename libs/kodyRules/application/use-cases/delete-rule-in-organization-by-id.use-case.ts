import { createLogger } from '@kodus/flow';
import { Injectable, Inject, Optional } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    KODY_RULES_SERVICE_TOKEN,
    IKodyRulesService,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { buildKodyRuleCentralizedMutationRequest } from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    KodyRuleCentralizedStatus,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

@Injectable()
export class DeleteRuleInOrganizationByIdKodyRulesUseCase {
    private readonly logger = createLogger(
        DeleteRuleInOrganizationByIdKodyRulesUseCase.name,
    );
    constructor(
        @Optional()
        @Inject(REQUEST)
        private readonly request: UserRequest,

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        private readonly centralizedConfigPrService: CentralizedConfigPrService,

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(
        ruleId: string,
        actor?: {
            source?: 'cli' | 'web' | 'sync';
            organizationId?: string;
            teamId?: string;
            userId?: string;
            userEmail?: string;
        },
    ): Promise<boolean | CentralizedPrMetadata> {
        try {
            const requestUser = this.request?.user as any;
            const organizationId =
                actor?.organizationId || requestUser?.organization?.uuid;
            const teamId =
                actor?.teamId || requestUser?.team?.uuid || requestUser?.teamId;

            const existingRule = await this.kodyRulesService.findById(ruleId);

            // The controller guard is type-level only — it cannot see which
            // repository the rule belongs to. Enforce repo scope here (same
            // contract as ChangeStatusKodyRulesUseCase): a repo-scoped role
            // may only delete rules of its assigned repositories; rules
            // without a repositoryId (org-wide/global) stay owner-only.
            // Machine flows (sync, or no request context) are exempt.
            if (
                existingRule &&
                actor?.source !== 'sync' &&
                this.request?.user
            ) {
                await this.authorizationService.ensure({
                    user: this.request.user,
                    action: Action.Delete,
                    resource: ResourceType.KodyRules,
                    repoIds: existingRule.repositoryId
                        ? [existingRule.repositoryId]
                        : undefined,
                });
            }

            if (existingRule && actor?.source !== 'sync') {
                const groupFolderName =
                    await this.centralizedConfigPrService.resolveDirectoryGroupFolderName(
                        { organizationId, teamId },
                        existingRule.repositoryId,
                        existingRule.directoryId,
                    );

                const pr =
                    await this.centralizedConfigPrService.createMutationPullRequestIfEnabled(
                        buildKodyRuleCentralizedMutationRequest({
                            centralizedConfigPrService:
                                this.centralizedConfigPrService,
                            organizationAndTeamData: {
                                organizationId,
                                teamId,
                            },
                            repositoryId: existingRule.repositoryId,
                            groupFolderName: groupFolderName ?? undefined,
                            ruleContent: existingRule,
                            ruleType:
                                (existingRule.type as KodyRulesType) ||
                                KodyRulesType.STANDARD,
                            operation: 'delete',
                        }),
                    );

                if (pr.mode === 'centralized-pr') {
                    const repositoryFolder =
                        await this.centralizedConfigPrService.resolveRepositoryFolderName(
                            {
                                organizationId,
                                teamId,
                            },
                            existingRule.repositoryId,
                        );

                    const rulesDirectory =
                        ((existingRule.type as KodyRulesType) ||
                            KodyRulesType.STANDARD) === KodyRulesType.MEMORY
                            ? 'memories'
                            : 'review';

                    const fileName = `${this.centralizedConfigPrService.sanitizeFileName(existingRule.title, 'rule')}.yml`;

                    const centralizedPath =
                        existingRule.centralizedConfig?.path ||
                        (groupFolderName
                            ? this.centralizedConfigPrService.buildDirectoryGroupRulesPath(
                                  repositoryFolder,
                                  groupFolderName,
                                  rulesDirectory,
                                  fileName,
                              )
                            : this.centralizedConfigPrService.buildCentralizedPath(
                                  {
                                      repositoryFolder,
                                      relativePath: `.kody-rules/${rulesDirectory}/${fileName}`,
                                  },
                              ));

                    await this.kodyRulesService.createOrUpdate(
                        {
                            organizationId,
                            teamId,
                        },
                        {
                            ...existingRule,
                            uuid: existingRule.uuid,
                            type:
                                (existingRule.type as KodyRulesType) ||
                                KodyRulesType.STANDARD,
                            status:
                                existingRule.status || KodyRulesStatus.ACTIVE,
                            centralizedConfig: {
                                path: centralizedPath,
                                status: KodyRuleCentralizedStatus.PENDING_DELETE,
                            },
                        } as any,
                        {
                            userId: actor?.userId || requestUser?.uuid,
                            userEmail: actor?.userEmail || requestUser?.email,
                        },
                    );

                    return pr;
                }
            }

            return await this.kodyRulesService.deleteRuleWithLogging(
                {
                    organizationId,
                },
                ruleId,
                {
                    userId: actor?.userId || requestUser?.uuid,
                    userEmail: actor?.userEmail || requestUser?.email,
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error deleting Kody Rule in organization by ID',
                context: DeleteRuleInOrganizationByIdKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId:
                        actor?.organizationId ||
                        this.request?.user?.organization?.uuid,
                    ruleId,
                },
            });
            throw error;
        }
    }
}
