import {
    forwardRef,
    Inject,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { LLM } from '@libs/llm/llm';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { requiresKnowledgeApproval } from '@libs/common/utils/kody-rules/knowledge-approval';
import * as path from 'path';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { UserInfo } from '@libs/core/infrastructure/config/types/general/codeReviewSettingsLog.type';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';

import { ParametersKey } from '@libs/core/domain/enums';
import {
    KODY_RULE_FILE_DISCOVERY_PATTERNS,
    isAgentInstructionSource,
    isKodyRuleFileSource,
    validateAndScopeIdeRulePath,
} from '@libs/common/utils/kody-rules/file-patterns';
import {
    isKodyRuleTemplateFile,
    parseKodyRuleFile,
} from '@libs/common/utils/kody-rules/kody-rule-file-parser';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    IKodyRule,
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GLOBAL_RULES_TRIAL_IMPORT_LIMIT } from '@libs/kodyRules/domain/interfaces/global-rules-source.interface';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import { hasNonManagedCredential, LLM_TASK } from '@libs/llm/byok-config';
import { ObservabilityService } from '@libs/core/log/observability.service';
import {
    ContextDetectionField,
    ContextReferenceDetectionService,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-reference-detection.service';
import { kodyRulesIDEGeneratorSchema } from '@libs/common/utils/prompts/kodyRules';
import { PromptSourceType } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { createLogger } from '@libs/core/log/logger';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@libs/code-review/application/use-cases/configuration/update-or-create-code-review-parameter-use-case';
import { CreateOrUpdateKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/create-or-update.use-case';
import { DeleteRuleInOrganizationByIdKodyRulesUseCase } from '@libs/kodyRules/application/use-cases/delete-rule-in-organization-by-id.use-case';
import {
    CONTEXT_RESOLUTION_SERVICE_TOKEN,
    IContextResolutionService,
} from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';

type SyncTarget = {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        id: string;
        name: string;
        fullName?: string;
        defaultBranch?: string;
    };
    path?: string;
};

export type IdeSyncRuleCounts = {
    active: number;
    paused: number;
    deleted: number;
};

type FileSyncOutcome =
    | { outcome: 'imported'; rule: unknown }
    | { outcome: 'removed' }
    | { outcome: 'skipped'; reason: string };

type SyncSummary = {
    imported: string[];
    skipped: Array<{ file: string; reason: string }>;
    removed: string[];
};

@Injectable()
export class KodyRulesSyncService {
    private readonly systemUserInfo: UserInfo = {
        userId: 'kody-rules-sync',
        userEmail: 'kody@kodus.io',
    };

    private readonly logger = createLogger(KodyRulesSyncService.name);
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(CONTEXT_RESOLUTION_SERVICE_TOKEN)
        private readonly contextResolutionService: IContextResolutionService,
        private readonly codeManagementService: CodeManagementService,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly deleteRuleInOrganizationByIdKodyRulesUseCase: DeleteRuleInOrganizationByIdKodyRulesUseCase,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly observabilityService: ObservabilityService,
        private readonly contextReferenceDetectionService: ContextReferenceDetectionService,
        @Inject(forwardRef(() => CODE_BASE_CONFIG_SERVICE_TOKEN))
        private readonly codeBaseConfigService: ICodeBaseConfigService,
    ) {}

    /**
     * Find the configured directory (if any) that contains a given repository-relative file path.
     * Returns the most specific matching directory (longest path prefix) to support nested configs.
     */
    private async resolveDirectoryForFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        filePath: string; // repository-relative, posix path
    }): Promise<{ id: string; path: string } | null> {
        try {
            const { organizationAndTeamData, repositoryId, filePath } = params;
            const cfg = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            const repos = cfg?.configValue?.repositories;
            if (!repositoryId || !Array.isArray(repos) || !repos.length) {
                return null;
            }

            // Normalize path for safe prefix checks (posix style)
            const normalizedFile = path.posix.normalize(
                filePath.startsWith('/') ? filePath.slice(1) : filePath,
            );

            const repoCfg = repos.find(
                (r: any) =>
                    r &&
                    (r.id === repositoryId || r.id === repositoryId.toString()),
            );
            const directories: Array<{ id: string; path: string }> = (
                repoCfg?.directories || []
            )
                .filter((d: any) => d && typeof d.path === 'string' && d.id)
                .map((d: any) => ({
                    id: d.id,
                    path: d.path,
                }));

            if (!directories.length) return null;

            // Choose the most specific directory whose path is a prefix of the file path
            let best: { id: string; path: string } | null = null;
            for (const d of directories) {
                const normalizedDir = path.posix.normalize(
                    (d.path || '').replace(/^\/*/, ''),
                );
                if (!normalizedDir || normalizedDir === '.') continue;

                // Ensure exact segment boundary (e.g., 'apps/app' should not match 'apps/app1')
                const isPrefix =
                    normalizedFile === normalizedDir ||
                    normalizedFile.startsWith(normalizedDir + '/');
                if (!isPrefix) continue;

                if (
                    !best ||
                    normalizedDir.length >
                        path.posix.normalize(
                            (best.path || '').replace(/^\/*/, ''),
                        ).length
                ) {
                    best = d;
                }
            }

            return best;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to resolve directory for file',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
            return null;
        }
    }

    private async findRuleBySourcePath(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        sourcePath: string;
    }): Promise<Partial<{ uuid: string; status: KodyRulesStatus }> | null> {
        try {
            const { organizationAndTeamData, repositoryId, sourcePath } =
                params;
            const existing = await this.kodyRulesService.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );
            const matches =
                existing?.rules?.filter(
                    (r) =>
                        r?.repositoryId === repositoryId &&
                        r?.sourcePath === sourcePath,
                ) ?? [];

            if (!matches.length) return null;

            // Prefer the NEWEST non-deleted record. The old `Array.find`
            // returned the first (i.e. oldest) match regardless of status,
            // so when a sourcePath had both a stale soft-DELETED record and
            // a newer live one, re-imports kept resurrecting/updating the
            // stale record (customer-reported: "old rule persisted; toggle
            // off removed it, toggle on re-added it"). Falling back to a
            // deleted match is intentional — if the source file still
            // exists in the repo, reviving that record (with refreshed
            // content) beats accumulating duplicates.
            // Missing/invalid createdAt normalises to 0 so NaN can't make
            // the comparator implementation-defined.
            const toTime = (value: unknown): number => {
                const t = new Date((value as any) ?? 0).getTime();
                return Number.isFinite(t) ? t : 0;
            };
            const newestFirst = [...matches].sort(
                (a, b) =>
                    toTime((b as any)?.createdAt) -
                    toTime((a as any)?.createdAt),
            );
            const found =
                newestFirst.find(
                    (r) => r?.status !== KodyRulesStatus.DELETED,
                ) ?? newestFirst[0];

            return found ? { uuid: found.uuid, status: found.status } : null;
        } catch (error) {
            this.logger.error({
                message: 'Failed to find rule by sourcePath',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
            return null;
        }
    }

    /**
     * Every rule of `repositoryId` whose source file is `sourcePath`. A
     * multi-rule file stores `path#anchor`, so match on the path part. A
     * sourcePath can carry SEVERAL records (duplicates from concurrent
     * syncs — observed live: two identical rules from one merge), which is
     * why the passes below act on the whole list and never on `.find()`.
     */
    private rulesBySourcePath(
        entity: { rules?: Partial<IKodyRule>[] } | null | undefined,
        repositoryId: string,
        sourcePath: string,
    ): Partial<IKodyRule>[] {
        return (entity?.rules ?? []).filter(
            (r) =>
                r?.uuid &&
                r?.repositoryId === repositoryId &&
                (r?.sourcePath || '').split('#')[0] === sourcePath,
        );
    }

    private async deleteRuleBySourcePath(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        sourcePath: string;
    }): Promise<void> {
        const { organizationAndTeamData, repositoryId, sourcePath } = params;
        let toDelete: Partial<IKodyRule>[];
        try {
            const entity = await this.kodyRulesService.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );
            // Already-DELETED records are skipped: re-writing them is a
            // no-op that only adds audit-log noise.
            toDelete = this.rulesBySourcePath(
                entity,
                repositoryId,
                sourcePath,
            ).filter((r) => r.status !== KodyRulesStatus.DELETED);
        } catch (error) {
            this.logger.error({
                message: 'Failed to load rules for soft-delete by sourcePath',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
            return;
        }

        // Soft-delete so the record can be restored if the source file
        // reappears (or the @kody-ignore marker is removed). Each write has
        // its own catch: one failure must not strand the remaining records
        // ACTIVE for a file that no longer exists.
        for (const rule of toDelete) {
            try {
                await this.kodyRulesService.createOrUpdate(
                    organizationAndTeamData,
                    { ...rule, status: KodyRulesStatus.DELETED } as any,
                    this.systemUserInfo,
                );
            } catch (error) {
                this.logger.error({
                    message: 'Failed to soft-delete rule by sourcePath',
                    context: KodyRulesSyncService.name,
                    error,
                    metadata: { ...params, ruleId: rule.uuid },
                });
            }
        }
    }

    async syncFromChangedFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string; fullName?: string };
        pullRequestNumber: number;
        files: Array<{
            filename: string;
            previous_filename?: string;
            status: string;
        }>;
    }): Promise<void> {
        const {
            organizationAndTeamData,
            repository,
            pullRequestNumber,
            files,
        } = params;
        try {
            // Coding-agent files (CLAUDE.md, .cursor/rules, ...) are not review
            // policy and are never converted; only Kody rule files sync, and
            // they sync regardless of `ideRulesSyncEnabled`.
            const ruleChanges = files.filter(
                (f) =>
                    isKodyRuleFileSource(f.filename) ||
                    isKodyRuleFileSource(f.previous_filename),
            );

            if (!ruleChanges.length) {
                return;
            }

            const prDetails =
                await this.codeManagementService.getPullRequestByNumber({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    prNumber: pullRequestNumber,
                });

            const { head, base } = this.extractRefsFromPullRequest(prDetails);
            const pullRequestParam: any = {
                number: pullRequestNumber,
                head: head ? { ref: head } : undefined,
                base: base ? { ref: base } : undefined,
            };

            const summary: SyncSummary = {
                imported: [],
                skipped: [],
                removed: [],
            };

            for (const f of ruleChanges) {
                const movedOut =
                    f.status === 'renamed' &&
                    !isKodyRuleFileSource(f.filename);

                if (f.status === 'removed' || movedOut) {
                    const removedPath = movedOut
                        ? f.previous_filename
                        : f.filename;
                    await this.deleteRuleBySourcePath({
                        organizationAndTeamData,
                        repositoryId: repository.id,
                        sourcePath: removedPath,
                    });
                    summary.removed.push(removedPath);
                    continue;
                }

                const content = await this.getMergedFileContent({
                    organizationAndTeamData,
                    repository,
                    filename: f.filename,
                    pullRequest: pullRequestParam,
                });

                if (!content) {
                    summary.skipped.push({
                        file: f.filename,
                        reason: 'empty or unfetchable content',
                    });
                    continue;
                }

                const result = await this.upsertRuleFromFile({
                    organizationAndTeamData,
                    repository,
                    filePath: f.filename,
                    content,
                    previousPath:
                        f.status === 'renamed' &&
                        isKodyRuleFileSource(f.previous_filename)
                            ? f.previous_filename
                            : undefined,
                    writeThroughUseCase: true,
                });
                this.recordOutcome(summary, f.filename, result);
            }

            this.logSyncSummary({
                organizationAndTeamData,
                repositoryId: repository.id,
                trigger: 'merge',
                summary,
                candidates: ruleChanges.length,
                extra: { pullRequestNumber },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to sync Kody Rules from changed files',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
        }
    }

    async syncRepositoryMain(params: SyncTarget): Promise<void> {
        const {
            organizationAndTeamData,
            repository,
            path: requestedPath,
        } = params;
        try {
            if (requestedPath) {
                const normalizedRequestedPath = requestedPath
                    .replace(/\\/g, '/')
                    .replace(/^\.\/+/, '')
                    .replace(/^\/+/, '');

                if (!isKodyRuleFileSource(normalizedRequestedPath)) {
                    this.logger.log({
                        message:
                            '[kody-rules-sync] requested file is not a Kody rule file; coding-agent files are not converted',
                        context: KodyRulesSyncService.name,
                        metadata: {
                            repositoryId: repository.id,
                            requestedPath: normalizedRequestedPath,
                            organizationAndTeamData,
                        },
                    });
                    return;
                }

                const branch =
                    await this.codeManagementService.getDefaultBranch({
                        organizationAndTeamData,
                        repository,
                    });

                await this.syncSingleFileFromMain({
                    organizationAndTeamData,
                    repository,
                    branch,
                    filePath: normalizedRequestedPath,
                });
                return;
            }

            const branch = await this.codeManagementService.getDefaultBranch({
                organizationAndTeamData,
                repository,
            });

            const filesToSync = await this.listKodyRuleFiles({
                organizationAndTeamData,
                repository,
                branch,
            });

            const summary: SyncSummary = {
                imported: [],
                skipped: [],
                removed: [],
            };

            for (const file of filesToSync) {
                const content = await this.getFileContent({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    filename: file.path,
                    branch,
                });

                if (!content) {
                    summary.skipped.push({
                        file: file.path,
                        reason: 'empty or unfetchable content',
                    });
                    continue;
                }

                const result = await this.upsertRuleFromFile({
                    organizationAndTeamData,
                    repository,
                    filePath: file.path,
                    content,
                    writeThroughUseCase: false,
                });
                this.recordOutcome(summary, file.path, result);
            }

            this.logSyncSummary({
                organizationAndTeamData,
                repositoryId: repository.id,
                trigger: 'main',
                summary,
                candidates: filesToSync.length,
                extra: { branch },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to sync Kody Rules from main',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
        }
    }

    private async syncSingleFileFromMain(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: {
            id: string;
            name: string;
            fullName?: string;
            defaultBranch?: string;
        };
        branch: string;
        filePath: string;
    }): Promise<void> {
        const { organizationAndTeamData, repository, branch, filePath } =
            params;

        const content = await this.getFileContent({
            organizationAndTeamData,
            repository: { id: repository.id, name: repository.name },
            filename: filePath,
            branch,
        });

        if (!content) {
            await this.deleteRuleBySourcePath({
                organizationAndTeamData,
                repositoryId: repository.id,
                sourcePath: filePath,
            });
            this.logger.log({
                message:
                    '[kody-rules-sync] requested file is not on the default branch; its rule was removed',
                context: KodyRulesSyncService.name,
                metadata: {
                    repositoryId: repository.id,
                    filePath,
                    branch,
                    organizationAndTeamData,
                },
            });
            return;
        }

        const result = await this.upsertRuleFromFile({
            organizationAndTeamData,
            repository,
            filePath,
            content,
            writeThroughUseCase: false,
        });
        const summary: SyncSummary = { imported: [], skipped: [], removed: [] };
        this.recordOutcome(summary, filePath, result);
        this.logSyncSummary({
            organizationAndTeamData,
            repositoryId: repository.id,
            trigger: 'main:path',
            summary,
            candidates: 1,
            extra: { branch },
        });
    }

    /**
     * Kody rule files on `branch`, coding-agent locations excluded (the
     * generic `rules/**\/*.md` glob also matches `.agents/rules/*.md`).
     */
    private async listKodyRuleFiles(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        branch: string;
    }): Promise<Array<{ path: string; size?: number; sha?: string }>> {
        const allFiles =
            (await this.codeManagementService.getRepositoryAllFiles({
                organizationAndTeamData: params.organizationAndTeamData,
                repository: {
                    id: params.repository.id,
                    name: params.repository.name,
                },
                filters: {
                    branch: params.branch,
                    filePatterns: [...KODY_RULE_FILE_DISCOVERY_PATTERNS],
                },
            })) ?? [];
        return allFiles.filter(
            (file: { path: string }) => !isAgentInstructionSource(file.path),
        );
    }

    /**
     * Content of a file changed by a merged PR. Falls back to the base branch
     * and then the default branch when the source branch was deleted on merge
     * (e.g. GitLab).
     */
    private async getMergedFileContent(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        filename: string;
        pullRequest: any;
    }): Promise<string | null> {
        const { organizationAndTeamData, filename, pullRequest } = params;
        const repository = {
            id: params.repository.id,
            name: params.repository.name,
        };

        const fromHead = await this.getFileContent({
            organizationAndTeamData,
            repository,
            filename,
            pullRequest,
        });
        if (fromHead) return fromHead;

        const baseRef = pullRequest?.base?.ref;
        if (baseRef) {
            const fromBase = await this.getFileContent({
                organizationAndTeamData,
                repository,
                filename,
                pullRequest: { head: { ref: baseRef } },
            });
            if (fromBase) return fromBase;
        }

        try {
            const defaultBranch =
                await this.codeManagementService.getDefaultBranch({
                    organizationAndTeamData,
                    repository,
                });
            if (!defaultBranch) return null;
            return await this.getFileContent({
                organizationAndTeamData,
                repository,
                filename,
                pullRequest: { head: { ref: defaultBranch } },
            });
        } catch {
            return null;
        }
    }

    /**
     * Writes the rule a repository file defines, or removes it when the file
     * carries `@kody-ignore`. The only path from a file to a rule: the
     * template, parsed verbatim. `writeThroughUseCase` routes the write
     * through the centralized-config aware use case (merge-triggered sync).
     */
    private async upsertRuleFromFile(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        filePath: string;
        content: string;
        previousPath?: string;
        writeThroughUseCase: boolean;
        defaultStatus?: KodyRulesStatus;
    }): Promise<FileSyncOutcome> {
        const {
            organizationAndTeamData,
            repository,
            filePath,
            content,
            previousPath,
        } = params;

        if (this.shouldIgnoreFile(content)) {
            await this.deleteRuleBySourcePath({
                organizationAndTeamData,
                repositoryId: repository.id,
                sourcePath: previousPath ?? filePath,
            });
            return { outcome: 'removed' };
        }

        const converted = await this.templateFileToRule({
            filePath,
            repositoryId: repository.id,
            content,
            organizationAndTeamData,
            defaultStatus: params.defaultStatus,
        });

        if (converted.kind === 'skipped') {
            return { outcome: 'skipped', reason: converted.reason };
        }

        const existing = await this.findRuleBySourcePath({
            organizationAndTeamData,
            repositoryId: repository.id,
            sourcePath: previousPath ?? filePath,
        });

        const dto = {
            ...converted.rule,
            uuid: existing?.uuid,
            sourcePath: filePath,
            repositoryId: repository.id,
            directoryId: (
                await this.resolveDirectoryForFile({
                    organizationAndTeamData,
                    repositoryId: repository.id,
                    filePath,
                })
            )?.id,
        } as CreateKodyRuleDto;

        const result = params.writeThroughUseCase
            ? await this.createOrUpdateKodyRulesUseCase.execute(
                  dto,
                  organizationAndTeamData.organizationId,
                  this.systemUserInfo,
                  true,
                  organizationAndTeamData.teamId,
              )
            : await this.kodyRulesService.createOrUpdate(
                  organizationAndTeamData,
                  dto,
                  this.systemUserInfo,
              );

        // In centralized PR mode the mutation returns PR metadata, not the
        // entity; fall back to the known uuid or look the rule up again.
        let resolvedRuleId = this.getRuleId(result) || existing?.uuid;
        if (!resolvedRuleId) {
            resolvedRuleId = (
                await this.findRuleBySourcePath({
                    organizationAndTeamData,
                    repositoryId: repository.id,
                    sourcePath: filePath,
                })
            )?.uuid;
        }

        await this.processContextReferences({
            ruleId: resolvedRuleId,
            ruleText: dto.rule,
            repositoryId: dto.repositoryId,
            organizationAndTeamData,
        });

        try {
            await this.updateOrCreateCodeReviewParameterUseCase.execute({
                organizationAndTeamData,
                configValue: {},
                repositoryId: repository.id,
                skipAuthorization: true,
            });
        } catch (paramError) {
            this.logger.error({
                message:
                    'Failed to ensure CODE_REVIEW_CONFIG after rule sync',
                context: KodyRulesSyncService.name,
                error: paramError,
                metadata: { repositoryId: repository.id, file: filePath },
            });
        }

        return { outcome: 'imported', rule: result };
    }

    private recordOutcome(
        summary: SyncSummary,
        file: string,
        result: FileSyncOutcome,
    ): void {
        if (result.outcome === 'imported') summary.imported.push(file);
        else if (result.outcome === 'removed') summary.removed.push(file);
        else summary.skipped.push({ file, reason: result.reason });
    }

    // Grep-able per-run summary ("[kody-rules-sync] summary"): the single
    // record self-hosted operators need to answer "did my file sync, and if
    // not why".
    private logSyncSummary(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        trigger: 'merge' | 'main' | 'main:path' | 'onboarding';
        summary: SyncSummary;
        candidates: number;
        extra?: Record<string, unknown>;
    }): void {
        const { summary } = params;
        this.logger.log({
            message: `[kody-rules-sync] summary (${params.trigger}): ${summary.imported.length} imported, ${summary.skipped.length} skipped, ${summary.removed.length} removed (of ${params.candidates} candidate file(s))`,
            context: KodyRulesSyncService.name,
            metadata: {
                organizationAndTeamData: params.organizationAndTeamData,
                repositoryId: params.repositoryId,
                trigger: params.trigger,
                ...params.extra,
                ...summary,
            },
        });
    }

    /**
     * Onboarding import: the repository's Kody rule template files, written as
     * that repository's rules with the same status rule as any other sync
     * (`kodyKnowledgeApproval`). Coding-agent files and dependency manifests
     * are never turned into rules here.
     */
    async syncRepositoryMainFast(
        params: SyncTarget & {
            maxFiles?: number;
            maxFileSizeBytes?: number;
            maxTotalBytes?: number;
            maxConcurrent?: number;
        },
    ): Promise<{
        rules: unknown[];
        skippedFiles: Array<{ file: string; reason: string }>;
        errors: Array<{ file?: string; message: string }>;
    }> {
        const { organizationAndTeamData, repository } = params;
        const response = {
            rules: [] as unknown[],
            skippedFiles: [] as Array<{ file: string; reason: string }>,
            errors: [] as Array<{ file?: string; message: string }>,
        };

        const maxFiles = params.maxFiles ?? 20;
        const maxFileSizeBytes = params.maxFileSizeBytes ?? 200_000;
        const maxTotalBytes = params.maxTotalBytes ?? 2_000_000;
        const maxConcurrent = Math.max(
            1,
            Math.min(params.maxConcurrent ?? 5, 10),
        );

        try {
            const branch = await this.codeManagementService.getDefaultBranch({
                organizationAndTeamData,
                repository,
            });

            const allFiles = await this.listKodyRuleFiles({
                organizationAndTeamData,
                repository,
                branch,
            });

            // Caps on metadata first, so nothing over budget is downloaded.
            const selected: string[] = [];
            let totalBytes = 0;
            for (const file of allFiles) {
                const size =
                    typeof file?.size === 'number' && file.size >= 0
                        ? file.size
                        : 0;
                if (selected.length >= maxFiles) {
                    response.skippedFiles.push({
                        file: file.path,
                        reason: 'max files cap reached',
                    });
                } else if (size > maxFileSizeBytes) {
                    response.skippedFiles.push({
                        file: file.path,
                        reason: 'file too large (metadata)',
                    });
                } else if (totalBytes + size > maxTotalBytes) {
                    response.skippedFiles.push({
                        file: file.path,
                        reason: 'max aggregate size reached',
                    });
                } else {
                    selected.push(file.path);
                    totalBytes += size;
                }
            }

            const summary: SyncSummary = {
                imported: [],
                skipped: [],
                removed: [],
            };

            let index = 0;
            const worker = async () => {
                while (index < selected.length) {
                    const filePath = selected[index++];
                    try {
                        const content = await this.getFileContent({
                            organizationAndTeamData,
                            repository: {
                                id: repository.id,
                                name: repository.name,
                            },
                            filename: filePath,
                            branch,
                        });

                        if (!content) {
                            summary.skipped.push({
                                file: filePath,
                                reason: 'empty content',
                            });
                            continue;
                        }
                        if (content.length > maxFileSizeBytes) {
                            summary.skipped.push({
                                file: filePath,
                                reason: 'file too large',
                            });
                            continue;
                        }

                        const result = await this.upsertRuleFromFile({
                            organizationAndTeamData,
                            repository,
                            filePath,
                            content,
                            writeThroughUseCase: false,
                        });
                        this.recordOutcome(summary, filePath, result);
                        if (result.outcome === 'imported') {
                            response.rules.push(result.rule);
                        }
                    } catch (error) {
                        response.errors.push({
                            file: filePath,
                            message:
                                error instanceof Error
                                    ? error.message
                                    : 'unexpected error',
                        });
                    }
                }
            };

            await Promise.all(
                Array.from(
                    { length: Math.min(maxConcurrent, selected.length) },
                    () => worker(),
                ),
            );

            response.skippedFiles.push(...summary.skipped);

            this.logSyncSummary({
                organizationAndTeamData,
                repositoryId: repository.id,
                trigger: 'onboarding',
                summary,
                candidates: allFiles.length,
                extra: { branch, errors: response.errors.length },
            });
        } catch (error) {
            response.errors.push({
                message:
                    error instanceof Error ? error.message : 'unexpected error',
            });
        }

        return response;
    }

    private extractRefsFromPullRequest(pr: any): {
        head?: string;
        base?: string;
    } {
        const normalize = (ref?: string): string | undefined => {
            if (!ref) return undefined;
            return ref.startsWith('refs/heads/')
                ? ref.replace('refs/heads/', '')
                : ref;
        };

        const head = normalize(
            pr?.head?.ref || // GitHub
                pr?.source?.branch?.name || // Bitbucket
                pr?.sourceRefName || // Azure
                pr?.source_branch || // GitLab
                pr?.fromRef?.displayId, // Bitbucket Server
        );

        const base = normalize(
            pr?.base?.ref || // GitHub
                pr?.destination?.branch?.name || // Bitbucket
                pr?.targetRefName || // Azure
                pr?.target_branch || // GitLab
                pr?.toRef?.displayId, // Bitbucket Server
        );

        return { head, base };
    }

    /**
     * Default status for a rule synced from a repo rule file. When the org's
     * knowledge-approval gate is on, IDE-synced rules land PENDING for review
     * (consistent with generated knowledge) and flow through the normal
     * pending UI; otherwise they stay ACTIVE. A config-resolution error falls
     * back to ACTIVE so a sync is never blocked on the lookup.
     */
    private async resolveSyncDefaultStatus(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<KodyRulesStatus> {
        try {
            const mergedConfig =
                await this.codeBaseConfigService.getSimpleConfig(
                    organizationAndTeamData,
                    { repositoryId },
                );

            return requiresKnowledgeApproval(
                mergedConfig.kodyKnowledgeApproval,
                KodyRulesOrigin.REPO_FILE_SYNC,
            )
                ? KodyRulesStatus.PENDING
                : KodyRulesStatus.ACTIVE;
        } catch (error) {
            this.logger.warn({
                message:
                    'Could not resolve kodyKnowledgeApproval for IDE-synced rule; defaulting to active',
                context: KodyRulesSyncService.name,
                error:
                    error instanceof Error ? error : new Error(String(error)),
                metadata: { organizationAndTeamData, repositoryId },
            });
            return KodyRulesStatus.ACTIVE;
        }
    }

    /**
     * File-reference tokens like `@AGENTS.md` or `@docs/standards.md`:
     * an `@` at a word boundary followed by a path-ish token that ends in
     * a file extension. Markers without an extension (`@kody-sync`) and
     * extglobs (`@(a,b)`) don't match.
     */
    private static readonly AT_FILE_REF_RE =
        /(?:^|[\s(<"'`])@([A-Za-z0-9_\-./]+\.[A-Za-z0-9]{1,8})\b/g;

    /**
     * Resolves `@file` references in a rule file's content and appends the
     * referenced files' content, so LLM extraction sees the guidance that
     * the author factored out (the standard CLAUDE.md → `@AGENTS.md`
     * convention). Depth 1 (references inside referenced files are NOT
     * followed), max 5 references, 100KB per file. Each reference is tried
     * relative to the referencing file's directory first, then repo-root.
     * Failures are logged and skipped — they never fail the sync (the
     * context-reference subsystem separately surfaces them as sync errors).
     */
    private async inlineAtFileReferences(params: {
        content: string;
        filePath: string;
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        branch?: string;
        pullRequest?: any;
    }): Promise<string> {
        const MAX_REFS = 5;
        const MAX_BYTES_PER_FILE = 100_000;

        const refs = new Set<string>();
        for (const match of params.content.matchAll(
            KodyRulesSyncService.AT_FILE_REF_RE,
        )) {
            refs.add(match[1]);
            if (refs.size >= MAX_REFS) break;
        }
        if (!refs.size) return params.content;

        const baseDir = path.posix.dirname(params.filePath.replace(/\\/g, '/'));
        const sections: string[] = [];

        for (const ref of refs) {
            const candidates = Array.from(
                new Set([
                    baseDir && baseDir !== '.'
                        ? path.posix.join(baseDir, ref)
                        : ref,
                    ref,
                ]),
            );

            let resolvedPath: string | null = null;
            let refContent: string | null = null;
            for (const candidate of candidates) {
                try {
                    const content = await this.getFileContent({
                        organizationAndTeamData: params.organizationAndTeamData,
                        repository: params.repository,
                        filename: candidate,
                        branch: params.branch,
                        pullRequest: params.pullRequest,
                    });
                    if (content) {
                        resolvedPath = candidate;
                        refContent = content.slice(0, MAX_BYTES_PER_FILE);
                        break;
                    }
                } catch {
                    // try next candidate
                }
            }

            if (resolvedPath && refContent) {
                sections.push(
                    `<referenced-file path="${resolvedPath}" via="@${ref}">\n${refContent}\n</referenced-file>`,
                );
            } else {
                this.logger.warn({
                    message:
                        '[kody-rules-sync] could not resolve @file reference while importing rule file',
                    context: KodyRulesSyncService.name,
                    metadata: {
                        reference: `@${ref}`,
                        referencedFrom: params.filePath,
                        candidatesTried: candidates,
                        repositoryId: params.repository.id,
                    },
                });
            }
        }

        if (!sections.length) return params.content;

        this.logger.log({
            message: `[kody-rules-sync] inlined ${sections.length} @file reference(s) before rule extraction`,
            context: KodyRulesSyncService.name,
            metadata: {
                filePath: params.filePath,
                repositoryId: params.repository.id,
                inlinedCount: sections.length,
            },
        });

        return [
            params.content,
            '',
            '<!-- The sections below are files referenced via @file from the content above; treat them as part of the same guidance. -->',
            ...sections,
        ].join('\n');
    }

    /**
     * The only way a repository file becomes a Kody Rule: the template parsed
     * verbatim (`parseKodyRuleFile`). Anything else (a coding-agent file, a
     * README under `rules/`, a file whose frontmatter broke) is skipped and
     * never handed to an LLM.
     */
    private async templateFileToRule(params: {
        filePath: string;
        repositoryId: string;
        content: string;
        organizationAndTeamData: OrganizationAndTeamData;
        defaultStatus?: KodyRulesStatus;
    }): Promise<
        | { kind: 'rule'; rule: Partial<CreateKodyRuleDto> }
        | { kind: 'skipped'; reason: string }
    > {
        if (
            isAgentInstructionSource(params.filePath) ||
            !isKodyRuleTemplateFile(params.filePath)
        ) {
            return { kind: 'skipped', reason: 'not a Kody rule file' };
        }

        const parsed = parseKodyRuleFile(params.content);
        if (!parsed) {
            this.logger.warn({
                message:
                    '[kody-rules-sync] skipped: not a rule template (needs frontmatter with a title and a body)',
                context: KodyRulesSyncService.name,
                metadata: {
                    filePath: params.filePath,
                    repositoryId: params.repositoryId,
                    organizationId:
                        params.organizationAndTeamData?.organizationId,
                },
            });
            return { kind: 'skipped', reason: 'not a rule template' };
        }

        if (!parsed.enabled) {
            return { kind: 'skipped', reason: 'disabled via frontmatter' };
        }

        const license =
            await this.permissionValidationService.validateBasicLicense(
                params.organizationAndTeamData,
                KodyRulesSyncService.name,
            );
        if (!license?.allowed) {
            return { kind: 'skipped', reason: 'license not valid' };
        }

        const status =
            params.defaultStatus ??
            (await this.resolveSyncDefaultStatus(
                params.organizationAndTeamData,
                params.repositoryId,
            ));

        // Same guard every synced rule gets: a template can't scope a rule
        // against the rule sources themselves.
        const validated = validateAndScopeIdeRulePath({
            llmPath: parsed.path,
            sourceFilePath: params.filePath,
            pathSource: 'declared',
        });

        return {
            kind: 'rule',
            rule: {
                title: parsed.title,
                rule: parsed.rule,
                path: validated.path,
                sourcePath: params.filePath,
                severity: parsed.severity as KodyRuleSeverity,
                scope: parsed.scope as KodyRulesScope,
                repositoryId: params.repositoryId,
                origin: KodyRulesOrigin.REPO_FILE_SYNC,
                status,
                examples: parsed.examples,
            },
        };
    }

    /**
     * LLM conversion of a free-form file (CLAUDE.md, .cursorrules, ...) into a
     * Kody Rule. No sync path calls it any more: coding-agent files are not
     * review policy. It stays for the tool that turns an org's existing
     * agent-file rules into `.kody/rules` files.
     *
     * `@file` references (e.g. `@AGENTS.md` inside CLAUDE.md) are resolved and
     * inlined before extraction when the caller provides `fileRef`.
     */
    async convertFileToKodyRules(
        params: {
            filePath: string;
            repositoryId: string;
            content: string;
            organizationAndTeamData: OrganizationAndTeamData;
            /** Enables @file reference inlining (needs repo name + ref). */
            fileRef?: {
                repository: { id: string; name: string };
                branch?: string;
                pullRequest?: any;
            };
        },
        options?: {
            runName?: string;
            defaultStatus?: KodyRulesStatus;
        },
    ): Promise<Array<Partial<CreateKodyRuleDto>>> {
        const validationResult =
            await this.permissionValidationService.validateBasicLicense(
                params.organizationAndTeamData,
                KodyRulesSyncService.name,
            );

        if (!validationResult.allowed) {
            return null;
        }

        // Sourced once: this method needs the FULL config for BOTH the
        // codeReview carrier (below) and the has-BYOK gate (further down), so it
        // resolves the carrier locally rather than through the per-task API,
        // which would re-fetch the same config.
        const [rawV2, subscriptionStatus] = await Promise.all([
            this.permissionValidationService.getBYOKConfig(
                params.organizationAndTeamData,
            ),
            this.permissionValidationService.getSubscriptionStatus(
                params.organizationAndTeamData,
            ),
        ]);
        // native carrier for the codeReview task (runStructuredReviewCall +
        // the raw-JSON fallback build); non-v2/managed/BLOCKED → env default.
        const byokConfigValue = resolveTaskSlot(rawV2, LLM_TASK.codeReview).slot;

        const effectiveDefaultStatus =
            options?.defaultStatus ??
            (await this.resolveSyncDefaultStatus(
                params.organizationAndTeamData,
                params.repositoryId,
            ));

        // Resolve @file references before the LLM sees the content, so
        // guidance split across files (CLAUDE.md → @AGENTS.md) is imported
        // instead of silently dropped.
        let effectiveContent = params.content;
        if (params.fileRef) {
            effectiveContent = await this.inlineAtFileReferences({
                content: params.content,
                filePath: params.filePath,
                organizationAndTeamData: params.organizationAndTeamData,
                repository: params.fileRef.repository,
                branch: params.fileRef.branch,
                pullRequest: params.fileRef.pullRequest,
            });
        }

        // Our managed (default) models are trial-only. BYOK always wins —
        // runStructuredReviewCall below uses the customer's model whenever a
        // BYOK config is present, regardless of subscription state. But once
        // the trial ends, an org without its own key must NOT silently fall
        // back to our managed models: skip the LLM conversion instead.
        // Self-hosted / unknown statuses are left untouched.
        const POST_TRIAL_REQUIRES_BYOK = [
            SubscriptionStatus.ACTIVE,
            SubscriptionStatus.PAYMENT_FAILED,
            SubscriptionStatus.CANCELED,
            SubscriptionStatus.EXPIRED,
        ];
        // native has-BYOK: the org brought at least one non-managed key.
        const hasByok = hasNonManagedCredential(rawV2);
        if (
            !hasByok &&
            POST_TRIAL_REQUIRES_BYOK.includes(
                subscriptionStatus as SubscriptionStatus,
            )
        ) {
            this.logger.log({
                message:
                    '[kody-rules-sync] skipping LLM file conversion: trial ended and no BYOK configured',
                context: KodyRulesSyncService.name,
                metadata: {
                    filePath: params.filePath,
                    repositoryId: params.repositoryId,
                    subscriptionStatus,
                },
            });
            return [];
        }

        const mainRun = options?.runName ?? 'kodyRulesFileToRules';

        try {
            const result = await LLM.run({
                byokConfig: byokConfigValue ?? undefined,
                schema: kodyRulesIDEGeneratorSchema,
                organizationId:
                    params.organizationAndTeamData?.organizationId,
                runName: `${KodyRulesSyncService.name}::${mainRun}`,
                attrs: {
                    repositoryId: params.repositoryId,
                    filePath: params.filePath,
                    fallback: false,
                },
                system: [
                                'Convert repository rule files (Cursor, Claude, GitHub rules, coding standards, etc.) into a JSON array of Kody Rules. IMPORTANT: Enforce exactly one rule per file. If multiple candidate rules exist, merge them COMPREHENSIVELY into one unified rule that preserves all essential details.',
                                'Output ONLY a valid JSON object with a "rules" array. Format: {"rules": [...]}. If no rules, output {"rules": []}. No comments or explanations.',
                                'Each item in the "rules" array MUST match exactly:',
                                '{"title": string, "rule": string, "path": string, "pathSource": "declared"|"content-inferred"|"location-inferred"|"default-repo-wide", "sourcePath": string, "severity": "low"|"medium"|"high"|"critical", "scope"?: "file"|"pull-request", "status"?: "active"|"pending"|"rejected"|"deleted", "examples": [{ "snippet": string, "isCorrect": boolean }], "sourceSnippet"?: string}',
                                'Detection: extract a rule only if the text imposes a requirement/restriction/convention/standard.',
                                'Severity map: must/required/security/blocker → "high" or "critical"; should/warn → "medium"; tip/info/optional → "low".',
                                'Scope: "file" for code/content; "pull-request" for PR titles/descriptions/commits/reviewers/labels.',
                                'Status: "active"',

                                // === path / pathSource — choose in this strict priority order ===
                                'path (target GLOB) — pick the NARROWEST glob that captures what the rule is about, in this priority order:',
                                '  (1) DECLARED — if the source file declares a glob (frontmatter "globs:", an explicit "Path:" / "Applies to:" line, etc.), use it verbatim. Set "pathSource": "declared". Comma-join multiple declared globs (e.g. "services/**,api/**").',
                                '  (2) CONTENT-INFERRED — if no declared glob, inspect the rule body and infer from concrete signals. Set "pathSource": "content-inferred". Mapping examples:',
                                '       TypeScript / TS files / .ts → "**/*.ts,**/*.tsx"',
                                '       Python / .py → "**/*.py"',
                                '       Go / Golang → "**/*.go"',
                                '       Java → "**/*.java"',
                                '       React / JSX / components → "**/*.tsx,**/*.jsx"',
                                '       API controllers / HTTP handlers → "**/*.controller.ts,**/api/**"',
                                '       Tests / specs → "**/*.test.ts,**/*.spec.ts"',
                                '       esbuild config → "esbuild.config.{js,ts,mjs}"',
                                '       webpack config → "webpack.config.*"',
                                '       eslint config → ".eslintrc*,eslint.config.*"',
                                '       Dockerfiles → "**/Dockerfile,**/Dockerfile.*"',
                                '       VS Code Extension Webviews → "src/**/*.ts"',
                                '       Database migrations → "**/migrations/**"',
                                '  (3) LOCATION-INFERRED — if neither (1) nor (2) gives a useful narrowing AND the source MDC lives inside a repo subdirectory, scope to that subdirectory. Set "pathSource": "location-inferred". Examples:',
                                '       source "applications/foo/.cursor/rules/x.mdc" → "applications/foo/**"',
                                '       source "apps/api/.kody/rules/security.md" → "apps/api/**"',
                                '  (4) DEFAULT-REPO-WIDE — only as a last resort, when the rule is genuinely repo-wide and the source is at the repo root. Set "pathSource": "default-repo-wide". Use "**/*".',
                                'CRITICAL — NEVER set path to a glob that would match the rule source files themselves: do NOT emit ".cursor/rules/**", ".kody/rules/**", "CLAUDE.md", ".cursorrules", ".github/instructions/**", or any other IDE-rule directory. Those host the rule, not the code it lints. If you find yourself wanting to do that, fall back to (3) or (4).',
                                'CRITICAL — NEVER copy "sourcePath" into "path". They serve different purposes.',
                                'sourcePath: ALWAYS set to the exact file path provided in input.',
                                'sourceSnippet: when possible, include an EXACT copy (verbatim) of the bullet/line/paragraph from the file that led to this rule. Do NOT paraphrase. If none is suitable, omit this key.',

                                '**CRITICAL: The "rule" field must capture ALL essential information from the source file:**',
                                '- Include ALL prohibited patterns/anti-patterns (list each one explicitly)',
                                '- Include ALL recommended patterns/best practices (with code examples when present)',
                                '- Include ALL key principles, guidelines, and rationale',
                                '- Include configuration instructions and setup steps when present',
                                '- Include references to real examples in the codebase when mentioned',
                                '- Use markdown formatting (lists, code blocks, headers) to organize complex rules clearly',
                                '- DO NOT summarize or compress - preserve specific method names, class names, code snippets, and technical details',
                                '- The rule should be self-contained and actionable without needing to read the source file',

                                'Examples: prefer 1 incorrect and 1 correct (minimal snippets). When the source has many examples, include the most representative ones.',
                                'Language: always return the rule text in English, even if the source content is in another language.',
                                'Do NOT include keys like repositoryId, origin, createdAt, updatedAt, uuid, or any extra keys.',
                                'Keep strings strictly typed, but COMPREHENSIVE in content - do not sacrifice completeness for brevity.',
                ].join(' '),
                user: `File: ${params.filePath}\n\nContent:\n${effectiveContent}`,
            });

            if (!result?.rules || result.rules.length === 0) return [];

            const normalizeRule = (rule: any): Partial<CreateKodyRuleDto> => {
                const sourcePath = rule?.sourcePath || params.filePath;
                // Single entry point for path validation/scoping. Replaces
                // the old `rule?.path || params.filePath` fallback (which
                // could echo the source path into the rule) and the
                // post-hoc scopePathToSourceDirectory call.
                const validated = validateAndScopeIdeRulePath({
                    llmPath: rule?.path,
                    sourceFilePath: sourcePath,
                    pathSource: rule?.pathSource,
                });

                if (validated.reason !== 'accepted-as-is') {
                    // Telemetry: non-trivial path interventions are the
                    // signal that the LLM prompt drifted or hit an edge
                    // case the validator caught. Aggregate over time to
                    // see if "default-repo-wide" or "rejected-ide-path"
                    // is a recurring pattern that needs prompt tuning.
                    this.logger.log({
                        message: `[kody-rules-sync] path validation: ${validated.reason}`,
                        context: KodyRulesSyncService.name,
                        metadata: {
                            sourceFilePath: sourcePath,
                            originalLlmPath: validated.originalLlmPath,
                            finalPath: validated.path,
                            pathSource: rule?.pathSource ?? 'unspecified',
                            repositoryId: params.repositoryId,
                        },
                    });
                }

                return {
                    ...rule,
                    severity:
                        (rule?.severity?.toString?.().toLowerCase?.() as any) ||
                        KodyRuleSeverity.MEDIUM,
                    scope: (rule?.scope as any) || KodyRulesScope.FILE,
                    path: validated.path,
                    sourcePath,
                    repositoryId: rule?.repositoryId || params.repositoryId,
                    origin: KodyRulesOrigin.REPO_FILE_SYNC,
                    status: effectiveDefaultStatus,
                    examples: Array.isArray(rule?.examples)
                        ? rule.examples.map((example: any) => ({
                              snippet: example?.snippet || '',
                              isCorrect: example?.isCorrect || false,
                          }))
                        : [],
                };
            };

            return result.rules.map(normalizeRule);
        } catch {
            const fbRun = `${mainRun}Raw`;

            try {
                // Raw-JSON retry on the LOCAL (Vercel) stack — same default/BYOK
                // main model as the structured call above, plain-text output so a
                // schema mismatch that broke Output.object still yields something
                // extractJsonArray can salvage.
                // Raw-JSON re-issue through the shared text executor (Porta 2):
                // same resolved slot as the structured call above, plain-text out.
                const raw = await LLM.run({
                    byokConfig: byokConfigValue ?? undefined,
                    system: 'Return ONLY the JSON array for the rules, without code fences. Include a "sourceSnippet" field when you can copy an exact excerpt from the file for each rule. No explanations.',
                    user: `File: ${params.filePath}\n\nContent:\n${effectiveContent}`,
                    runName: fbRun,
                    spanName: `${KodyRulesSyncService.name}::${fbRun}`,
                    attrs: {
                        repositoryId: params.repositoryId,
                        filePath: params.filePath,
                        fallback: true,
                    },
                    organizationId:
                        params.organizationAndTeamData?.organizationId,
                });

                const parsed = this.extractJsonArray(raw);
                if (!Array.isArray(parsed)) {
                    return [];
                }

                const normalizeRule = (
                    rule: any,
                ): Partial<CreateKodyRuleDto> => ({
                    ...rule,
                    severity:
                        (rule?.severity?.toString?.().toLowerCase?.() as any) ||
                        KodyRuleSeverity.MEDIUM,
                    scope: (rule?.scope as any) || KodyRulesScope.FILE,
                    path: rule?.path || params.filePath,
                    sourcePath: rule?.sourcePath || params.filePath,
                    repositoryId: rule?.repositoryId || params.repositoryId,
                    origin: KodyRulesOrigin.REPO_FILE_SYNC,
                    status: effectiveDefaultStatus,
                    examples: Array.isArray(rule?.examples)
                        ? rule.examples.map((example: any) => ({
                              snippet: example?.snippet || '',
                              isCorrect: example?.isCorrect || false,
                          }))
                        : [],
                });

                return parsed.map(normalizeRule);
            } catch (fallbackError) {
                this.logger.error({
                    message: 'LLM conversion failed for rule file',
                    context: KodyRulesSyncService.name,
                    metadata: {
                        ...params,
                        organizationAndTeamData: params.organizationAndTeamData,
                    },
                    error: fallbackError,
                });
                return [];
            }
        }
    }

    private extractJsonArray(text: string | null | undefined): any[] | null {
        if (!text || typeof text !== 'string') return null;
        let s = text.trim();
        const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (fenceMatch && fenceMatch[1]) s = fenceMatch[1].trim();
        if (s.startsWith('"') && s.endsWith('"')) {
            try {
                s = JSON.parse(s);
            } catch {
                // Ignore error
            }
        }
        const start = s.indexOf('[');
        const end = s.lastIndexOf(']');
        if (start >= 0 && end > start) s = s.slice(start, end + 1);
        try {
            const parsed = JSON.parse(s);
            return Array.isArray(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }

    private getRuleId(result: unknown): string | undefined {
        if (!result) {
            return undefined;
        }

        const candidate = result as Record<string, unknown>;

        if (typeof candidate.uuid === 'string' && candidate.uuid) {
            return candidate.uuid;
        }

        if (typeof candidate.id === 'string' && candidate.id) {
            return candidate.id;
        }

        const fallback =
            typeof candidate._id === 'string'
                ? (candidate._id as string)
                : undefined;
        return fallback;
    }

    private async processContextReferences(params: {
        ruleId?: string;
        ruleText?: string;
        repositoryId?: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<void> {
        const { ruleId, ruleText, repositoryId, organizationAndTeamData } =
            params;

        if (!ruleId || !ruleText || !repositoryId) {
            this.logger.debug({
                message:
                    'Skipping context reference detection due to missing data',
                context: KodyRulesSyncService.name,
                metadata: {
                    hasRuleId: !!ruleId,
                    hasRuleText: !!ruleText,
                    hasRepositoryId: !!repositoryId,
                },
            });
            return;
        }

        let resolvedTeamId: string | undefined = organizationAndTeamData.teamId;
        if (!resolvedTeamId && repositoryId !== 'global') {
            try {
                resolvedTeamId =
                    await this.contextResolutionService.getTeamIdByOrganizationAndRepository(
                        organizationAndTeamData.organizationId,
                        repositoryId,
                    );
            } catch (error) {
                this.logger.warn({
                    message:
                        'Failed to resolve team for repository while syncing context references',
                    context: KodyRulesSyncService.name,
                    error,
                    metadata: {
                        repositoryId,
                        organizationAndTeamData,
                    },
                });
            }
        }

        const detectionOrgData: OrganizationAndTeamData = resolvedTeamId
            ? { ...organizationAndTeamData, teamId: resolvedTeamId }
            : organizationAndTeamData;

        let repositoryName = repositoryId;
        try {
            repositoryName = await this.resolveRepositoryName(
                organizationAndTeamData.organizationId,
                repositoryId,
            );
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to resolve repository name for context references, using ID as fallback',
                context: KodyRulesSyncService.name,
                error,
                metadata: {
                    repositoryId,
                    organizationAndTeamData,
                },
            });
        }

        const detectionFields: ContextDetectionField[] = [
            {
                fieldId: '',
                path: ['kodyRule', ruleId],
                sourceType: PromptSourceType.KODY_RULE,
                text: ruleText,
                metadata: { sourceSnippet: ruleText },
                consumerKind: 'prompt',
                consumerName: ruleId,
                conversationIdOverride: ruleId,
                requestDomain: 'code',
                taskIntent: 'Process kodyRule references',
            },
        ];

        // native carrier for the reference-detection chain (codeReview task).
        const [byokConfig, subscriptionStatus] = await Promise.all([
            this.permissionValidationService.resolveTaskSlot(
                detectionOrgData,
                LLM_TASK.codeReview,
            ),
            this.permissionValidationService.getSubscriptionStatus(
                detectionOrgData,
            ),
        ]);

        try {
            const contextReferenceId =
                await this.contextReferenceDetectionService.detectAndSaveReferences(
                    {
                        entityType: 'kodyRule',
                        entityId: ruleId,
                        fields: detectionFields,
                        repositoryId,
                        repositoryName,
                        organizationAndTeamData: detectionOrgData,
                        byokConfig: byokConfig ?? undefined,
                        subscriptionStatus,
                    },
                );

            // Detection returns no id for a rule that references nothing, and
            // the pointer must then be cleared — the same as a save from the UI
            // (create-or-update.use-case.ts). Null, not undefined: the
            // repository skips undefined fields, which would keep the pointer.
            await this.kodyRulesService.updateRuleReferences(
                organizationAndTeamData.organizationId,
                ruleId,
                { contextReferenceId: contextReferenceId ?? null },
            );

            this.logger.log({
                message: 'Processed context references for synced kody rule',
                context: KodyRulesSyncService.name,
                metadata: {
                    ruleId,
                    repositoryId,
                    contextReferenceId,
                },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to detect or persist context references for kody rule',
                context: KodyRulesSyncService.name,
                error,
                metadata: {
                    ruleId,
                    repositoryId,
                },
            });
        }
    }

    private async resolveRepositoryName(
        organizationId: string,
        repositoryId: string,
    ): Promise<string> {
        if (repositoryId === 'global') {
            return 'global';
        }

        return await this.contextResolutionService.getRepositoryNameByOrganizationAndRepository(
            organizationId,
            repositoryId,
        );
    }

    /**
     * Busca e decodifica o conteúdo de um arquivo do repositório
     */
    private async getFileContent(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repository: { id: string; name: string };
        filename: string;
        pullRequest?: any;
        branch?: string;
    }): Promise<string | null> {
        try {
            const {
                organizationAndTeamData,
                repository,
                filename,
                pullRequest,
                branch,
            } = params;

            const requestParams: any = {
                organizationAndTeamData,
                repository,
                file: { filename },
            };

            if (pullRequest) {
                requestParams.pullRequest = pullRequest;
            } else if (branch) {
                requestParams.pullRequest = {
                    head: { ref: branch },
                    base: { ref: branch },
                };
            }

            const contentResp =
                await this.codeManagementService.getRepositoryContentFile(
                    requestParams,
                );
            const rawContent = contentResp?.data?.content;

            if (!rawContent) return null;

            const decoded =
                contentResp?.data?.encoding === 'base64'
                    ? Buffer.from(rawContent, 'base64').toString('utf-8')
                    : rawContent;

            return decoded;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to get file content',
                context: KodyRulesSyncService.name,
                metadata: {
                    filename: params.filename,
                    organizationAndTeamData: params.organizationAndTeamData,
                },
                error,
            });
            return null;
        }
    }

    /**
     * Verifica se um arquivo deve ser ignorado baseado na marcação @kody-ignore
     * A marcação pode estar no início ou final do arquivo
     */
    private shouldIgnoreFile(content: string): boolean {
        if (!content || typeof content !== 'string') {
            return false;
        }

        const trimmedContent = content.trim();
        if (!trimmedContent) {
            return false;
        }

        // Verifica as primeiras 10 linhas do arquivo
        const lines = trimmedContent.split('\n');
        const firstLines = lines.slice(0, 10);
        const lastLines = lines.slice(-10);

        // Padrão para detectar @kody-ignore (case insensitive, com possíveis comentários)
        const ignorePattern = /@kody-ignore\b/i;

        // Verifica no início do arquivo
        const hasIgnoreAtStart = firstLines.some((line) =>
            ignorePattern.test(line.trim()),
        );

        // Verifica no final do arquivo
        const hasIgnoreAtEnd = lastLines.some((line) =>
            ignorePattern.test(line.trim()),
        );

        return hasIgnoreAtStart || hasIgnoreAtEnd;
    }

    /**
     * Flips every rule imported from a coding-agent file (CLAUDE.md,
     * .cursor/rules, ...) in `repositoryIds` to `targetStatus`, optionally only
     * those currently in `onlyFromStatus`. These rules are frozen: nothing
     * syncs them any more, and this is how admins pause or remove them.
     *
     * Returns the count of rules whose status was changed.
     */
    private async transitionIdeSyncRulesStatus(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds: string[];
        targetStatus: KodyRulesStatus;
        onlyFromStatus?: KodyRulesStatus[];
    }): Promise<number> {
        const { organizationAndTeamData, targetStatus, onlyFromStatus } =
            params;
        const repositoryIds = new Set(params.repositoryIds);
        if (repositoryIds.size === 0) return 0;

        const entity = await this.kodyRulesService.findByOrganizationId(
            organizationAndTeamData.organizationId,
        );
        if (!entity?.rules) return 0;

        const ideSyncRules = entity.rules.filter((r: any) => {
            if (!repositoryIds.has(r?.repositoryId)) return false;
            if (!isAgentInstructionSource(r?.sourcePath)) return false;
            if (onlyFromStatus && !onlyFromStatus.includes(r?.status)) {
                return false;
            }
            return true;
        });

        // Route through the centralized-aware use-cases (which fall back to a
        // direct DB write when centralized config is off) so bulk pause/resume/
        // delete don't bypass config-as-code: pause/resume re-emit the rule
        // file (paused → `enabled: false`), delete removes it.
        let changed = 0;
        for (const rule of ideSyncRules) {
            if (!rule.uuid) continue;

            if (targetStatus === KodyRulesStatus.DELETED) {
                const deleted = await this.deleteSyncedRuleIfPresent(
                    organizationAndTeamData,
                    rule.uuid,
                );
                if (!deleted) continue;
            } else {
                await this.createOrUpdateKodyRulesUseCase.execute(
                    { ...rule, status: targetStatus } as any,
                    organizationAndTeamData.organizationId,
                    this.systemUserInfo,
                    true,
                    organizationAndTeamData.teamId,
                );
            }
            changed += 1;
        }
        return changed;
    }

    /**
     * Soft-delete all IDE-synced rules for a repository (status → DELETED).
     * Used by the toggle-off `delete` action and by the imported-rules
     * management endpoint. The rule is kept for audit/undo but is hidden
     * from the user's listing and skipped by the enforcement filter.
     */
    async purgeAllIdeSyncRulesForRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<void> {
        await this.purgeAllIdeSyncRulesForRepositories({
            organizationAndTeamData: params.organizationAndTeamData,
            repositoryIds: [params.repositoryId],
        });
    }

    /** Same as above for several repositories, loading the org's rules once. */
    async purgeAllIdeSyncRulesForRepositories(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds: string[];
    }): Promise<void> {
        try {
            await this.transitionIdeSyncRulesStatus({
                ...params,
                targetStatus: KodyRulesStatus.DELETED,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to purge IDE sync rules for repositories',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
        }
    }

    /**
     * Soft-disable all IDE-synced rules for a repository (status → PAUSED).
     * Used by the toggle-off `pause` action and by the management endpoint.
     * The rule stays visible in the user's list but is skipped by the
     * enforcement filter, so PRs are no longer reviewed against it. Reversible
     * via `resumeAllIdeSyncRulesForRepository`.
     *
     * Only rules currently in ACTIVE are paused (idempotent: PAUSED stays
     * PAUSED, DELETED stays DELETED).
     */
    async pauseAllIdeSyncRulesForRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<void> {
        await this.pauseAllIdeSyncRulesForRepositories({
            organizationAndTeamData: params.organizationAndTeamData,
            repositoryIds: [params.repositoryId],
        });
    }

    /** Same as above for several repositories, loading the org's rules once. */
    async pauseAllIdeSyncRulesForRepositories(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds: string[];
    }): Promise<void> {
        try {
            await this.transitionIdeSyncRulesStatus({
                ...params,
                targetStatus: KodyRulesStatus.PAUSED,
                onlyFromStatus: [KodyRulesStatus.ACTIVE],
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to pause IDE sync rules for repositories',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
        }
    }

    /**
     * Re-enable all paused IDE-synced rules for a repository (status →
     * ACTIVE). Mirror of `pauseAllIdeSyncRulesForRepository`. Only rules
     * currently in PAUSED are flipped — DELETED rules are not resurrected
     * via this path (re-enabling auto-sync re-imports them from source).
     */
    async resumeAllIdeSyncRulesForRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<void> {
        try {
            await this.transitionIdeSyncRulesStatus({
                organizationAndTeamData: params.organizationAndTeamData,
                repositoryIds: [params.repositoryId],
                targetStatus: KodyRulesStatus.ACTIVE,
                onlyFromStatus: [KodyRulesStatus.PAUSED],
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to resume IDE sync rules for repository',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
        }
    }

    /**
     * Rules imported from coding-agent files in a repository, per status.
     * Drives the "frozen rules" notice on the Kody Rules page.
     */
    async countIdeSyncRulesForRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
    }): Promise<IdeSyncRuleCounts> {
        return this.countIdeSyncRulesForRepositories({
            organizationAndTeamData: params.organizationAndTeamData,
            repositoryIds: [params.repositoryId],
        });
    }

    private async countIdeSyncRulesForRepositories(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryIds: string[];
    }): Promise<IdeSyncRuleCounts> {
        const { organizationAndTeamData } = params;
        const repositoryIds = new Set(params.repositoryIds);
        const counts = { active: 0, paused: 0, deleted: 0 };
        if (repositoryIds.size === 0) return counts;

        const entity = await this.kodyRulesService.findByOrganizationId(
            organizationAndTeamData.organizationId,
        );
        if (!entity?.rules) return counts;

        for (const r of entity.rules as any[]) {
            if (!repositoryIds.has(r?.repositoryId)) continue;
            if (!isAgentInstructionSource(r?.sourcePath)) continue;
            if (r?.status === KodyRulesStatus.ACTIVE) counts.active += 1;
            else if (r?.status === KodyRulesStatus.PAUSED) counts.paused += 1;
            else if (r?.status === KodyRulesStatus.DELETED) {
                counts.deleted += 1;
            }
        }
        return counts;
    }

    // ---------------------------------------------------------------------
    // Global rules synced from selected source repositories
    //
    // Rules imported here live under `repositoryId="global"` (the org-wide
    // scope) but are tagged with `origin=GLOBAL_REPO_FILE_SYNC` and
    // `sourceRepositoryId`, which is what separates them from user-authored
    // global rules and from rules imported during onboarding before it became
    // repository-scoped. `directoryId` is intentionally left undefined —
    // a source-repo directoryId would make the enforcement filter drop the
    // rule in every other repo's review.
    // ---------------------------------------------------------------------

    private readonly GLOBAL_SCOPE_ID = 'global';

    /** True for a global rule that this feature owns (safe to reconcile/purge). */
    private isGlobalSyncedRule(rule: any, sourceRepositoryId?: string): boolean {
        if (rule?.repositoryId !== this.GLOBAL_SCOPE_ID) return false;
        if (rule?.origin !== KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC) return false;
        if (
            sourceRepositoryId !== undefined &&
            rule?.sourceRepositoryId !== sourceRepositoryId
        ) {
            return false;
        }
        return true;
    }

    /** Count of ACTIVE global-synced rules in an already-loaded rules array. */
    private countActiveGlobalSyncedRulesIn(rules: any[]): number {
        return (rules ?? []).filter(
            (r) =>
                this.isGlobalSyncedRule(r) &&
                r?.status === KodyRulesStatus.ACTIVE,
        ).length;
    }

    /**
     * Count of ACTIVE global-synced rules across the whole org (every source
     * repo combined). This is the number the trial cap is measured against.
     * Loads the org's rules; callers that already hold the rules array (e.g. the
     * sync loop) should use `countActiveGlobalSyncedRulesIn` instead.
     */
    async countGlobalSyncedRules(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number> {
        const entity = await this.kodyRulesService.findByOrganizationId(
            organizationAndTeamData.organizationId,
        );
        return this.countActiveGlobalSyncedRulesIn(
            (entity?.rules ?? []) as any[],
        );
    }

    /**
     * Find an existing global-synced rule in an already-loaded rules array,
     * keyed by (source repository, source file path). The key includes
     * `sourceRepositoryId` so two source repos with the same file path (e.g.
     * both shipping a `CLAUDE.md`) don't collide in the shared `"global"` bucket.
     * Pure/in-memory so the sync loop can reuse a single org-rules load instead
     * of re-querying per file.
     */
    private selectGlobalRuleFromList(
        rules: any[],
        sourceRepositoryId: string,
        sourcePath: string,
    ): Partial<{
        uuid: string;
        status: KodyRulesStatus;
        lastContentHash: string;
    }> | null {
        const matches =
            (rules ?? []).filter(
                (r: any) =>
                    this.isGlobalSyncedRule(r, sourceRepositoryId) &&
                    (r?.sourcePath || '').split('#')[0] === sourcePath,
            ) ?? [];
        if (!matches.length) return null;

        const toTime = (value: unknown): number => {
            const t = new Date((value as any) ?? 0).getTime();
            return Number.isFinite(t) ? t : 0;
        };
        const newestFirst = [...matches].sort(
            (a: any, b: any) => toTime(b?.createdAt) - toTime(a?.createdAt),
        );
        const found =
            newestFirst.find(
                (r: any) => r?.status !== KodyRulesStatus.DELETED,
            ) ?? newestFirst[0];

        return found
            ? {
                  uuid: found.uuid,
                  status: found.status,
                  lastContentHash: (found as any).lastContentHash,
              }
            : null;
    }

    /**
     * Full scan of a source repository, importing every discovered rule file
     * into the global scope. Used both by the manual "resync global" action and
     * by the PR-merge trigger (the git-tree listing is a single cheap call and
     * the per-file SHA short-circuit skips unchanged files, so re-running on
     * every merged PR is acceptable).
     *
     * Reconciles deletions: any previously-synced global rule from this source
     * repo whose file no longer exists at HEAD is soft-deleted.
     */
    async syncRepositoryGlobal(params: SyncTarget): Promise<void> {
        const { organizationAndTeamData, repository } = params;
        try {
            // Plan gate. Free orgs can't import at all; trial orgs are capped at
            // GLOBAL_RULES_TRIAL_IMPORT_LIMIT rules TOTAL across every source
            // repo; paid/self-hosted are unlimited. Resolved here (not just in
            // the endpoint) so the PR-merge trigger and manual resync honour the
            // same cap. `budget` is the number of NEW rules still importable;
            // updates to already-imported rules never consume it.
            const tier =
                await this.permissionValidationService.resolveGlobalRulesImportTier(
                    organizationAndTeamData,
                    KodyRulesSyncService.name,
                );
            if (tier === 'free') {
                this.logger.log({
                    message:
                        '[kody-rules-global-sync] skipped: global rules import is not available on the Free plan',
                    context: KodyRulesSyncService.name,
                    metadata: {
                        organizationAndTeamData,
                        sourceRepositoryId: repository?.id,
                    },
                });
                return;
            }
            // Load the org's rules ONCE and reuse the array for the budget
            // count, every per-file lookup, and the deletion reconciliation.
            // The rules array only grows by distinct source paths during this
            // run (each handled once), so an in-memory snapshot stays correct
            // for lookups; reconciliation is driven by `seenSourcePaths`, not by
            // whether a just-created rule is in the snapshot.
            const orgRules = ((
                await this.kodyRulesService.findByOrganizationId(
                    organizationAndTeamData.organizationId,
                )
            )?.rules ?? []) as any[];

            const importLimit =
                tier === 'trial' ? GLOBAL_RULES_TRIAL_IMPORT_LIMIT : null;
            let budget =
                importLimit === null
                    ? Number.POSITIVE_INFINITY
                    : Math.max(
                          0,
                          importLimit -
                              this.countActiveGlobalSyncedRulesIn(orgRules),
                      );

            const branch = await this.codeManagementService.getDefaultBranch({
                organizationAndTeamData,
                repository,
            });

            const allFiles = await this.listKodyRuleFiles({
                organizationAndTeamData,
                repository,
                branch,
            });

            const seenSourcePaths = new Set<string>();
            const syncOutcome = {
                imported: [] as string[],
                unchanged: [] as string[],
                skipped: [] as Array<{ file: string; reason: string }>,
                removed: [] as string[],
                limitReached: [] as string[],
            };

            for (const file of allFiles) {
                seenSourcePaths.add(file.path);

                const existing = this.selectGlobalRuleFromList(
                    orgRules,
                    repository.id,
                    file.path,
                );

                // SHA short-circuit: unchanged file with a live rule → skip the
                // content download + LLM conversion entirely.
                const currentSha = (file as any)?.sha as string | undefined;
                if (
                    existing &&
                    existing.status !== KodyRulesStatus.DELETED &&
                    currentSha &&
                    existing.lastContentHash === currentSha
                ) {
                    syncOutcome.unchanged.push(file.path);
                    continue;
                }

                const contentResp =
                    await this.codeManagementService.getRepositoryContentFile({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        file: { filename: file.path },
                        pullRequest: {
                            head: { ref: branch },
                            base: { ref: branch },
                        },
                    });

                const rawContent = contentResp?.data?.content;
                if (!rawContent) {
                    syncOutcome.skipped.push({
                        file: file.path,
                        reason: 'empty or unfetchable content',
                    });
                    continue;
                }

                const decoded =
                    contentResp?.data?.encoding === 'base64'
                        ? Buffer.from(rawContent, 'base64').toString('utf-8')
                        : rawContent;

                // @kody-ignore still applies: remove any existing global rule
                // for this file.
                if (this.shouldIgnoreFile(decoded)) {
                    if (existing?.uuid) {
                        const deleted = await this.deleteGlobalRuleByUuid({
                            organizationAndTeamData,
                            uuid: existing.uuid,
                        });
                        if (deleted) syncOutcome.removed.push(file.path);
                    }
                    continue;
                }

                const converted = await this.templateFileToRule({
                    filePath: file.path,
                    repositoryId: this.GLOBAL_SCOPE_ID,
                    content: decoded,
                    organizationAndTeamData,
                });

                if (converted.kind === 'skipped') {
                    syncOutcome.skipped.push({
                        file: file.path,
                        reason: converted.reason,
                    });
                    continue;
                }
                const oneRule = converted.rule;

                // Trial cap. A NEW rule (nothing imported for this file yet, or
                // a soft-deleted/rejected one being revived) counts against the
                // budget; re-importing changed content over an ACTIVE rule does
                // not. Once the budget is spent, further NEW rules are skipped —
                // this is what "import only the first N rules found" enforces,
                // in git-tree order, across every source repo combined.
                const consumesBudget =
                    !existing?.uuid ||
                    existing.status !== KodyRulesStatus.ACTIVE;
                if (consumesBudget && budget <= 0) {
                    syncOutcome.limitReached.push(file.path);
                    continue;
                }

                const dto: CreateKodyRuleDto = {
                    uuid: existing?.uuid,
                    title: oneRule.title as string,
                    rule: oneRule.rule as string,
                    path: validateAndScopeIdeRulePath({
                        llmPath: oneRule.path as string,
                        sourceFilePath: file.path,
                        pathSource: (oneRule as any)?.pathSource,
                    }).path,
                    sourcePath: file.path,
                    severity:
                        ((
                            oneRule.severity as any
                        )?.toLowerCase?.() as KodyRuleSeverity) ||
                        KodyRuleSeverity.MEDIUM,
                    // Global scope: the org-wide bucket, no source directoryId
                    // (see the note above this section).
                    repositoryId: this.GLOBAL_SCOPE_ID,
                    sourceRepositoryId: repository.id,
                    lastContentHash: currentSha,
                    origin: KodyRulesOrigin.GLOBAL_REPO_FILE_SYNC,
                    status: oneRule.status as any,
                    scope:
                        (oneRule.scope as KodyRulesScope) ||
                        KodyRulesScope.FILE,
                    examples: Array.isArray(oneRule.examples)
                        ? (oneRule.examples as any)
                        : [],
                } as CreateKodyRuleDto;

                // Re-syncing changed content over a previously REJECTED rule
                // reactivates it (mirrors the per-repo force-sync behaviour):
                // selecting the repo as a global source IS the source-of-truth
                // signal, so a stale UI rejection must not block re-import.
                if (existing?.status === KodyRulesStatus.REJECTED) {
                    (dto as any).status = KodyRulesStatus.ACTIVE;
                }

                await this.kodyRulesService.createOrUpdate(
                    organizationAndTeamData,
                    dto,
                    this.systemUserInfo,
                );

                if (consumesBudget) {
                    budget -= 1;
                }
                syncOutcome.imported.push(file.path);
            }

            // Deletion reconciliation: soft-delete global rules from this source
            // repo whose file no longer exists at HEAD. Reuses the snapshot
            // loaded at the top — a rule created during this run is never a
            // deletion candidate (its path is in `seenSourcePaths`), so the
            // snapshot missing it is harmless.
            for (const rule of orgRules) {
                if (!this.isGlobalSyncedRule(rule, repository.id)) continue;
                if (rule?.status === KodyRulesStatus.DELETED) continue;
                const sp = (rule?.sourcePath || '').split('#')[0];
                // Rules from coding-agent files are frozen: they are no longer
                // discovered, which must not read as "file deleted".
                if (isAgentInstructionSource(sp)) continue;
                if (sp && !seenSourcePaths.has(sp) && rule?.uuid) {
                    const deleted = await this.deleteGlobalRuleByUuid({
                        organizationAndTeamData,
                        uuid: rule.uuid,
                    });
                    if (deleted) syncOutcome.removed.push(sp);
                }
            }

            this.logger.log({
                message: `[kody-rules-global-sync] summary: ${syncOutcome.imported.length} imported, ${syncOutcome.unchanged.length} unchanged, ${syncOutcome.skipped.length} skipped, ${syncOutcome.removed.length} removed, ${syncOutcome.limitReached.length} over ${tier} limit (of ${allFiles.length} candidate file(s))`,
                context: KodyRulesSyncService.name,
                metadata: {
                    organizationAndTeamData,
                    sourceRepositoryId: repository.id,
                    branch,
                    tier,
                    importLimit,
                    ...syncOutcome,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to sync global rules from source repository',
                context: KodyRulesSyncService.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    sourceRepositoryId: repository?.id,
                },
            });
        }
    }

    /** A stale sync snapshot may contain a rule deleted by another operation. */
    private async deleteSyncedRuleIfPresent(
        organizationAndTeamData: OrganizationAndTeamData,
        uuid: string,
    ): Promise<boolean> {
        if (!organizationAndTeamData.organizationId) {
            throw new NotFoundException('Organization not found');
        }
        try {
            const result =
                await this.deleteRuleInOrganizationByIdKodyRulesUseCase.execute(
                    uuid,
                    {
                        source: 'web',
                        organizationId: organizationAndTeamData.organizationId,
                        teamId: organizationAndTeamData.teamId,
                        userId: this.systemUserInfo.userId,
                        userEmail: this.systemUserInfo.userEmail,
                    },
                );
            return result !== false;
        } catch (error) {
            // Only a rule that is already gone is skipped; a team outside the
            // organization (also a NotFoundException) must still surface.
            if (
                error instanceof NotFoundException &&
                error.message === 'Rule not found'
            ) {
                return false;
            }
            throw error;
        }
    }

    /** Soft-delete a single global-synced rule via the centralized-aware path. */
    private deleteGlobalRuleByUuid(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        uuid: string;
    }): Promise<boolean> {
        return this.deleteSyncedRuleIfPresent(
            params.organizationAndTeamData,
            params.uuid,
        );
    }

    /**
     * Soft-delete every global rule imported from a given source repository.
     * Called when the user removes that repo from the global-rules source list.
     *
     * CRITICAL: scoped by `origin=GLOBAL_REPO_FILE_SYNC` + `sourceRepositoryId`
     * (via `isGlobalSyncedRule`) so it never touches user-authored global rules
     * or another source repo's rules that share the `"global"` bucket.
     */
    async purgeGlobalRulesForSourceRepository(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        sourceRepositoryId: string;
    }): Promise<number> {
        const { organizationAndTeamData, sourceRepositoryId } = params;
        try {
            const entity = await this.kodyRulesService.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );
            if (!entity?.rules) return 0;

            let removed = 0;
            for (const rule of entity.rules as any[]) {
                if (!this.isGlobalSyncedRule(rule, sourceRepositoryId)) continue;
                if (rule?.status === KodyRulesStatus.DELETED) continue;
                if (!rule?.uuid) continue;
                const deleted = await this.deleteGlobalRuleByUuid({
                    organizationAndTeamData,
                    uuid: rule.uuid,
                });
                if (deleted) removed += 1;
            }

            this.logger.log({
                message: `[kody-rules-global-sync] purged ${removed} global rule(s) for removed source repository`,
                context: KodyRulesSyncService.name,
                metadata: { organizationAndTeamData, sourceRepositoryId },
            });
            return removed;
        } catch (error) {
            this.logger.error({
                message: 'Failed to purge global rules for source repository',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
            return 0;
        }
    }
}
