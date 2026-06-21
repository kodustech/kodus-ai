import { createLogger } from '@kodus/flow';
import {
    CentralizedConfigPrService,
    CentralizedPrMetadata,
} from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    Inject,
    Injectable,
    NotFoundException,
    Optional,
} from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { PromptSourceType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { ContextReferenceDetectionService } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';
import type { ContextDetectionField } from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';
import { CreateKodyRuleDto } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    buildKodyRuleCentralizedFilePath,
    buildKodyRuleCentralizedMutationRequest,
} from '@libs/centralized-config/utils/kody-rules-centralized-pr.builder';
import {
    CONTEXT_RESOLUTION_SERVICE_TOKEN,
    IContextResolutionService,
} from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
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
    KodyRuleCentralizedStatus,
    KodyRulesOrigin,
    KodyRulesStatus,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

@Injectable()
export class CreateOrUpdateKodyRulesUseCase {
    private readonly logger = createLogger(CreateOrUpdateKodyRulesUseCase.name);
    constructor(
        @Optional()
        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid: string;
                email: string;
            };
        },

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(CONTEXT_RESOLUTION_SERVICE_TOKEN)
        private readonly contextResolutionService: IContextResolutionService,

        private readonly authorizationService: AuthorizationService,
        private readonly contextReferenceDetectionService: ContextReferenceDetectionService,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
    ) {}

    async execute(
        kodyRule: CreateKodyRuleDto,
        organizationId: string,
        userInfo?: { userId: string; userEmail: string },
        skipAuthorization?: boolean,
        teamIdOverride?: string,
    ): Promise<Partial<any> | CentralizedPrMetadata> {
        try {
            const req: any = this.request as any;
            const reqUser = req?.user;

            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId,
                teamId:
                    teamIdOverride || reqUser?.team?.uuid || reqUser?.teamId,
            };

            const userInfoData =
                userInfo ||
                (reqUser?.uuid && reqUser?.email
                    ? { userId: reqUser.uuid, userEmail: reqUser.email }
                    : { userId: 'kody-system', userEmail: 'kody@kodus.io' });

            const bypassCentralizedRouting =
                this.isInternalSyncActor(userInfoData);

            if (
                !skipAuthorization &&
                userInfoData.userId !== 'kody-system' &&
                this.request?.user
            ) {
                await this.authorizationService.ensure({
                    user: this.request.user,
                    action: Action.Create,
                    resource: ResourceType.KodyRules,
                    repoIds: await this.resolveAuthorizationRepoIds(kodyRule),
                });
            }

            if (!bypassCentralizedRouting) {
                const centralizedPr =
                    await this.createCentralizedMutationIfEnabled(
                        organizationAndTeamData,
                        kodyRule,
                        userInfoData,
                    );

                if (centralizedPr) {
                    return centralizedPr;
                }

                const centralizedEnabledForScope =
                    await this.isCentralizedEnabledForRuleMutation(
                        organizationAndTeamData,
                        kodyRule.repositoryId,
                    );

                if (centralizedEnabledForScope) {
                    throw new Error(
                        'Centralized config is enabled, but rule mutation was not routed through centralized PR flow',
                    );
                }
            }

            const result = await this.kodyRulesService.createOrUpdate(
                organizationAndTeamData,
                kodyRule,
                userInfoData,
            );

            if (!result) {
                throw new NotFoundException(
                    'Failed to create or update kody rule',
                );
            }

            if (result.uuid && kodyRule.repositoryId && kodyRule.rule) {
                this.logger.log({
                    message:
                        'Rule created/updated, triggering reference detection',
                    context: CreateOrUpdateKodyRulesUseCase.name,
                    metadata: {
                        ruleId: result.uuid,
                        ruleTitle: kodyRule.title,
                        repositoryId: kodyRule.repositoryId,
                        hasRuleText: !!kodyRule.rule,
                        ruleTextLength: kodyRule.rule.length,
                        organizationAndTeamData,
                    },
                });

                this.detectAndSaveReferencesAsync(
                    result.uuid,
                    kodyRule.rule,
                    kodyRule.repositoryId,
                    organizationAndTeamData,
                ).catch((error) => {
                    this.logger.error({
                        message:
                            'Background reference detection failed completely',
                        context: CreateOrUpdateKodyRulesUseCase.name,
                        error: this.normalizeError(error),
                        metadata: {
                            ruleId: result.uuid,
                            ruleTitle: kodyRule.title,
                            organizationAndTeamData,
                        },
                    });
                });
            } else {
                this.logger.warn({
                    message:
                        'Reference detection skipped - missing required fields',
                    context: CreateOrUpdateKodyRulesUseCase.name,
                    metadata: {
                        ruleId: result.uuid,
                        hasRepositoryId: !!kodyRule.repositoryId,
                        hasRuleText: !!kodyRule.rule,
                        repositoryId: kodyRule.repositoryId,
                        organizationAndTeamData,
                    },
                });
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Could not create or update Kody rules',
                context: CreateOrUpdateKodyRulesUseCase.name,
                serviceName: 'CreateOrUpdateKodyRulesUseCase',
                error: this.normalizeError(error),
                metadata: {
                    kodyRule,
                    organizationAndTeamData: {
                        organizationId,
                    },
                },
            });
            throw error;
        }
    }

    /**
     * Which repo ids the mutation must be authorized against.
     *
     * Normally the rule's own repositoryId. Exception: an inheritance
     * toggle (excluding/including a child scope from an inherited rule)
     * mutates the PARENT rule document, but its effect is scoped to the
     * toggled child — demanding write access on the parent would mean a
     * repo admin cannot opt their own repo out of an inherited global
     * rule ("Error disabling inheritance" 403). When the ONLY change vs
     * the stored rule is inheritance.exclude/include, authorize against
     * the toggled ids instead.
     */
    private async resolveAuthorizationRepoIds(
        kodyRule: CreateKodyRuleDto,
    ): Promise<string[] | undefined> {
        const ruleScope = kodyRule.repositoryId
            ? [kodyRule.repositoryId]
            : undefined;

        if (!kodyRule.uuid) {
            return ruleScope;
        }

        const existing = await this.kodyRulesService.findById(kodyRule.uuid);
        if (!existing) {
            return ruleScope;
        }

        const toggledIds = this.getInheritanceOnlyToggledIds(
            existing,
            kodyRule,
        );

        return toggledIds ?? ruleScope;
    }

    /**
     * Returns the ids added/removed in inheritance.exclude/include when
     * those lists are the ONLY difference vs the stored rule, or null
     * when anything else changed (callers then authorize against the
     * rule's own scope, as before).
     *
     * The service update is a merge (`{...existingRule, ...kodyRule}`),
     * so every key PRESENT in the payload can overwrite the stored value
     * — compare them all, not a fixed whitelist. `inheritable` is
     * rule-wide (affects every repo), so flipping it is NOT a per-repo
     * toggle.
     */
    private getInheritanceOnlyToggledIds(
        existing: Partial<IKodyRule>,
        incoming: CreateKodyRuleDto,
    ): string[] | null {
        // Args of the request that aren't rule content, plus the lists we
        // diff explicitly below.
        const ignoredKeys = new Set([
            'uuid',
            'inheritance',
            'teamId',
            'createdAt',
            'updatedAt',
        ]);

        const normalized = (value: unknown) =>
            JSON.stringify(value ?? null);

        for (const key of Object.keys(incoming)) {
            if (ignoredKeys.has(key)) {
                continue;
            }
            if (
                normalized((incoming as any)[key]) !==
                normalized((existing as any)[key])
            ) {
                return null;
            }
        }

        const existingInheritance = existing.inheritance ?? {
            inheritable: true,
            exclude: [],
            include: [],
        };
        const incomingInheritance = incoming.inheritance ?? {
            inheritable: true,
            exclude: [],
            include: [],
        };

        if (
            (existingInheritance.inheritable ?? true) !==
            (incomingInheritance.inheritable ?? true)
        ) {
            return null;
        }

        const symmetricDiff = (a: string[] = [], b: string[] = []) => {
            const setA = new Set(a);
            const setB = new Set(b);
            return [
                ...a.filter((id) => !setB.has(id)),
                ...b.filter((id) => !setA.has(id)),
            ];
        };

        const toggledIds = [
            ...new Set([
                ...symmetricDiff(
                    existingInheritance.exclude,
                    incomingInheritance.exclude,
                ),
                ...symmetricDiff(
                    existingInheritance.include,
                    incomingInheritance.include,
                ),
            ]),
        ];

        return toggledIds.length > 0 ? toggledIds : null;
    }

    private async createCentralizedMutationIfEnabled(
        organizationAndTeamData: OrganizationAndTeamData,
        kodyRule: CreateKodyRuleDto,
        userInfo: { userId: string; userEmail: string },
    ): Promise<CentralizedPrMetadata | null> {
        const existingRule =
            kodyRule.uuid &&
            (await this.kodyRulesService.findById(kodyRule.uuid));

        if (kodyRule.uuid && !existingRule) {
            throw new NotFoundException('Rule not found');
        }

        const effectiveRule = {
            ...existingRule,
            ...kodyRule,
        };

        if (!effectiveRule.title || !effectiveRule.repositoryId) {
            return null;
        }

        const resolvedOrgAndTeamData = await this.resolveTeamContextIfMissing(
            organizationAndTeamData,
            effectiveRule.repositoryId,
        );

        const ruleType =
            (effectiveRule.type as KodyRulesType) || KodyRulesType.STANDARD;

        const groupFolderName =
            await this.centralizedConfigPrService.resolveDirectoryGroupFolderName(
                resolvedOrgAndTeamData,
                effectiveRule.repositoryId,
                effectiveRule.directoryId,
            );

        if (
            !effectiveRule.centralizedConfig?.path &&
            effectiveRule.title &&
            effectiveRule.repositoryId
        ) {
            const repositoryFolder =
                await this.centralizedConfigPrService.resolveRepositoryFolderName(
                    resolvedOrgAndTeamData,
                    effectiveRule.repositoryId,
                );

            const rulesDirectory =
                ruleType === KodyRulesType.MEMORY ? 'memories' : 'review';

            const fileName = `${this.centralizedConfigPrService.sanitizeFileName(effectiveRule.title, 'rule')}.yml`;

            const centralizedPath = groupFolderName
                ? this.centralizedConfigPrService.buildDirectoryGroupRulesPath(
                      repositoryFolder,
                      groupFolderName,
                      rulesDirectory,
                      fileName,
                  )
                : this.centralizedConfigPrService.buildCentralizedPath({
                      repositoryFolder,
                      relativePath: `.kody-rules/${rulesDirectory}/${fileName}`,
                  });

            effectiveRule.centralizedConfig = {
                path: centralizedPath,
                status: KodyRuleCentralizedStatus.SYNCED,
            };
        }

        const pr =
            await this.centralizedConfigPrService.createMutationPullRequestIfEnabled(
                buildKodyRuleCentralizedMutationRequest({
                    centralizedConfigPrService: this.centralizedConfigPrService,
                    organizationAndTeamData: resolvedOrgAndTeamData,
                    repositoryId: effectiveRule.repositoryId,
                    groupFolderName: groupFolderName ?? undefined,
                    ruleContent: effectiveRule,
                    ruleType,
                    operation: kodyRule.uuid ? 'update' : 'create',
                }),
            );

        if (pr.mode !== 'centralized-pr') {
            return null;
        }

        await this.persistRuleWithCentralizedPendingStatus(
            resolvedOrgAndTeamData,
            effectiveRule,
            ruleType,
            kodyRule.uuid ? 'update' : 'create',
            userInfo,
            existingRule || undefined,
        );

        return pr;
    }

    private async persistRuleWithCentralizedPendingStatus(
        organizationAndTeamData: OrganizationAndTeamData,
        effectiveRule: Partial<IKodyRule>,
        ruleType: KodyRulesType,
        operation: 'create' | 'update',
        userInfo: { userId: string; userEmail: string },
        existingRule?: Partial<IKodyRule> | null,
    ): Promise<void> {
        if (!effectiveRule.title || !effectiveRule.repositoryId) {
            return;
        }

        try {
            const repositoryFolder =
                await this.centralizedConfigPrService.resolveRepositoryFolderName(
                    organizationAndTeamData,
                    effectiveRule.repositoryId,
                );

            const groupFolderName =
                await this.centralizedConfigPrService.resolveDirectoryGroupFolderName(
                    organizationAndTeamData,
                    effectiveRule.repositoryId,
                    effectiveRule.directoryId,
                );

            const centralizedPath = buildKodyRuleCentralizedFilePath({
                centralizedConfigPrService: this.centralizedConfigPrService,
                repositoryFolder,
                rulesDirectory:
                    ruleType === KodyRulesType.MEMORY ? 'memories' : 'review',
                ruleContent:
                    operation === 'update' && existingRule
                        ? existingRule
                        : effectiveRule,
                groupFolderName: groupFolderName ?? undefined,
            });

            if (operation === 'create') {
                await this.kodyRulesService.createOrUpdate(
                    organizationAndTeamData,
                    {
                        ...(effectiveRule as CreateKodyRuleDto),
                        type: ruleType,
                        repositoryId: effectiveRule.repositoryId,
                        origin: effectiveRule.origin || KodyRulesOrigin.USER,
                        status: effectiveRule.status || KodyRulesStatus.ACTIVE,
                        centralizedConfig: {
                            path: centralizedPath,
                            status: KodyRuleCentralizedStatus.PENDING_ADD,
                        },
                    },
                    userInfo,
                );
                return;
            }

            if (!existingRule?.uuid) {
                return;
            }

            await this.kodyRulesService.createOrUpdate(
                organizationAndTeamData,
                {
                    ...(existingRule as CreateKodyRuleDto),
                    uuid: existingRule.uuid,
                    type: ruleType,
                    repositoryId: existingRule.repositoryId,
                    origin: existingRule.origin || KodyRulesOrigin.USER,
                    status: existingRule.status || KodyRulesStatus.ACTIVE,
                    centralizedConfig: {
                        path: centralizedPath,
                        status: KodyRuleCentralizedStatus.PENDING_EDIT,
                    },
                },
                userInfo,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Centralized PR was created, but failed to persist centralized pending snapshot',
                context: CreateOrUpdateKodyRulesUseCase.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationAndTeamData,
                    ruleId: effectiveRule.uuid,
                    repositoryId: effectiveRule.repositoryId,
                },
            });
        }
    }

    private async resolveTeamContextIfMissing(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
    ): Promise<OrganizationAndTeamData> {
        if (
            organizationAndTeamData.teamId ||
            !repositoryId ||
            repositoryId === 'global'
        ) {
            return organizationAndTeamData;
        }

        try {
            const resolvedTeamId =
                await this.contextResolutionService.getTeamIdByOrganizationAndRepository(
                    organizationAndTeamData.organizationId,
                    repositoryId,
                );

            if (!resolvedTeamId) {
                return organizationAndTeamData;
            }

            return {
                ...organizationAndTeamData,
                teamId: resolvedTeamId,
            };
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to resolve team context for centralized kody rule mutation',
                context: CreateOrUpdateKodyRulesUseCase.name,
                error: this.normalizeError(error),
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    repositoryId,
                },
            });

            return organizationAndTeamData;
        }
    }

    private async isCentralizedEnabledForRuleMutation(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
    ): Promise<boolean> {
        const resolvedOrgAndTeamData = await this.resolveTeamContextIfMissing(
            organizationAndTeamData,
            repositoryId,
        );

        const centralizedRepository =
            await this.centralizedConfigPrService.getCentralizedRepositoryIfEnabled(
                resolvedOrgAndTeamData,
            );

        return Boolean(centralizedRepository);
    }

    private async detectAndSaveReferencesAsync(
        ruleId: string,
        ruleText: string,
        repositoryId: string,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void> {
        return new Promise((resolve) => {
            setImmediate(async () => {
                try {
                    let resolvedTeamId: string | undefined;
                    if (
                        repositoryId !== 'global' &&
                        !organizationAndTeamData.teamId
                    ) {
                        try {
                            resolvedTeamId =
                                await this.contextResolutionService.getTeamIdByOrganizationAndRepository(
                                    organizationAndTeamData.organizationId,
                                    repositoryId,
                                );
                        } catch (error) {
                            this.logger.warn({
                                message:
                                    'Failed to resolve team for repository, detection may miss cross-repo context',
                                context: CreateOrUpdateKodyRulesUseCase.name,
                                error: this.normalizeError(error),
                                metadata: {
                                    repositoryId,
                                    organizationAndTeamData,
                                },
                            });
                        }
                    }

                    let repositoryName: string;
                    try {
                        if (repositoryId === 'global') {
                            repositoryName = 'global';
                        } else {
                            repositoryName =
                                await this.contextResolutionService.getRepositoryNameByOrganizationAndRepository(
                                    organizationAndTeamData.organizationId,
                                    repositoryId,
                                );
                        }
                    } catch (error) {
                        this.logger.warn({
                            message:
                                'Failed to resolve repository name, using ID as fallback',
                            context: CreateOrUpdateKodyRulesUseCase.name,
                            error: this.normalizeError(error),
                            metadata: {
                                repositoryId,
                                organizationAndTeamData,
                            },
                        });
                        repositoryName = repositoryId;
                    }

                    const detectionOrgData: OrganizationAndTeamData =
                        resolvedTeamId
                            ? {
                                  ...organizationAndTeamData,
                                  teamId: resolvedTeamId,
                              }
                            : organizationAndTeamData;

                    const detectionFields: ContextDetectionField[] = [
                        {
                            fieldId: '',
                            path: ['kodyRule', ruleId],
                            sourceType: PromptSourceType.KODY_RULE,
                            text: ruleText,
                            metadata: {
                                sourceSnippet: ruleText,
                            },
                            consumerKind: 'prompt',
                            consumerName: ruleId,
                            conversationIdOverride: ruleId,
                            requestDomain: 'code',
                            taskIntent: 'Process kodyRule references',
                        },
                    ];

                    const contextReferenceId =
                        await this.contextReferenceDetectionService.detectAndSaveReferences(
                            {
                                entityType: 'kodyRule',
                                entityId: ruleId,
                                fields: detectionFields,
                                repositoryId,
                                repositoryName,
                                organizationAndTeamData: detectionOrgData,
                            },
                        );

                    await this.kodyRulesService.updateRuleReferences(
                        organizationAndTeamData.organizationId,
                        ruleId,
                        {
                            contextReferenceId,
                        },
                    );

                    this.logger.log({
                        message:
                            'KodyRule successfully processed with Context OS',
                        context: CreateOrUpdateKodyRulesUseCase.name,
                        metadata: {
                            ruleId,
                            contextReferenceId,
                            repositoryId,
                        },
                    });
                } catch (error) {
                    this.logger.error({
                        message: 'Failed to process kodyRule with Context OS',
                        context: CreateOrUpdateKodyRulesUseCase.name,
                        error: this.normalizeError(error),
                        metadata: {
                            ruleId,
                            repositoryId,
                            organizationAndTeamData,
                        },
                    });
                }

                resolve();
            });
        });
    }

    private normalizeError(error: unknown): Error {
        return error instanceof Error ? error : new Error(String(error));
    }

    private isInternalSyncActor(userInfo: {
        userId: string;
        userEmail: string;
    }): boolean {
        return (
            userInfo.userId === 'kody' && userInfo.userEmail === 'kody@kodus.io'
        );
    }
}
