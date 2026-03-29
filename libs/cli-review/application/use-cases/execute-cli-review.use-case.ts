import { Injectable, Inject } from '@nestjs/common';
import { createLogger, IdGenerator } from '@kodus/flow';
import { LLMModelProvider } from '@kodus/kodus-common/llm';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    CliReviewInput,
    CliReviewResponse,
} from '@libs/cli-review/domain/types/cli-review.types';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CliInputConverter } from '@libs/cli-review/infrastructure/converters/cli-input.converter';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';
import { CliReviewPipelineStrategy } from '@libs/cli-review/pipeline/strategy/cli-review-pipeline.strategy';
import { PipelineExecutor } from '@libs/core/infrastructure/pipeline/services/pipeline-executor.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@libs/core/domain/enums';
import {
    CodeReviewConfig,
    CodeReviewVersion,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { DeepPartial } from 'typeorm';
import { getDefaultKodusConfigFile } from '@libs/common/utils/validateCodeReviewConfigFile';
import { AutomationStatus } from '@libs/automation/domain/automation/enum/automation-status';
import { PipelineError } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import {
    IAutomationExecutionService,
    AUTOMATION_EXECUTION_SERVICE_TOKEN,
} from '@libs/automation/domain/automationExecution/contracts/automation-execution.service';
import { IAutomationExecution } from '@libs/automation/domain/automationExecution/interfaces/automation-execution.interface';
import {
    ITeamAutomationService,
    TEAM_AUTOMATION_SERVICE_TOKEN,
} from '@libs/automation/domain/teamAutomation/contracts/team-automation.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { deepMerge } from '@libs/common/utils/deep';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesValidationService } from '@libs/ee/kodyRules/service/kody-rules-validation.service';

interface GitContext {
    remote?: string;
    branch?: string;
    commitSha?: string;
    inferredPlatform?: PlatformType;
    cliVersion?: string;
}

interface ExecuteCliReviewInput {
    organizationAndTeamData: OrganizationAndTeamData;
    input: CliReviewInput;
    isTrialMode?: boolean;
    userEmail?: string;
    gitContext?: GitContext;
}

/**
 * Use case for executing CLI code review
 * Orchestrates the conversion, pipeline execution, and response formatting
 */
@Injectable()
export class ExecuteCliReviewUseCase implements IUseCase {
    private readonly logger = createLogger(ExecuteCliReviewUseCase.name);

    constructor(
        private readonly converter: CliInputConverter,
        private readonly pipelineStrategy: CliReviewPipelineStrategy,
        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,
        @Inject(AUTOMATION_EXECUTION_SERVICE_TOKEN)
        private readonly automationExecutionService: IAutomationExecutionService,
        @Inject(TEAM_AUTOMATION_SERVICE_TOKEN)
        private readonly teamAutomationService: ITeamAutomationService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        private readonly kodyRulesValidationService: KodyRulesValidationService,
    ) {}

    async execute(params: ExecuteCliReviewInput): Promise<CliReviewResponse> {
        const {
            organizationAndTeamData,
            input,
            isTrialMode = false,
            userEmail,
            gitContext,
        } = params;
        const correlationId = IdGenerator.correlationId();
        const startTime = Date.now();
        let execution: IAutomationExecution | null = null;

        try {
            this.logger.log({
                message: 'Starting CLI review',
                context: ExecuteCliReviewUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    correlationId,
                    isTrialMode,
                    isFastMode: input.config?.fast,
                    filesCount: input.config?.files?.length || 0,
                },
            });

            // 1. Create automation execution for tracking
            execution = await this.createAutomationExecution(
                organizationAndTeamData,
                correlationId,
                userEmail,
                gitContext,
            );

            // 2. Convert CLI input to FileChange[]
            const changedFiles = this.converter.convertToFileChanges(input);

            if (changedFiles.length === 0) {
                this.logger.warn({
                    message: 'No files to analyze after conversion',
                    context: ExecuteCliReviewUseCase.name,
                    metadata: {
                        correlationId,
                        organizationId: organizationAndTeamData?.organizationId,
                    },
                });

                return {
                    summary: 'No files to analyze',
                    issues: [],
                    filesAnalyzed: 0,
                    duration: Date.now() - startTime,
                };
            }

            // 3. Load or create config and resolve repository
            const { config: codeReviewConfig, repositoryId: resolvedRepoId, repositoryName: resolvedRepoName } =
                isTrialMode
                    ? {
                          config: this.getDefaultConfig(true),
                          repositoryId: 'global',
                          repositoryName: null,
                      }
                    : await this.loadUserConfigWithRules(
                          organizationAndTeamData,
                          gitContext,
                      );

            // 4. Create pipeline context
            const context: CliReviewPipelineContext = {
                // CLI-specific fields
                isFastMode: input.config?.fast || !input.config?.files,
                isTrialMode,
                startTime,
                correlationId,

                // Required by CodeReviewPipelineContext (dummy values for CLI)
                organizationAndTeamData,
                codeReviewConfig,
                changedFiles,
                validSuggestions: [],
                discardedSuggestions: [],
                preparedFileContexts: [],

                // PR context - use resolved repository ID and name for kody rules filtering
                repository: {
                    id: resolvedRepoId,
                    name: resolvedRepoName ?? 'cli-review',
                    fullName: resolvedRepoName ? `cli/${resolvedRepoName}` : 'cli/cli-review',
                    private: false,
                    owner: 'cli',
                    html_url: '',
                    default_branch: 'main',
                } as any,
                branch: 'cli',
                pullRequest: {
                    number: 0,
                    title: 'CLI Review',
                    base: {
                        repo: { fullName: 'cli/cli-review' },
                        ref: 'main',
                    },
                    repository: {} as any,
                    isDraft: false,
                    stats: {
                        total_additions: 0,
                        total_deletions: 0,
                        total_files: changedFiles.length,
                        total_lines_changed: 0,
                    },
                } as any,
                dryRun: { enabled: false },
                teamAutomationId: 'cli-automation',
                origin: 'cli',
                action: 'review',
                platformType: (gitContext?.inferredPlatform || 'github') as any,

                // Git context for cross-file analysis (CLI mode)
                gitContext: gitContext
                    ? {
                          remote: gitContext.remote,
                          branch: gitContext.branch,
                          commitSha: gitContext.commitSha,
                          inferredPlatform: gitContext.inferredPlatform,
                      }
                    : undefined,

                // Pipeline metadata
                pipelineVersion: '1.0',
                errors: [] as PipelineError[],
                statusInfo: {
                    status: AutomationStatus.IN_PROGRESS,
                },

                // Analysis tasks metadata
                tasks: {
                    astAnalysis: {
                        taskId: correlationId,
                        status: 'TASK_STATUS_COMPLETED' as any,
                    },
                },
            };

            // 5. Execute pipeline
            const pipelineExecutor =
                new PipelineExecutor<CliReviewPipelineContext>();
            const stages = this.pipelineStrategy.configureStages();
            const pipelineName = this.pipelineStrategy.getPipelineName();

            const result = await pipelineExecutor.execute(
                context,
                stages,
                pipelineName,
            );

            // 6. Return formatted response
            if (!result.cliResponse) {
                throw new Error('Pipeline did not generate CLI response');
            }

            // 7. Update execution as completed
            if (execution) {
                await this.updateAutomationExecution(
                    execution,
                    AutomationStatus.SUCCESS,
                    {
                        filesAnalyzed: changedFiles.length,
                        issuesFound: result.cliResponse.issues.length,
                        duration: result.cliResponse.duration,
                        repositoryResolution: {
                            resolvedRepositoryId: resolvedRepoId,
                            resolvedRepositoryName: resolvedRepoName,
                            matchedByRemote: resolvedRepoId !== 'global',
                            gitRemote: gitContext?.remote ?? null,
                        },
                    },
                    resolvedRepoId !== 'global' ? resolvedRepoId : undefined,
                );
            }

            this.logger.log({
                message: 'CLI review completed successfully',
                context: ExecuteCliReviewUseCase.name,
                metadata: {
                    correlationId,
                    organizationId: organizationAndTeamData?.organizationId,
                    issuesFound: result.cliResponse.issues.length,
                    duration: result.cliResponse.duration,
                },
            });

            return result.cliResponse;
        } catch (error) {
            // Update execution as failed
            if (execution) {
                await this.updateAutomationExecution(
                    execution,
                    AutomationStatus.ERROR,
                    { error: error?.message || 'Unknown error' },
                );
            }

            this.logger.error({
                message: 'Error executing CLI review',
                error,
                context: ExecuteCliReviewUseCase.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    correlationId,
                },
            });
            throw error;
        }
    }

    /**
     * Load user's code review configuration from database,
     * including kody rules resolved for the repository matched by git remote.
     */
    private async loadUserConfigWithRules(
        organizationAndTeamData: OrganizationAndTeamData,
        gitContext?: GitContext,
    ): Promise<{ config: CodeReviewConfig; repositoryId: string; repositoryName: string | null }> {
        try {
            const [params, kodyRulesEntity] = await Promise.all([
                this.parametersService.findByKey(
                    ParametersKey.CODE_REVIEW_CONFIG,
                    organizationAndTeamData,
                ),
                this.kodyRulesService.findByOrganizationId(
                    organizationAndTeamData.organizationId,
                ),
            ]);

            if (!params) {
                this.logger.warn({
                    message: 'No config found in database, using defaults',
                    context: ExecuteCliReviewUseCase.name,
                    metadata: { organizationAndTeamData },
                });
                return {
                    config: this.getDefaultConfig(),
                    repositoryId: 'global',
                    repositoryName: null,
                };
            }

            const paramObj = params.toObject();
            const config =
                paramObj.configValue?.configs || this.getDefaultConfig();
            const normalizedConfig = this.normalizeCliConfig(
                config,
                this.getDefaultConfig(),
            );

            // Resolve repositoryId and repositoryName from git remote URL
            const { id: repositoryId, name: repositoryName } = this.resolveRepositoryFromRemote(
                gitContext?.remote,
                paramObj.configValue?.repositories,
            );

            // Load and filter kody rules (global + repository-scoped)
            const { standardRules, memoryRules } =
                this.kodyRulesValidationService.filterKodyRules(
                    kodyRulesEntity?.toObject()?.rules,
                    repositoryId,
                );

            if (standardRules.length > 0 || memoryRules.length > 0) {
                this.logger.log({
                    message: 'Kody rules loaded for CLI review',
                    context: ExecuteCliReviewUseCase.name,
                    metadata: {
                        organizationId:
                            organizationAndTeamData.organizationId,
                        repositoryId,
                        repositoryName,
                        standardRulesCount: standardRules.length,
                        memoryRulesCount: memoryRules.length,
                        gitRemote: gitContext?.remote,
                    },
                });
            }

            return {
                config: {
                    ...normalizedConfig,
                    languageResultPrompt:
                        (normalizedConfig as any).languageResultPrompt || {},
                    kodyRules: standardRules,
                    kodyMemoryRules: memoryRules,
                } as any as CodeReviewConfig,
                repositoryId,
                repositoryName,
            };
        } catch (error) {
            this.logger.warn({
                message: 'Error loading config from database, using defaults',
                error,
                context: ExecuteCliReviewUseCase.name,
                metadata: { organizationAndTeamData },
            });
            return {
                config: this.getDefaultConfig(),
                repositoryId: 'global',
                repositoryName: null,
            };
        }
    }

    /**
     * Resolve the repository id and name by matching the git remote URL against
     * configured repositories. Falls back to 'global' if no match is found,
     * which ensures global rules are still applied.
     */
    private resolveRepositoryFromRemote(
        remote?: string,
        repositories?: Array<{ id: string; name: string; http_url?: string }>,
    ): { id: string; name: string | null } {
        if (!remote || !repositories?.length) {
            return { id: 'global', name: null };
        }

        const normalizedRemote = this.normalizeGitUrl(remote);

        for (const repo of repositories) {
            if (
                repo.http_url &&
                this.normalizeGitUrl(repo.http_url) === normalizedRemote
            ) {
                this.logger.log({
                    message: 'Repository matched from git remote',
                    context: ExecuteCliReviewUseCase.name,
                    metadata: {
                        repositoryId: repo.id,
                        repositoryName: repo.name,
                        remote,
                    },
                });
                return { id: repo.id, name: repo.name };
            }
        }

        // Fallback: try matching by repo name extracted from remote
        const repoName = this.extractRepoNameFromRemote(remote);
        if (repoName) {
            const match = repositories.find(
                (repo) =>
                    repo.name?.toLowerCase() === repoName.toLowerCase(),
            );
            if (match) {
                this.logger.log({
                    message:
                        'Repository matched from git remote by name fallback',
                    context: ExecuteCliReviewUseCase.name,
                    metadata: {
                        repositoryId: match.id,
                        repositoryName: match.name,
                        remote,
                    },
                });
                return { id: match.id, name: match.name };
            }
        }

        this.logger.warn({
            message:
                'Could not match git remote to any configured repository, using global rules only',
            context: ExecuteCliReviewUseCase.name,
            metadata: {
                remote,
                configuredRepos: repositories.map((r) => ({
                    id: r.id,
                    name: r.name,
                    http_url: r.http_url,
                })),
            },
        });

        return { id: 'global', name: null };
    }

    /**
     * Normalize a git URL for comparison by stripping protocol, auth,
     * trailing slashes, and .git suffix.
     */
    private normalizeGitUrl(url: string): string {
        return url
            .trim()
            .toLowerCase()
            .replace(/^(?:https?:\/\/|git@|ssh:\/\/)/, '')
            .replace(/:(?!\/)/, '/')
            .replace(/\.git$/, '')
            .replace(/\/+$/, '');
    }

    /**
     * Extract repository name from a git remote URL.
     * Handles HTTPS and SSH formats.
     */
    private extractRepoNameFromRemote(remote: string): string | null {
        // Strip trailing .git and slashes, then split by / or : to get last segment
        const normalized = remote.replace(/\.git$/, '').replace(/\/+$/, '');
        const parts = normalized.split(/[/:]/).filter(Boolean);
        if (parts.length >= 2) {
            return parts[parts.length - 1];
        }
        return null;
    }

    private normalizeCliConfig(
        config: DeepPartial<CodeReviewConfig>,
        defaults: CodeReviewConfig,
    ): DeepPartial<CodeReviewConfig> {
        const base = defaults as DeepPartial<CodeReviewConfig>;
        const merged = deepMerge(
            base,
            config || {},
        ) as DeepPartial<CodeReviewConfig>;

        merged.codeReviewVersion = CodeReviewVersion.v2;

        const reviewOptions = merged.reviewOptions || {};
        merged.reviewOptions = {
            bug: !!reviewOptions.bug,
            performance: !!reviewOptions.performance,
            security: !!reviewOptions.security,
            cross_file: !!reviewOptions.cross_file,
        } as any;

        return merged;
    }

    /**
     * Get default code review configuration
     * For trial mode, force Gemini 2.5 Flash (cheaper and faster)
     */
    private getDefaultConfig(isTrialMode: boolean = false): CodeReviewConfig {
        const defaults = getDefaultKodusConfigFile();

        const config = {
            ...defaults,
            automatedReviewActive: true,
            pullRequestApprovalActive: false,
            languageResultPrompt: {},
        } as any as CodeReviewConfig;

        // Force Gemini Flash for trial users (cost optimization)
        if (isTrialMode) {
            config.llmProvider = LLMModelProvider.GEMINI_2_5_FLASH;
        }

        return config;
    }

    /**
     * Create automation execution for tracking CLI reviews
     */
    private async createAutomationExecution(
        organizationAndTeamData: OrganizationAndTeamData,
        correlationId: string,
        userEmail?: string,
        gitContext?: GitContext,
    ): Promise<IAutomationExecution | null> {
        try {
            const teamAutomations = await this.teamAutomationService.find({
                team: { uuid: organizationAndTeamData.teamId },
                status: true,
            });

            return await this.automationExecutionService.create({
                status: AutomationStatus.IN_PROGRESS,
                origin: 'cli',
                ...(teamAutomations?.[0]?.uuid && {
                    teamAutomation: { uuid: teamAutomations[0].uuid },
                }),
                dataExecution: {
                    type: 'CLI_REVIEW',
                    correlationId,
                    userEmail,
                    organizationAndTeamData,
                    git: gitContext
                        ? {
                              remote: gitContext.remote,
                              branch: gitContext.branch,
                              commitSha: gitContext.commitSha,
                              inferredPlatform: gitContext.inferredPlatform,
                          }
                        : undefined,
                    cliVersion: gitContext?.cliVersion,
                },
            });
        } catch (error) {
            this.logger.error({
                message: 'Error creating automation execution for CLI review',
                error,
                context: ExecuteCliReviewUseCase.name,
                metadata: {
                    correlationId,
                    organizationId: organizationAndTeamData?.organizationId,
                    userEmail,
                    gitContext,
                },
            });
            return null;
        }
    }

    /**
     * Update automation execution status
     */
    private async updateAutomationExecution(
        execution: IAutomationExecution,
        status: AutomationStatus,
        resultData: Record<string, any>,
        repositoryId?: string,
    ): Promise<void> {
        try {
            await this.automationExecutionService.update(
                { uuid: execution.uuid },
                {
                    status,
                    ...(repositoryId && { repositoryId }),
                    dataExecution: {
                        ...execution.dataExecution,
                        ...resultData,
                    },
                },
            );
        } catch (error) {
            this.logger.error({
                message: 'Error updating automation execution',
                error,
                context: ExecuteCliReviewUseCase.name,
                metadata: { executionId: execution.uuid, status },
            });
        }
    }
}
