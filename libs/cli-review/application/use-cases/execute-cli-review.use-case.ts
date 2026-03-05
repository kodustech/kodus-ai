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
            if (!isTrialMode) {
                execution = await this.createAutomationExecution(
                    organizationAndTeamData,
                    correlationId,
                    userEmail,
                    gitContext,
                );
            }

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

            // 3. Load or create config
            const codeReviewConfig = isTrialMode
                ? this.getDefaultConfig(true) // Trial mode: use Gemini Flash
                : await this.loadUserConfig(organizationAndTeamData);

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
                batches: [],
                validSuggestions: [],
                discardedSuggestions: [],
                preparedFileContexts: [],

                // PR context (dummy values - not used in CLI mode)
                repository: {
                    id: 0,
                    name: 'cli-review',
                    fullName: 'cli/cli-review',
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
                    },
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
     * Load user's code review configuration from database
     */
    private async loadUserConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<CodeReviewConfig> {
        try {
            const params = await this.parametersService.findByKey(
                ParametersKey.CODE_REVIEW_CONFIG,
                organizationAndTeamData,
            );

            if (!params) {
                this.logger.warn({
                    message: 'No config found in database, using defaults',
                    context: ExecuteCliReviewUseCase.name,
                    metadata: { organizationAndTeamData },
                });
                return this.getDefaultConfig();
            }

            const paramObj = params.toObject();
            const config =
                paramObj.configValue?.configs || this.getDefaultConfig();
            const normalizedConfig = this.normalizeCliConfig(
                config,
                this.getDefaultConfig(),
            );

            // Ensure required fields are present
            return {
                ...normalizedConfig,
                languageResultPrompt:
                    (normalizedConfig as any).languageResultPrompt || {},
            } as any as CodeReviewConfig;
        } catch (error) {
            this.logger.warn({
                message: 'Error loading config from database, using defaults',
                error,
                context: ExecuteCliReviewUseCase.name,
                metadata: { organizationAndTeamData },
            });
            return this.getDefaultConfig();
        }
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
    ): Promise<void> {
        try {
            await this.automationExecutionService.update(
                { uuid: execution.uuid },
                {
                    status,
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
