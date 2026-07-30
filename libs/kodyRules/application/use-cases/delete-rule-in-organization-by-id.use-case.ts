import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';

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
        // The authenticated user, forwarded by the controller. Use-cases must
        // not inject REQUEST (it makes them request-scoped, which bubbles up
        // into singleton callers like event listeners and sync services).
        requestUser?: UserRequest['user'],
    ): Promise<boolean | CentralizedPrMetadata> {
        try {
            const ru: any = requestUser;
            const organizationId =
                actor?.organizationId || ru?.organization?.uuid;
            const teamId = actor?.teamId || ru?.team?.uuid || ru?.teamId;

            const existingRule = await this.kodyRulesService.findById(ruleId);

            // The controller guard is type-level only — it cannot see which
            // repository the rule belongs to. Enforce repo scope here (same
            // contract as ChangeStatusKodyRulesUseCase): a repo-scoped role
            // may only delete rules of its assigned repositories; rules
            // without a repositoryId (org-wide/global) stay owner-only.
            // Machine flows (sync, or no request context) are exempt.
            if (existingRule && actor?.source !== 'sync' && requestUser) {
                await this.authorizationService.ensure({
                    user: requestUser,
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

                    const fileName =
                        this.centralizedConfigPrService.buildRuleFileName(
                            existingRule.title,
                            existingRule.uuid,
                        );

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
                    userId: actor?.userId || ru?.uuid,
                    userEmail: actor?.userEmail || ru?.email,
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
                        (requestUser as any)?.organization?.uuid,
                    ruleId,
                },
            });
            throw error;
        }
    }
}
