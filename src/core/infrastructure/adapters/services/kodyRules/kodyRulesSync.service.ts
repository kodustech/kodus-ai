import { Inject, Injectable } from '@nestjs/common';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { RULE_FILE_PATTERNS } from '@/shared/utils/kody-rules/file-patterns';
import { isFileMatchingGlob } from '@/shared/utils/glob-utils';
import {
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import {
    CreateKodyRuleDto,
    KodyRuleSeverity,
} from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import {
    PromptRunnerService,
    ParserType,
    PromptRole,
    LLMModelProvider,
} from '@kodus/kodus-common/llm';
import { UpdateOrCreateCodeReviewParameterUseCase } from '@/core/application/use-cases/parameters/update-or-create-code-review-parameter-use-case';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import * as path from 'path';
import { ObservabilityService } from '../logger/observability.service';
import { PermissionValidationService } from '@/ee/shared/services/permissionValidation.service';
import { BYOKPromptRunnerService } from '@/shared/infrastructure/services/tokenTracking/byokPromptRunner.service';
import {
    kodyRulesIDEGeneratorSchema,
    kodyRulesIDEGeneratorSchemaOnboarding,
    kodyRulesManifestGeneratorSchemaOnboarding,
} from '@/shared/utils/langchainCommon/prompts/kodyRules';
import {
    ContextDetectionField,
    ContextReferenceDetectionService,
} from '@/core/infrastructure/adapters/services/context/context-reference-detection.service';
import { PromptSourceType } from '@/core/domain/prompts/interfaces/promptExternalReference.interface';
import {
    GET_ADDITIONAL_INFO_HELPER_TOKEN,
    IGetAdditionalInfoHelper,
} from '@/shared/domain/contracts/getAdditionalInfo.helper.contract';
import type { UserInfo } from '@/config/types/general/codeReviewSettingsLog.type';

const MANIFEST_FILE_PATTERNS = [
    // JavaScript/TypeScript
    'package.json',
    'pnpm-workspace.yaml',
    'pnpm-lock.yaml',
    'yarn.lock',
    'package-lock.json',

    // Python
    'requirements.txt',
    'pyproject.toml',
    'poetry.lock',
    'Pipfile',
    'Pipfile.lock',

    // Go / Rust
    'go.mod',
    'Cargo.toml',

    // Java / Kotlin (Gradle/Maven)
    'pom.xml',
    'build.gradle',
    'build.gradle.kts',
    'settings.gradle',
    'settings.gradle.kts',
    'gradle.lockfile',
    'gradle/libs.versions.toml',

    // .NET
    '**/*.csproj',
    '**/*.fsproj',
    'packages.config',
    'Directory.Packages.props',
    'global.json',

    // Ruby
    'Gemfile',
    'Gemfile.lock',
    '**/*.gemspec',

    // Elixir
    'mix.exs',
    'mix.lock',
] as const;

type SyncTarget = {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: {
        id: string;
        name: string;
        fullName?: string;
        defaultBranch?: string;
    };
};

@Injectable()
export class KodyRulesSyncService {
    private readonly systemUserInfo: UserInfo = {
        userId: 'kody-rules-sync',
        userEmail: 'kody@kodus.io',
    };

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
        private readonly updateOrCreateCodeReviewParameterUseCase: UpdateOrCreateCodeReviewParameterUseCase,
        private readonly promptRunnerService: PromptRunnerService,
        private readonly permissionValidationService: PermissionValidationService,
        private readonly observabilityService: ObservabilityService,
        private readonly contextReferenceDetectionService: ContextReferenceDetectionService,
        @Inject(GET_ADDITIONAL_INFO_HELPER_TOKEN)
        private readonly getAdditionalInfoHelper: IGetAdditionalInfoHelper,
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
    }): Promise<Partial<{ uuid: string }> | null> {
        try {
            const { organizationAndTeamData, repositoryId, sourcePath } =
                params;
            const existing = await this.kodyRulesService.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );
            const found = existing?.rules?.find(
                (r) =>
                    r?.repositoryId === repositoryId &&
                    r?.sourcePath === sourcePath,
            );
            return found ? { uuid: found.uuid } : null;
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

    private async deleteRuleBySourcePath(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        repositoryId: string;
        sourcePath: string;
    }): Promise<void> {
        try {
            const { organizationAndTeamData, repositoryId, sourcePath } =
                params;
            const entity = await this.kodyRulesService.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );
            if (!entity) return;

            const toDelete = entity.rules?.find(
                (r) =>
                    r?.repositoryId === repositoryId &&
                    (r?.sourcePath || '').split('#')[0] === sourcePath,
            );
            if (!toDelete?.uuid) return;

            await this.kodyRulesService.deleteRuleLogically(
                entity.uuid,
                toDelete.uuid,
            );
        } catch (error) {
            this.logger.error({
                message: 'Failed to delete rule by sourcePath',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
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
            const syncEnabled = await this.isIdeRulesSyncEnabled(
                organizationAndTeamData,
                repository.id,
            );

            // If the sync is disabled, we need to force sync the files that have @kody-sync
            let forceSyncFiles: string[] = [];
            if (!syncEnabled) {
                // First, we need to check which files can be rule files
                const directoryPatterns = await this.getDirectoryPatterns(
                    organizationAndTeamData,
                    repository.id,
                );
                const patterns = [...RULE_FILE_PATTERNS, ...directoryPatterns];
                const isRuleFile = (fp?: string) =>
                    !!fp && isFileMatchingGlob(fp, patterns);

                const ruleChanges = files.filter(
                    (f) =>
                        isRuleFile(f.filename) ||
                        isRuleFile(f.previous_filename),
                );

                // Get the PR details once
                const prDetails =
                    await this.codeManagementService.getPullRequestByNumber({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        prNumber: pullRequestNumber,
                    });

                const { head, base } =
                    this.extractRefsFromPullRequest(prDetails);
                const pullRequestParam: any = {
                    number: pullRequestNumber,
                    head: head ? { ref: head } : undefined,
                    base: base ? { ref: base } : undefined,
                };

                // Now we need to check which files have @kody-sync in the content
                for (const f of ruleChanges) {
                    if (f.status === 'removed') continue;

                    const content = await this.getFileContent({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        filename: f.filename,
                        pullRequest: pullRequestParam,
                    });

                    if (content && this.shouldForceSync(content)) {
                        forceSyncFiles.push(f.filename);
                        this.logger.log({
                            message:
                                'File marked for force sync with @kody-sync',
                            context: KodyRulesSyncService.name,
                            metadata: {
                                filename: f.filename,
                                repositoryId: repository.id,
                                organizationAndTeamData,
                            },
                        });
                    }
                }

                if (forceSyncFiles.length === 0) {
                    this.logger.log({
                        message:
                            'IDE rules sync disabled and no files marked with @kody-sync',
                        context: KodyRulesSyncService.name,
                        metadata: {
                            repositoryId: repository.id,
                            organizationAndTeamData,
                        },
                    });
                    return;
                }

                this.logger.log({
                    message: `Found ${forceSyncFiles.length} files marked for force sync`,
                    context: KodyRulesSyncService.name,
                    metadata: {
                        repositoryId: repository.id,
                        organizationAndTeamData,
                        forceSyncFiles,
                    },
                });
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

            const directoryPatterns = await this.getDirectoryPatterns(
                organizationAndTeamData,
                repository.id,
            );

            const patterns = [...RULE_FILE_PATTERNS, ...directoryPatterns];
            const isRuleFile = (fp?: string) =>
                !!fp && isFileMatchingGlob(fp, patterns);

            let ruleChanges = files.filter(
                (f) =>
                    isRuleFile(f.filename) || isRuleFile(f.previous_filename),
            );

            // Se o sync não estiver habilitado, filtrar apenas os arquivos marcados para force sync
            if (!syncEnabled && forceSyncFiles.length > 0) {
                ruleChanges = ruleChanges.filter((f) =>
                    forceSyncFiles.includes(f.filename),
                );
            }

            if (!ruleChanges.length) {
                return;
            }

            for (const f of ruleChanges) {
                if (f.status === 'removed') {
                    // Delete rule corresponding to removed file
                    await this.deleteRuleBySourcePath({
                        organizationAndTeamData,
                        repositoryId: repository.id,
                        sourcePath: f.filename,
                    });
                    continue;
                }

                const sourcePathLookup =
                    f.status === 'renamed' && f.previous_filename
                        ? f.previous_filename
                        : f.filename;

                const contentResp =
                    await this.codeManagementService.getRepositoryContentFile({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        file: { filename: f.filename },
                        pullRequest: pullRequestParam,
                    });
                // Fallbacks if the source branch was deleted on merge (e.g., GitLab):
                // 1) Try with base as head
                // 2) Try with default branch as head
                let effectiveContent = contentResp;
                if (!effectiveContent?.data?.content) {
                    const baseRef = pullRequestParam.base?.ref;
                    if (baseRef) {
                        try {
                            const baseAsHead =
                                await this.codeManagementService.getRepositoryContentFile(
                                    {
                                        organizationAndTeamData,
                                        repository: {
                                            id: repository.id,
                                            name: repository.name,
                                        },
                                        file: { filename: f.filename },
                                        pullRequest: { head: { ref: baseRef } },
                                    },
                                );
                            if (baseAsHead?.data?.content) {
                                effectiveContent = baseAsHead;
                            }
                        } catch {}
                    }
                }
                if (!effectiveContent?.data?.content) {
                    try {
                        const defaultBranch =
                            await this.codeManagementService.getDefaultBranch({
                                organizationAndTeamData,
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                            });
                        if (defaultBranch) {
                            const defAsHead =
                                await this.codeManagementService.getRepositoryContentFile(
                                    {
                                        organizationAndTeamData,
                                        repository: {
                                            id: repository.id,
                                            name: repository.name,
                                        },
                                        file: { filename: f.filename },
                                        pullRequest: {
                                            head: { ref: defaultBranch },
                                        },
                                    },
                                );
                            if (defAsHead?.data?.content) {
                                effectiveContent = defAsHead;
                            }
                        }
                    } catch {}
                }

                const rawContent = effectiveContent?.data?.content;
                if (!rawContent) {
                    continue;
                }

                const decoded =
                    contentResp?.data?.encoding === 'base64'
                        ? Buffer.from(rawContent, 'base64').toString('utf-8')
                        : rawContent;

                //Verify if the file should be ignored due to the @kody-ignore marker
                if (this.shouldIgnoreFile(decoded)) {
                    this.logger.log({
                        message:
                            'File ignored due to @kody-ignore marker - removing existing rules',
                        context: KodyRulesSyncService.name,
                        metadata: {
                            file: f.filename,
                            repositoryId: repository.id,
                            pullRequestNumber,
                            organizationAndTeamData,
                        },
                    });

                    // Remove existing rules for this file
                    await this.deleteRuleBySourcePath({
                        organizationAndTeamData,
                        repositoryId: repository.id,
                        sourcePath: f.filename,
                    });
                    continue;
                }

                const rules = await this.convertFileToKodyRules({
                    filePath: f.filename,
                    repositoryId: repository.id,
                    content: decoded,
                    organizationAndTeamData,
                });

                if (!Array.isArray(rules) || rules.length === 0) {
                    this.logger.warn({
                        message: 'No rules parsed from changed file',
                        context: KodyRulesSyncService.name,
                        metadata: { file: f.filename },
                    });
                    continue;
                }

                const oneRule = rules.find(
                    (r) => r && typeof r === 'object' && r.title && r.rule,
                );

                if (!oneRule) continue;

                const existing = sourcePathLookup
                    ? await this.findRuleBySourcePath({
                          organizationAndTeamData,
                          repositoryId: repository.id,
                          sourcePath: sourcePathLookup,
                      })
                    : null;

                const dto: CreateKodyRuleDto = {
                    uuid: existing?.uuid,
                    title: oneRule.title as string,
                    rule: oneRule.rule as string,
                    path: (oneRule.path as string) ?? f.filename,
                    sourcePath: f.filename,
                    severity:
                        ((
                            oneRule.severity as any
                        )?.toLowerCase?.() as KodyRuleSeverity) ||
                        KodyRuleSeverity.MEDIUM,
                    repositoryId: repository.id,
                    // If the rule file is inside a configured directory (monorepo folder), attach directoryId
                    directoryId: (
                        await this.resolveDirectoryForFile({
                            organizationAndTeamData,
                            repositoryId: repository.id,
                            filePath: f.filename,
                        })
                    )?.id,
                    origin: KodyRulesOrigin.USER,
                    status: oneRule.status as any,
                    scope:
                        (oneRule.scope as KodyRulesScope) ||
                        KodyRulesScope.FILE,
                    examples: Array.isArray(oneRule.examples)
                        ? (oneRule.examples as any)
                        : [],
                } as CreateKodyRuleDto;

                const result = await this.kodyRulesService.createOrUpdate(
                    organizationAndTeamData,
                    dto,
                    this.systemUserInfo,
                );

                await this.processContextReferences({
                    ruleId: this.getRuleId(result),
                    ruleText: dto.rule,
                    repositoryId: dto.repositoryId,
                    organizationAndTeamData,
                });

                try {
                    await this.updateOrCreateCodeReviewParameterUseCase.execute(
                        {
                            organizationAndTeamData,
                            configValue: {
                                kodyRules: [],
                            } as any,
                            repositoryId: repository.id,
                        },
                    );
                } catch (paramError) {
                    this.logger.error({
                        message:
                            'Failed to ensure CODE_REVIEW_CONFIG after rule sync (PR files)',
                        context: KodyRulesSyncService.name,
                        error: paramError,
                        metadata: {
                            repositoryId: repository.id,
                            file: f.filename,
                        },
                    });
                }
            }
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
        const { organizationAndTeamData, repository } = params;
        try {
            const syncEnabled = await this.isIdeRulesSyncEnabled(
                organizationAndTeamData,
                repository.id,
            );

            const branch = await this.codeManagementService.getDefaultBranch({
                organizationAndTeamData,
                repository,
            });

            const directoryPatterns = await this.getDirectoryPatterns(
                organizationAndTeamData,
                repository.id,
            );

            const patterns = [...RULE_FILE_PATTERNS, ...directoryPatterns];

            // List only rule files
            const allFiles =
                await this.codeManagementService.getRepositoryAllFiles({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    filters: {
                        branch,
                        filePatterns: patterns,
                    },
                });

            // Se o sync não estiver habilitado, verificar quais arquivos têm @kody-sync
            let filesToSync = allFiles;
            if (!syncEnabled) {
                const forceSyncFiles: string[] = [];

                for (const file of allFiles) {
                    const content = await this.getFileContent({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        filename: file.path,
                        branch,
                    });

                    if (content && this.shouldForceSync(content)) {
                        forceSyncFiles.push(file.path);
                        this.logger.log({
                            message:
                                'File marked for force sync with @kody-sync',
                            context: KodyRulesSyncService.name,
                            metadata: {
                                filename: file.path,
                                repositoryId: repository.id,
                                organizationAndTeamData,
                            },
                        });
                    }
                }

                if (forceSyncFiles.length === 0) {
                    this.logger.log({
                        message:
                            'IDE rules sync disabled and no files marked with @kody-sync',
                        context: KodyRulesSyncService.name,
                        metadata: {
                            repositoryId: repository.id,
                            organizationAndTeamData,
                        },
                    });
                    return;
                }

                filesToSync = allFiles.filter((file) =>
                    forceSyncFiles.includes(file.path),
                );

                this.logger.log({
                    message: `Found ${forceSyncFiles.length} files marked for force sync`,
                    context: KodyRulesSyncService.name,
                    metadata: {
                        repositoryId: repository.id,
                        organizationAndTeamData,
                        forceSyncFiles,
                    },
                });
            }

            for (const file of filesToSync) {
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
                if (!rawContent) continue;

                const decoded =
                    contentResp?.data?.encoding === 'base64'
                        ? Buffer.from(rawContent, 'base64').toString('utf-8')
                        : rawContent;

                // Verify if the file should be ignored due to the @kody-ignore marker
                if (this.shouldIgnoreFile(decoded)) {
                    this.logger.log({
                        message:
                            'File ignored due to @kody-ignore marker - removing existing rules',
                        context: KodyRulesSyncService.name,
                        metadata: {
                            file: file.path,
                            repositoryId: repository.id,
                            syncType: 'main',
                            organizationAndTeamData,
                        },
                    });

                    // Remove existing rules for this file
                    await this.deleteRuleBySourcePath({
                        organizationAndTeamData,
                        repositoryId: repository.id,
                        sourcePath: file.path,
                    });
                    continue;
                }

                const rules = await this.convertFileToKodyRules({
                    filePath: file.path,
                    repositoryId: repository.id,
                    content: decoded,
                    organizationAndTeamData,
                });

                const oneRule = rules?.find(
                    (r) => r && typeof r === 'object' && r.title && r.rule,
                );

                if (!oneRule) {
                    continue;
                }

                const existing = await this.findRuleBySourcePath({
                    organizationAndTeamData,
                    repositoryId: repository.id,
                    sourcePath: file.path,
                });

                const dto: CreateKodyRuleDto = {
                    uuid: existing?.uuid,
                    title: oneRule.title as string,
                    rule: oneRule.rule as string,
                    path: (oneRule.path as string) ?? file.path,
                    sourcePath: file.path,
                    severity:
                        ((
                            oneRule.severity as any
                        )?.toLowerCase?.() as KodyRuleSeverity) ||
                        KodyRuleSeverity.MEDIUM,
                    repositoryId: repository.id,
                    directoryId: (
                        await this.resolveDirectoryForFile({
                            organizationAndTeamData,
                            repositoryId: repository.id,
                            filePath: file.path,
                        })
                    )?.id,
                    origin: KodyRulesOrigin.USER,
                    status: oneRule.status as any,
                    scope:
                        (oneRule.scope as KodyRulesScope) ||
                        KodyRulesScope.FILE,
                    examples: Array.isArray(oneRule.examples)
                        ? (oneRule.examples as any)
                        : [],
                } as CreateKodyRuleDto;

                const result = await this.kodyRulesService.createOrUpdate(
                    organizationAndTeamData,
                    dto,
                    this.systemUserInfo,
                );

                await this.processContextReferences({
                    ruleId: this.getRuleId(result),
                    ruleText: dto.rule,
                    repositoryId: dto.repositoryId,
                    organizationAndTeamData,
                });

                try {
                    await this.updateOrCreateCodeReviewParameterUseCase.execute(
                        {
                            organizationAndTeamData,
                            configValue: {
                                kodyRules: [],
                            } as any,
                            repositoryId: repository.id,
                        },
                    );
                } catch (paramError) {
                    this.logger.error({
                        message:
                            'Failed to ensure CODE_REVIEW_CONFIG after rule sync (main)',
                        context: KodyRulesSyncService.name,
                        error: paramError,
                        metadata: {
                            repositoryId: repository.id,
                            file: file.path,
                        },
                    });
                }
            }
        } catch (error) {
            this.logger.error({
                message: 'Failed to sync Kody Rules from main',
                context: KodyRulesSyncService.name,
                error,
                metadata: params,
            });
        }
    }

    /**
     * Fast, non-persisting sync used for onboarding.
     * - Scans only known rule patterns (same list as full sync)
     * - Uses Groq (OpenAI-compatible) via the existing PromptRunner/BYOK wrapper
     * - Persists parsed rules as global (repositoryId = "global") for onboarding review
     */
    async syncRepositoryMainFast(
        params: SyncTarget & {
            maxFiles?: number;
            maxFileSizeBytes?: number;
            maxTotalBytes?: number;
            maxConcurrent?: number;
        },
    ): Promise<{
        rules: Array<Partial<CreateKodyRuleDto>>;
        skippedFiles: Array<{ file: string; reason: string }>;
        errors: Array<{ file?: string; message: string }>;
    }> {
        const { organizationAndTeamData, repository } = params;
        const targetRepositoryId = 'global';
        const response = {
            rules: [] as Array<Partial<CreateKodyRuleDto>>,
            skippedFiles: [] as Array<{ file: string; reason: string }>,
            errors: [] as Array<{ file?: string; message: string }>,
        };

        const maxFiles = params.maxFiles ?? 20;
        const maxFileSizeBytes = params.maxFileSizeBytes ?? 200_000; // ~200KB
        const maxTotalBytes = params.maxTotalBytes ?? 2_000_000; // ~2MB aggregate
        const maxConcurrent = Math.max(
            1,
            Math.min(params.maxConcurrent ?? 5, 10),
        );

        try {
            const branch = await this.codeManagementService.getDefaultBranch({
                organizationAndTeamData,
                repository,
            });

            const directoryPatterns = await this.getDirectoryPatterns(
                organizationAndTeamData,
                repository.id,
            );
            const patterns = [...RULE_FILE_PATTERNS, ...directoryPatterns];

            const allFiles =
                await this.codeManagementService.getRepositoryAllFiles({
                    organizationAndTeamData,
                    repository: { id: repository.id, name: repository.name },
                    filters: {
                        branch,
                        filePatterns: patterns,
                    },
                });

            const processFilesConcurrently = async (
                files: { path: string; size: number }[],
                allowDirectoryResolution = true,
            ) => {
                let processed = 0;
                let totalBytes = 0;
                const localCandidates: Array<{
                    path: string;
                    content: string;
                    directoryId?: string;
                }> = [];

                // Pré-filtra por metadata (tamanho e cap agregado) sem baixar conteúdo
                const metadataFiltered: Array<{ path: string; size: number }> =
                    [];
                for (const file of files) {
                    if (processed >= maxFiles) {
                        response.skippedFiles.push({
                            file: file.path,
                            reason: 'max files cap reached',
                        });
                        continue;
                    }

                    const size =
                        typeof (file as any)?.size === 'number' &&
                        (file as any)?.size >= 0
                            ? (file as any).size
                            : 0;

                    if (size > maxFileSizeBytes) {
                        response.skippedFiles.push({
                            file: file.path,
                            reason: 'file too large (metadata)',
                        });
                        continue;
                    }

                    if (totalBytes + size > maxTotalBytes) {
                        response.skippedFiles.push({
                            file: file.path,
                            reason: 'max aggregate size reached',
                        });
                        continue;
                    }

                    metadataFiltered.push({ path: file.path, size });
                    processed += 1;
                    totalBytes += size;
                }

                if (!metadataFiltered.length) {
                    return localCandidates;
                }

                let index = 0;
                const worker = async () => {
                    while (true) {
                        const currentIndex = index++;
                        if (currentIndex >= metadataFiltered.length) break;
                        const file = metadataFiltered[currentIndex];

                        try {
                            const content = await this.getFileContent({
                                organizationAndTeamData,
                                repository: {
                                    id: repository.id,
                                    name: repository.name,
                                },
                                filename: file.path,
                                branch,
                            });

                            if (!content) {
                                response.skippedFiles.push({
                                    file: file.path,
                                    reason: 'empty content',
                                });
                                continue;
                            }

                            if (content.length > maxFileSizeBytes) {
                                response.skippedFiles.push({
                                    file: file.path,
                                    reason: 'file too large',
                                });
                                continue;
                            }

                            if (this.shouldIgnoreFile(content)) {
                                response.skippedFiles.push({
                                    file: file.path,
                                    reason: 'ignored via @kody-ignore',
                                });
                                continue;
                            }

                            const directoryId = allowDirectoryResolution
                                ? (
                                      await this.resolveDirectoryForFile({
                                          organizationAndTeamData,
                                          repositoryId: repository.id,
                                          filePath: file.path,
                                      })
                                  )?.id
                                : undefined;

                            if (allowDirectoryResolution) {
                                directoryByPath[file.path] = directoryId;
                            }

                            localCandidates.push({
                                path: file.path,
                                content,
                                directoryId,
                            });
                        } catch (error) {
                            response.errors.push({
                                file: file.path,
                                message: error?.message || 'unexpected error',
                            });
                        }
                    }
                };

                const workers = Array.from(
                    {
                        length: Math.min(
                            maxConcurrent,
                            metadataFiltered.length,
                        ),
                    },
                    () => worker(),
                );
                await Promise.all(workers);

                return localCandidates;
            };

            let manifestMode = false;
            const directoryByPath: Record<string, string | undefined> = {};

            let candidates = await processFilesConcurrently(
                allFiles.map((f: any) => ({
                    path: f.path,
                    size:
                        typeof f?.size === 'number' && f.size >= 0 ? f.size : 0,
                })),
                true,
            );

            // Fallback: if there are less than 5 rule files, try common manifests (package.json, requirements.txt, etc.)
            if (!candidates.length || candidates?.length <= 5) {
                const manifestFiles =
                    await this.codeManagementService.getRepositoryAllFiles({
                        organizationAndTeamData,
                        repository: {
                            id: repository.id,
                            name: repository.name,
                        },
                        filters: {
                            branch,
                            filePatterns: [...MANIFEST_FILE_PATTERNS],
                            maxFiles,
                        },
                    });

                const manifestCandidates = await processFilesConcurrently(
                    manifestFiles.map((f: any) => ({
                        path: f.path,
                        size:
                            typeof f?.size === 'number' && f.size >= 0
                                ? f.size
                                : 0,
                    })),
                    false,
                );

                if (manifestCandidates.length) {
                    candidates = manifestCandidates;
                    manifestMode = true;
                }
            }

            if (!candidates.length) {
                return response;
            }

            const rules = manifestMode
                ? await this.convertManifestsToKodyRulesFastBatch({
                      files: candidates,
                      repositoryId: repository.id,
                      organizationAndTeamData,
                  })
                : await this.convertFilesToKodyRulesFastBatch({
                      files: candidates,
                      repositoryId: repository.id,
                      organizationAndTeamData,
                  });

            if (Array.isArray(rules)) {
                for (const rule of rules) {
                    if (!rule?.title || !rule?.rule) continue;

                    const sourcePath =
                        (rule.sourcePath as string) ||
                        (rule.path as string) ||
                        '';
                    const directoryId =
                        sourcePath && directoryByPath[sourcePath]
                            ? directoryByPath[sourcePath]
                            : undefined;

                    const dto: CreateKodyRuleDto = {
                        title: rule.title as string,
                        rule: rule.rule as string,
                        path: (rule.path as string) || sourcePath,
                        sourcePath: sourcePath,
                        repositoryId: targetRepositoryId,
                        directoryId,
                        severity:
                            ((
                                rule.severity as any
                            )?.toLowerCase?.() as KodyRuleSeverity) ||
                            KodyRuleSeverity.MEDIUM,
                        scope:
                            (rule.scope as KodyRulesScope) ||
                            KodyRulesScope.FILE,
                        origin: KodyRulesOrigin.USER,
                        status: (rule.status as any) || KodyRulesStatus.PENDING,
                        examples: Array.isArray(rule.examples)
                            ? (rule.examples as any)
                            : [],
                    };

                    try {
                        const created =
                            await this.kodyRulesService.createOrUpdate(
                                organizationAndTeamData,
                                dto,
                                this.systemUserInfo,
                            );
                        response.rules.push(created as any);
                    } catch (err) {
                        response.errors.push({
                            file: sourcePath,
                            message: err?.message || 'failed to save rule',
                        });
                    }
                }
            } else {
                response.errors.push({
                    message: 'Failed to parse rules from batch',
                });
            }
        } catch (error) {
            response.errors.push({
                message:
                    error instanceof Error ? error.message : 'unexpected error',
            });
        }

        return response;
    }

    private async isIdeRulesSyncEnabled(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
    ): Promise<boolean> {
        try {
            const cfg = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            // Must have repository context and repository-specific config
            if (!repositoryId || !cfg?.configValue?.repositories) {
                return false;
            }

            const repoConfig = cfg.configValue.repositories.find(
                (repo: any) =>
                    repo.id === repositoryId ||
                    repo.id === repositoryId.toString(),
            );

            return repoConfig?.configs.ideRulesSyncEnabled === true;
        } catch {
            return false;
        }
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

    private async convertFileToKodyRules(
        params: {
            filePath: string;
            repositoryId: string;
            content: string;
            organizationAndTeamData: OrganizationAndTeamData;
        },
        options?: {
            mainProvider?: LLMModelProvider;
            fallbackProvider?: LLMModelProvider;
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

        const byokConfigValue =
            await this.permissionValidationService.getBYOKConfig(
                params.organizationAndTeamData,
            );

        const mainProvider =
            options?.mainProvider ?? LLMModelProvider.GEMINI_2_5_FLASH;
        const mainFallback =
            options?.fallbackProvider ?? LLMModelProvider.GEMINI_2_5_PRO;
        const mainRun = options?.runName ?? 'kodyRulesFileToRules';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            mainProvider,
            mainFallback,
            byokConfigValue,
        );

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName: `${KodyRulesSyncService.name}::${mainRun}`,
                runName: mainRun,
                attrs: {
                    repositoryId: params.repositoryId,
                    filePath: params.filePath,
                    type: promptRunner.executeMode,
                    fallback: false,
                },
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(
                            ParserType.ZOD,
                            kodyRulesIDEGeneratorSchema,
                            {
                                provider: LLMModelProvider.OPENAI_GPT_4O_MINI,
                                fallbackProvider:
                                    LLMModelProvider.OPENAI_GPT_4O,
                            },
                        )
                        .setLLMJsonMode(true)
                        .setPayload({
                            filePath: params.filePath,
                            repositoryId: params.repositoryId,
                            content: params.content,
                        })
                        .addPrompt({
                            role: PromptRole.SYSTEM,
                            prompt: [
                                'Convert repository rule files (Cursor, Claude, GitHub rules, coding standards, etc.) into a JSON array of Kody Rules. IMPORTANT: Enforce exactly one rule per file. If multiple candidate rules exist, merge them COMPREHENSIVELY into one unified rule that preserves all essential details.',
                                'Output ONLY a valid JSON array. If none, output []. No comments or explanations.',
                                'Each item MUST match exactly:',
                                '{"title": string, "rule": string, "path": string, "sourcePath": string, "severity": "low"|"medium"|"high"|"critical", "scope"?: "file"|"pull-request", "status"?: "active"|"pending"|"rejected"|"deleted", "examples": [{ "snippet": string, "isCorrect": boolean }], "sourceSnippet"?: string}',
                                'Detection: extract a rule only if the text imposes a requirement/restriction/convention/standard.',
                                'Severity map: must/required/security/blocker → "high" or "critical"; should/warn → "medium"; tip/info/optional → "low".',
                                'Scope: "file" for code/content; "pull-request" for PR titles/descriptions/commits/reviewers/labels.',
                                'Status: "active"',
                                'path (target GLOB): use declared globs/paths when present (frontmatter like "globs:" or explicit sections). If none, set "**/*". If multiple, join with commas (e.g., "services/**,api/**").',
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
                        })
                        .addPrompt({
                            role: PromptRole.USER,
                            prompt: `File: ${params.filePath}\n\nContent:\n${params.content}`,
                        })
                        .addCallbacks(callbacks) // <- injeta tracker
                        .addMetadata({ runName: mainRun })
                        .setRunName(mainRun)
                        .execute();
                },
            });

            if (!result?.rules || result.rules.length === 0) return [];

            const normalizeRule = (rule: any): Partial<CreateKodyRuleDto> => ({
                ...rule,
                severity:
                    (rule?.severity?.toString?.().toLowerCase?.() as any) ||
                    KodyRuleSeverity.MEDIUM,
                scope: (rule?.scope as any) || KodyRulesScope.FILE,
                path: rule?.path || params.filePath,
                sourcePath: rule?.sourcePath || params.filePath,
                repositoryId: rule?.repositoryId || params.repositoryId,
                origin: KodyRulesOrigin.USER,
                status: options?.defaultStatus || KodyRulesStatus.ACTIVE,
                examples: Array.isArray(rule?.examples)
                    ? rule.examples.map((example: any) => ({
                          snippet: example?.snippet || '',
                          isCorrect: example?.isCorrect || false,
                      }))
                    : [],
            });

            return result.rules.map(normalizeRule);
        } catch (error) {
            const fbRun = `${mainRun}Raw`;
            try {
                const fbProvider =
                    options?.mainProvider ?? LLMModelProvider.GEMINI_2_5_FLASH;
                const fbFallback =
                    options?.fallbackProvider ??
                    LLMModelProvider.GEMINI_2_5_PRO;

                const promptRunner = new BYOKPromptRunnerService(
                    this.promptRunnerService,
                    fbProvider,
                    fbFallback,
                    byokConfigValue,
                );

                const { result: raw } =
                    await this.observabilityService.runLLMInSpan({
                        spanName: `${KodyRulesSyncService.name}::${fbRun}`,
                        runName: fbRun,
                        attrs: {
                            repositoryId: params.repositoryId,
                            filePath: params.filePath,
                            type: promptRunner.executeMode,
                            fallback: true,
                        },
                        exec: async (callbacks) => {
                            return await promptRunner
                                .builder()
                                .setParser(ParserType.STRING)
                                .setPayload({
                                    filePath: params.filePath,
                                    repositoryId: params.repositoryId,
                                    content: params.content,
                                })
                                .addPrompt({
                                    role: PromptRole.SYSTEM,
                                    prompt: 'Return ONLY the JSON array for the rules, without code fences. Include a "sourceSnippet" field when you can copy an exact excerpt from the file for each rule. No explanations.',
                                })
                                .addPrompt({
                                    role: PromptRole.USER,
                                    prompt: `File: ${params.filePath}\n\nContent:\n${params.content}`,
                                })
                                .addCallbacks(callbacks)
                                .addMetadata({ runName: fbRun })
                                .setRunName(fbRun)
                                .execute();
                        },
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
                    origin: KodyRulesOrigin.USER,
                    status: options?.defaultStatus || KodyRulesStatus.ACTIVE,
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

    private async convertFilesToKodyRulesFastBatch(params: {
        files: Array<{ path: string; content: string }>;
        repositoryId: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<Array<Partial<CreateKodyRuleDto>>> {
        const byokConfigValue =
            await this.permissionValidationService.getBYOKConfig(
                params.organizationAndTeamData,
            );

        const mainProvider = LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_;
        const mainFallback = LLMModelProvider.GROQ_GPT_OSS_120B;
        const mainRun = 'kodyRulesFilesToRulesFastBatch';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            mainProvider,
            mainFallback,
            byokConfigValue,
        );

        const userPrompt = params.files
            .map(
                (file) =>
                    `### FILE: ${file.path}\n<content>\n${file.content}\n</content>`,
            )
            .join('\n\n');

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName: `${KodyRulesSyncService.name}::${mainRun}`,
                runName: mainRun,
                attrs: {
                    repositoryId: params.repositoryId,
                    filesCount: params.files.length,
                    type: promptRunner.executeMode,
                    fallback: false,
                },
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(
                            ParserType.ZOD,
                            kodyRulesIDEGeneratorSchemaOnboarding,
                            {
                                provider: LLMModelProvider.GEMINI_2_5_FLASH,
                                fallbackProvider:
                                    LLMModelProvider.OPENAI_GPT_4O,
                            },
                        )
                        .setLLMJsonMode(true)
                        .setPayload({
                            repositoryId: params.repositoryId,
                            filesCount: params.files.length,
                        })
                        .addPrompt({
                            role: PromptRole.SYSTEM,
                            prompt: [
                                'You will receive multiple repository rule files. Return ONLY a JSON object { "rules": [...] } (no code fences) with up to 3 MOST IMPORTANT Kody Rules across all files (prioritize critical/high impact, security/compliance, or broad applicability). If none, return { "rules": [] }.',
                                'Each rule must include: title, rule, path, sourcePath, severity ("low"|"medium"|"high"|"critical"), optional scope ("file"|"pull-request"), examples: [{ "snippet": string, "isCorrect": boolean }], and optional sourceSnippet.',
                                'For each file, if multiple candidate rules exist, merge them into one comprehensive rule for that file, then select only the top rules overall.',
                                'sourcePath MUST be the file path from input. Use the same for path unless the file declares specific globs.',
                                'If a file has zero rules, skip it (do not emit placeholder).',
                                'If a file is a dependency manifest (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, pom.xml, build.gradle(.kts), csproj, Gemfile, mix.exs, etc.), infer up to 3 high-impact rules for that stack (security, auth, logging, testing, linting, secrets) based on dependencies/frameworks present.',
                                'Severity map: must/required/security/blocker → "high"/"critical"; should/warn → "medium"; tip/info/optional → "low".',
                                'Scope: "file" for code/content; "pull-request" for PR titles/descriptions/commits/reviewers/labels.',
                                'Include sourceSnippet when you can copy an exact excerpt that triggered the rule.',
                                'Always return the rule text in English, even if the source file is in another language. Do NOT mirror the source language.',
                                'Do NOT include extra keys (repositoryId, origin, uuid, timestamps).',
                                'Be exhaustive: preserve specific APIs, steps, anti-patterns, and examples from each file.',
                            ].join(' '),
                        })
                        .addPrompt({
                            role: PromptRole.USER,
                            prompt: `Repository: ${params.repositoryId}\nFiles:\n\n${JSON.stringify(userPrompt)}`,
                        })
                        .addCallbacks(callbacks)
                        .addMetadata({ runName: mainRun })
                        .setRunName(mainRun)
                        .execute();
                },
            });

            if (!result?.rules || result.rules.length === 0) return [];

            return (result.rules as Array<Partial<CreateKodyRuleDto>>)
                .slice(0, 3)
                .map((rule) => ({
                    ...rule,
                    repositoryId:
                        (rule as any)?.repositoryId || params.repositoryId,
                    status: KodyRulesStatus.PENDING,
                }));
        } catch (error) {
            const fbRun = `${mainRun}Raw`;
            try {
                const promptRunner = new BYOKPromptRunnerService(
                    this.promptRunnerService,
                    mainProvider,
                    mainFallback,
                    byokConfigValue,
                );

                const { result: raw } =
                    await this.observabilityService.runLLMInSpan({
                        spanName: `${KodyRulesSyncService.name}::${fbRun}`,
                        runName: fbRun,
                        attrs: {
                            repositoryId: params.repositoryId,
                            filesCount: params.files.length,
                            type: promptRunner.executeMode,
                            fallback: true,
                        },
                        exec: async (callbacks) => {
                            return await promptRunner
                                .builder()
                                .setParser(ParserType.STRING)
                                .addPrompt({
                                    role: PromptRole.SYSTEM,
                                    prompt: [
                                        'Return ONLY a JSON object { "rules": [...] } (no code fences, no text), capped at 3 rules.',
                                        'Each rule must include: title, rule, path, sourcePath, severity ("low"|"medium"|"high"|"critical"), optional scope ("file"|"pull-request"), examples: [{ "snippet": string, "isCorrect": boolean }], and optional sourceSnippet.',
                                        'Always respond in English, even if the source file uses another language.',
                                        'If a file is a dependency manifest (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, pom.xml, build.gradle(.kts), csproj, Gemfile, mix.exs, etc.), infer rules for that stack based on dependencies (security, auth, logging, testing, linting, secrets).',
                                        'Do NOT include extra keys (repositoryId, origin, uuid, timestamps).',
                                    ].join(' '),
                                })
                                .addPrompt({
                                    role: PromptRole.USER,
                                    prompt: `Repository: ${params.repositoryId}\nFiles:\n\n${userPrompt}`,
                                })
                                .addCallbacks(callbacks)
                                .addMetadata({ runName: fbRun })
                                .setRunName(fbRun)
                                .execute();
                        },
                    });

                const parsed = this.extractJsonArray(raw);
                if (!Array.isArray(parsed)) {
                    return [];
                }

                return (parsed as Array<Partial<CreateKodyRuleDto>>)
                    .slice(0, 3)
                    .map((rule) => ({
                        ...rule,
                        repositoryId:
                            (rule as any)?.repositoryId || params.repositoryId,
                        status: KodyRulesStatus.PENDING,
                    }));
            } catch (fallbackError) {
                this.logger.error({
                    message: 'LLM batch conversion failed for rule files',
                    context: KodyRulesSyncService.name,
                    metadata: {
                        repositoryId: params.repositoryId,
                        filesCount: params.files.length,
                        organizationAndTeamData: params.organizationAndTeamData,
                    },
                    error: fallbackError,
                });
                return [];
            }
        }
    }

    private async convertManifestsToKodyRulesFastBatch(params: {
        files: Array<{ path: string; content: string }>;
        repositoryId: string;
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<Array<Partial<CreateKodyRuleDto>>> {
        const byokConfigValue =
            await this.permissionValidationService.getBYOKConfig(
                params.organizationAndTeamData,
            );

        const mainProvider = LLMModelProvider.GROQ_MOONSHOTAI_KIMI_K2_;
        const mainFallback = LLMModelProvider.GROQ_GPT_OSS_120B;
        const mainRun = 'kodyRulesManifestsToRulesFastBatch';

        const promptRunner = new BYOKPromptRunnerService(
            this.promptRunnerService,
            mainProvider,
            mainFallback,
            byokConfigValue,
        );

        const userPrompt = params.files
            .map(
                (file) =>
                    `### FILE: ${file.path}\n<content>\n${file.content}\n</content>`,
            )
            .join('\n\n');

        try {
            const { result } = await this.observabilityService.runLLMInSpan({
                spanName: `${KodyRulesSyncService.name}::${mainRun}`,
                runName: mainRun,
                attrs: {
                    repositoryId: params.repositoryId,
                    filesCount: params.files.length,
                    type: promptRunner.executeMode,
                    fallback: false,
                },
                exec: async (callbacks) => {
                    return await promptRunner
                        .builder()
                        .setParser(
                            ParserType.ZOD,
                            kodyRulesManifestGeneratorSchemaOnboarding,
                            {
                                provider: LLMModelProvider.GEMINI_2_5_FLASH,
                                fallbackProvider:
                                    LLMModelProvider.OPENAI_GPT_4O,
                            },
                        )
                        .setLLMJsonMode(true)
                        .setPayload({
                            repositoryId: params.repositoryId,
                            filesCount: params.files.length,
                        })
                        .addPrompt({
                            role: PromptRole.SYSTEM,
                            prompt: [
                                'You will receive dependency manifests (package.json, requirements.txt, pyproject.toml, go.mod, Cargo.toml, pom.xml, build.gradle(.kts), csproj, Gemfile, mix.exs, etc.). Use them ONLY to infer stack, frameworks, and tooling.',
                                'Produce up to 3 HIGH-IMPACT Kody Rules tailored to this stack. Prioritize security/auth, secrets handling, logging/observability, testing/linting/type-check, dependency hygiene. Avoid generic style nits.',
                                'Do NOT propose rules that depend on CI/CD, bots, or specific version pinning/patch enforcement. Rules must be actionable via code/config only.',
                                'Return ONLY a JSON object { "rules": [...] } with no code fences. If none, return { "rules": [] }.',
                                'Each rule must include: title, rule, path (use the manifest path or glob inferred from it), severity ("low"|"medium"|"high"|"critical"), optional scope ("file"|"pull-request"), and examples: [{ "snippet": string, "isCorrect": boolean }].',
                                'Always respond in English, even if the manifest uses another language.',
                                'Do NOT include extra keys such as repositoryId, sourcePath, origin, uuid, or timestamps.',
                            ].join(' '),
                        })
                        .addPrompt({
                            role: PromptRole.USER,
                            prompt: `Repository: ${params.repositoryId}\nManifests:\n\n${userPrompt}`,
                        })
                        .addCallbacks(callbacks)
                        .addMetadata({ runName: mainRun })
                        .setRunName(mainRun)
                        .execute();
                },
            });

            if (!result?.rules || result.rules.length === 0) return [];

            return (result.rules as Array<Partial<CreateKodyRuleDto>>)
                .slice(0, 3)
                .map((rule) => ({
                    ...rule,
                    repositoryId:
                        (rule as any)?.repositoryId || params.repositoryId,
                    status: KodyRulesStatus.PENDING,
                }));
        } catch (error) {
            const fbRun = `${mainRun}Raw`;
            try {
                const promptRunner = new BYOKPromptRunnerService(
                    this.promptRunnerService,
                    mainProvider,
                    mainFallback,
                    byokConfigValue,
                );

                const { result: raw } =
                    await this.observabilityService.runLLMInSpan({
                        spanName: `${KodyRulesSyncService.name}::${fbRun}`,
                        runName: fbRun,
                        attrs: {
                            repositoryId: params.repositoryId,
                            filesCount: params.files.length,
                            type: promptRunner.executeMode,
                            fallback: true,
                        },
                        exec: async (callbacks) => {
                            return await promptRunner
                                .builder()
                                .setParser(ParserType.STRING)
                                .addPrompt({
                                    role: PromptRole.SYSTEM,
                                    prompt: [
                                        'Return ONLY a JSON object { "rules": [...] } (no code fences, no text), capped at 3 rules.',
                                        'Rules must be HIGH-IMPACT and actionable in code/config only (security/auth, secrets handling, logging/observability, testing/linting/type-check, dependency hygiene). Avoid generic style nits.',
                                        'Do NOT propose rules that depend on CI/CD, bots, or pinning/enforcing specific library versions/patches.',
                                        'Each rule must include: title, rule, path (manifest path or derived glob), severity ("low"|"medium"|"high"|"critical"), optional scope ("file"|"pull-request"), and examples: [{ "snippet": string, "isCorrect": boolean }]. Always respond in English, even if the manifest uses another language.',
                                        'Do NOT include repositoryId, sourcePath, origin, uuid, or timestamps.',
                                    ].join(' '),
                                })
                                .addPrompt({
                                    role: PromptRole.USER,
                                    prompt: `Repository: ${params.repositoryId}\nManifests:\n\n${userPrompt}`,
                                })
                                .addCallbacks(callbacks)
                                .addMetadata({ runName: fbRun })
                                .setRunName(fbRun)
                                .execute();
                        },
                    });

                const parsed = this.extractJsonArray(raw);
                if (!Array.isArray(parsed)) {
                    return [];
                }

                return (parsed as Array<Partial<CreateKodyRuleDto>>)
                    .slice(0, 3)
                    .map((rule) => ({
                        ...rule,
                        repositoryId:
                            (rule as any)?.repositoryId || params.repositoryId,
                        status: KodyRulesStatus.PENDING,
                    }));
            } catch (fallbackError) {
                this.logger.error({
                    message: 'LLM manifest conversion failed for rule files',
                    context: KodyRulesSyncService.name,
                    metadata: {
                        repositoryId: params.repositoryId,
                        filesCount: params.files.length,
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
            } catch {}
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

    private getRuleId(
        result: Partial<{ uuid?: string; id?: string }> | null | undefined,
    ): string | undefined {
        if (!result) {
            return undefined;
        }

        if (typeof result.uuid === 'string' && result.uuid) {
            return result.uuid;
        }

        if (typeof result.id === 'string' && result.id) {
            return result.id;
        }

        const fallback =
            typeof (result as Record<string, unknown>)._id === 'string'
                ? ((result as Record<string, unknown>)._id as string)
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
                    await this.getAdditionalInfoHelper.getTeamIdByOrganizationAndRepository(
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
                    },
                );

            if (contextReferenceId) {
                await this.kodyRulesService.updateRuleReferences(
                    organizationAndTeamData.organizationId,
                    ruleId,
                    { contextReferenceId },
                );
            }

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

        return await this.getAdditionalInfoHelper.getRepositoryNameByOrganizationAndRepository(
            organizationId,
            repositoryId,
        );
    }

    /**
     * Verifica se um arquivo deve ser sincronizado forçadamente baseado na marcação @kody-sync
     * A marcação pode estar no início ou final do arquivo
     */
    private shouldForceSync(content: string): boolean {
        if (!content || typeof content !== 'string') {
            return false;
        }

        const trimmedContent = content.trim();
        if (!trimmedContent) {
            return false;
        }

        // Verifica as primeiras 10 linhas do arquivo
        const lines = trimmedContent.split('\n');
        const totalLines = lines.length;

        // Se o arquivo tem 20 linhas ou menos, verifica apenas as primeiras e últimas sem sobreposição
        let firstLines: string[];
        let lastLines: string[];

        if (totalLines <= 20) {
            const halfPoint = Math.floor(totalLines / 2);
            firstLines = lines.slice(0, halfPoint);
            lastLines = lines.slice(halfPoint);
        } else {
            firstLines = lines.slice(0, 10);
            lastLines = lines.slice(-10);
        }

        // Padrão para detectar @kody-sync (case insensitive, com word boundary)
        // Deve ter uma quebra de palavra antes do @ E depois de "sync" para evitar falsos positivos
        const syncPattern = /(?:^|[^a-zA-Z0-9._-])@kody-sync(?![a-zA-Z0-9_-])/i;

        // Verifica no início do arquivo
        const hasSyncAtStart = firstLines.some((line) =>
            syncPattern.test(line.trim()),
        );

        // Verifica no final do arquivo
        const hasSyncAtEnd = lastLines.some((line) =>
            syncPattern.test(line.trim()),
        );

        return hasSyncAtStart || hasSyncAtEnd;
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

    private async getConfiguredDirectories(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId?: string,
    ): Promise<string[]> {
        try {
            const cfg = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            // Must have repository context and repository-specific config
            if (!repositoryId || !cfg?.configValue?.repositories) {
                return [];
            }

            const repoConfig = cfg.configValue.repositories.find(
                (repo: any) =>
                    repo.id === repositoryId ||
                    repo.id === repositoryId.toString(),
            );

            if (
                !repoConfig ||
                !repoConfig.directories ||
                repoConfig.directories.length === 0
            ) {
                return [];
            }

            return repoConfig.directories.map((d) => d.path);
        } catch {
            return [];
        }
    }

    private async getDirectoryPatterns(
        organizationAndTeamData: OrganizationAndTeamData,
        repositoryId: string,
    ): Promise<string[]> {
        try {
            const dirs = await this.getConfiguredDirectories(
                organizationAndTeamData,
                repositoryId,
            );

            return dirs.flatMap((d) =>
                RULE_FILE_PATTERNS.map((p) =>
                    path.posix.join(d.startsWith('/') ? d.slice(1) : d, p),
                ),
            );
        } catch {
            return [];
        }
    }
}
