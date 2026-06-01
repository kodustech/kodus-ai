import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    CONTEXT_REFERENCE_SERVICE_TOKEN,
    type IContextReferenceService,
} from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { NotificationEvent } from '@libs/notifications/domain/catalog/events';
import { NotificationRecipient } from '@libs/notifications/domain/recipient';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

export type RuleFileReferenceCheckSource = 'ide' | 'manual' | 'auto_recheck';

export interface RuleFileReferenceIssue {
    ruleId: string;
    ruleName: string;
    filePath: string;
    reason: string;
}

export interface ValidateRuleFileReferencesResult {
    invalidCount: number;
    issues: RuleFileReferenceIssue[];
}

interface RuleWithReferences {
    uuid: string;
    title: string;
    repositoryId: string;
    contextReferenceId?: string;
    createdByUserId?: string;
}

/**
 * Validates that every external file reference attached to a Kody Rule
 * still points to a file that exists in the repository's default
 * branch. When one or more references are stale, emits the
 * `rule.file_references_invalid` notification to the right audience
 * (sync initiator for IDE-triggered checks, rule owners for manual /
 * cron checks, falling back to org owners when ownership is unknown).
 *
 * Designed to fail closed: any dependency error is swallowed and the
 * use case returns an empty issue list, so callers (e.g. the IDE sync
 * use case) never propagate a validation failure back to the user as
 * the primary error.
 */
@Injectable()
export class ValidateRuleFileReferencesUseCase {
    private readonly logger = createLogger(
        ValidateRuleFileReferencesUseCase.name,
    );

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(CONTEXT_REFERENCE_SERVICE_TOKEN)
        private readonly contextReferenceService: IContextReferenceService,
        private readonly codeManagementService: CodeManagementService,
        private readonly notificationService: NotificationService,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        source: RuleFileReferenceCheckSource;
        syncInitiatorUserId?: string;
    }): Promise<ValidateRuleFileReferencesResult> {
        const empty: ValidateRuleFileReferencesResult = {
            invalidCount: 0,
            issues: [],
        };

        try {
            const organizationId =
                params.organizationAndTeamData.organizationId;
            if (!organizationId) return empty;

            const rulesEntity =
                await this.kodyRulesService.findByOrganizationId(
                    organizationId,
                );
            const allRules: RuleWithReferences[] =
                (rulesEntity as { rules?: RuleWithReferences[] })?.rules ?? [];
            const repoRules = allRules.filter(
                (rule) =>
                    rule?.repositoryId === params.repository.id &&
                    !!rule?.contextReferenceId,
            );
            if (repoRules.length === 0) return empty;

            const ruleReferences = await Promise.all(
                repoRules.map(async (rule) => ({
                    rule,
                    filePaths: await this.loadReferencedFilePaths(
                        rule.contextReferenceId!,
                    ),
                })),
            );
            const rulesWithRefs = ruleReferences.filter(
                ({ filePaths }) => filePaths.length > 0,
            );
            if (rulesWithRefs.length === 0) return empty;

            const repoFiles =
                (await this.codeManagementService.getRepositoryAllFiles({
                    organizationAndTeamData:
                        params.organizationAndTeamData,
                    repository: params.repository,
                })) ?? [];
            const existingPaths = new Set(
                repoFiles
                    .map((f) => (f as { path?: string })?.path)
                    .filter((p): p is string => typeof p === 'string'),
            );

            const issues: RuleFileReferenceIssue[] = [];
            const ownerIds = new Set<string>();

            for (const { rule, filePaths } of rulesWithRefs) {
                let ruleHadIssue = false;
                for (const filePath of filePaths) {
                    if (existingPaths.has(filePath)) continue;
                    issues.push({
                        ruleId: rule.uuid,
                        ruleName: rule.title,
                        filePath,
                        reason: 'File not found in default branch',
                    });
                    ruleHadIssue = true;
                }
                if (ruleHadIssue && rule.createdByUserId) {
                    ownerIds.add(rule.createdByUserId);
                }
            }

            if (issues.length === 0) return empty;

            const recipients = this.resolveRecipients(
                params.source,
                params.syncInitiatorUserId,
                ownerIds,
            );

            await this.notificationService.emit({
                event: NotificationEvent.RULE_FILE_REFERENCES_INVALID,
                organizationId,
                payload: {
                    source: params.source,
                    repoName: params.repository.name,
                    invalidCount: issues.length,
                    issues,
                },
                recipients,
            });

            return { invalidCount: issues.length, issues };
        } catch (error) {
            this.logger.error({
                message:
                    'rule.file_references_invalid validation pass failed — suppressing',
                error:
                    error instanceof Error ? error : new Error(String(error)),
                context: ValidateRuleFileReferencesUseCase.name,
                metadata: {
                    organizationId:
                        params.organizationAndTeamData.organizationId,
                    repositoryId: params.repository.id,
                    source: params.source,
                },
            });
            return empty;
        }
    }

    private async loadReferencedFilePaths(
        contextReferenceId: string,
    ): Promise<string[]> {
        try {
            const contextRef =
                await this.contextReferenceService.findById(contextReferenceId);
            const requirements =
                (contextRef as { requirements?: unknown[] })?.requirements ??
                [];
            const paths: string[] = [];
            for (const req of requirements as Array<{
                dependencies?: Array<{
                    type?: string;
                    metadata?: { filePath?: string };
                }>;
            }>) {
                for (const dep of req.dependencies ?? []) {
                    if (
                        dep?.type === 'knowledge' &&
                        typeof dep?.metadata?.filePath === 'string' &&
                        dep.metadata.filePath.length > 0
                    ) {
                        paths.push(dep.metadata.filePath);
                    }
                }
            }
            return paths;
        } catch {
            // Skip rules whose context reference can't be fetched; we don't
            // want a broken reference doc to suppress validation for the
            // rest of the rule set.
            return [];
        }
    }

    private resolveRecipients(
        source: RuleFileReferenceCheckSource,
        syncInitiatorUserId: string | undefined,
        ownerIds: Set<string>,
    ): NotificationRecipient[] {
        if (source === 'ide') {
            return syncInitiatorUserId
                ? [{ kind: 'user', userId: syncInitiatorUserId }]
                : [{ kind: 'role', role: Role.OWNER }];
        }
        if (ownerIds.size === 0) {
            return [{ kind: 'role', role: Role.OWNER }];
        }
        return [...ownerIds].map((userId) => ({ kind: 'user', userId }));
    }
}
