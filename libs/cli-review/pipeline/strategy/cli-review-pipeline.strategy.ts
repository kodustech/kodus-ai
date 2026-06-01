import { Injectable } from '@nestjs/common';
import { IPipelineStrategy } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-strategy.interface';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { CliReviewPipelineContext } from '../context/cli-review-pipeline.context';

// Reused stages from code-review pipeline
import { CreateSandboxStage } from '@libs/code-review/pipeline/stages/create-sandbox.stage';
import { AgentReviewStage } from '@libs/code-review/pipeline/stages/agent-review.stage';
import { AggregateResultsStage } from '@libs/code-review/pipeline/stages/aggregate-result.stage';

// CLI-specific stages
import { PrepareCliFilesStage } from '../stages/prepare-cli-files.stage';
import { FormatCliOutputStage } from '../stages/format-cli-output.stage';

/**
 * Pipeline strategy for CLI code review.
 *
 * Uses the agent-based engine (same one used by the PR workflow when the
 * agentReview feature flag is on): a sandbox is created so the agent can
 * use tools (readFile, grep, checkTypes, ...), the agent loop runs via
 * ReviewOrchestratorService, and findings are formatted for the CLI.
 *
 * Config resolution/validation happens in the use case BEFORE pipeline
 * execution. Git context is populated by the use case and consumed by
 * CreateSandboxStage to clone the repo into the sandbox.
 */
@Injectable()
export class CliReviewPipelineStrategy
    implements IPipelineStrategy<CliReviewPipelineContext>
{
    constructor(
        // Shared stages (from code-review pipeline)
        private readonly createSandboxStage: CreateSandboxStage,
        private readonly agentReviewStage: AgentReviewStage,
        private readonly aggregateResultsStage: AggregateResultsStage,

        // CLI-specific stages
        private readonly prepareCliFilesStage: PrepareCliFilesStage,
        private readonly formatCliOutputStage: FormatCliOutputStage,
    ) {}

    /**
     * Configure the pipeline stages in execution order:
     *   1. PrepareCliFiles  — validate FileChange objects
     *   2. CreateSandbox    — clone repo into sandbox
     *   3. AgentReview      — run the agent loop (it discovers cross-file
     *                         context itself via readFile/grep/checkTypes)
     *   4. AggregateResults — collect and dedupe suggestions
     *   5. FormatCliOutput  — convert to CLI response format
     */
    configureStages(): BasePipelineStage<CliReviewPipelineContext>[] {
        return [
            this.prepareCliFilesStage,
            this.createSandboxStage as any,
            this.agentReviewStage as any,
            this.aggregateResultsStage as any,
            this.formatCliOutputStage,
        ];
    }

    getPipelineName(): string {
        return 'CliReviewPipeline';
    }
}
