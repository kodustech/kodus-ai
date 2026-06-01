import { createLogger } from '@kodus/flow';
import { Inject, Injectable } from '@nestjs/common';

import {
    COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN,
    CollectCrossFileContextsService,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { GraphContextService } from '@libs/code-review/infrastructure/adapters/services/graph/graph-context.service';
import { BasePipelineStage } from '@libs/core/infrastructure/pipeline/abstracts/base-stage.abstract';
import { StageVisibility } from '@libs/core/infrastructure/pipeline/enums/stage-visibility.enum';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { CliReviewPipelineContext } from '@libs/cli-review/pipeline/context/cli-review-pipeline.context';

@Injectable()
export class CollectCrossFileContextStage extends BasePipelineStage<CodeReviewPipelineContext> {
    readonly stageName = 'CollectCrossFileContextStage';
    readonly label = 'Gathering Cross-File Context';
    readonly visibility = StageVisibility.PRIMARY;

    private readonly logger = createLogger(CollectCrossFileContextStage.name);

    constructor(
        @Inject(COLLECT_CROSS_FILE_CONTEXTS_SERVICE_TOKEN)
        private readonly collectCrossFileContextsService: CollectCrossFileContextsService,
        private readonly graphContext: GraphContextService,
    ) {
        super();
    }

    protected async executeStage(
        context: CodeReviewPipelineContext,
    ): Promise<CodeReviewPipelineContext> {
        const isCliMode = context.origin === 'cli';
        const cliContext = isCliMode
            ? (context as unknown as CliReviewPipelineContext)
            : undefined;
        const label = isCliMode
            ? `branch ${cliContext?.gitContext?.branch ?? 'unknown'}`
            : `PR#${context?.pullRequest?.number}`;

        // Guard: skip in fast mode — the agent will rely on its own
        // readFile/grep tools for any cross-file exploration it needs,
        // and cross-file context collection can take 15-30s which defeats
        // the "fast" promise.
        if (context.codeReviewConfig?.reviewMode === 'fast') {
            this.logger.log({
                message: `Skipping cross-file context collection: fast review mode for ${label}`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'fast_mode',
                },
            });
            return context;
        }

        // Guard: skip in trial mode — there's no sandbox to explore and
        // the agent runs in self-contained mode using only the inlined
        // file contents sent by the CLI.
        if (cliContext?.isTrialMode) {
            this.logger.log({
                message: `Skipping cross-file context collection: trial mode for ${label}`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'trial_mode',
                },
            });
            return context;
        }

        // Guard: skip if no changed files
        if (!context?.changedFiles?.length) {
            this.logger.log({
                message: `Skipping cross-file context collection: no changed files for ${label}`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'no_changed_files',
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard: skip if no sandbox available in context. The lease-managed
        // sandbox is owned by CreateSandboxStage which runs earlier in the
        // pipeline; this stage just consumes it.
        const sandbox = context.sandboxHandle;
        if (!sandbox) {
            this.logger.log({
                message: `Skipping cross-file context collection: no sandbox in context for ${label}`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'no_sandbox',
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }

        // Guard (CLI): skip if no git remote available
        if (isCliMode && !cliContext?.gitContext?.remote) {
            this.logger.log({
                message: `Skipping cross-file context collection: no git remote in CLI context`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'skipped',
                    sandboxSkipReason: 'no_git_remote',
                },
            });
            return context;
        }

        try {
            this.logger.log({
                message: `[DEBUG] Reusing lease-managed sandbox for ${label} (type=${sandbox.type}, sandboxId=${sandbox.sandboxId})`,
                context: this.stageName,
                metadata: {
                    sandboxDecision: 'reused',
                    sandboxType: sandbox.type,
                    sandboxId: sandbox.sandboxId,
                    prNumber: context?.pullRequest?.number,
                },
            });

            // Collect cross-file contexts using sandbox remoteCommands
            const result =
                await this.collectCrossFileContextsService.collectContexts({
                    remoteCommands: sandbox.remoteCommands,
                    changedFiles: context.changedFiles,
                    byokConfig: context.codeReviewConfig?.byokConfig,
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    language:
                        context.codeReviewConfig?.languageResultPrompt ||
                        'en-US',
                    repoRoot: '.',
                });

            this.logger.log({
                message: `Cross-file context collected for ${label}: ${result.contexts.length} snippets from ${result.totalSearches} searches`,
                context: this.stageName,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    contextsCount: result.contexts.length,
                    totalSearches: result.totalSearches,
                    totalSnippetsBeforeDedup: result.totalSnippetsBeforeDedup,
                },
            });

            // Generate graph JSON for content formatting (non-blocking)
            let graphJson: { nodes: any[]; edges: any[] } | null = null;
            if (sandbox && context.changedFiles?.length) {
                try {
                    graphJson = await this.graphContext.parseAndGetGraphJson(
                        sandbox,
                        context.changedFiles,
                    );
                    this.logger.log({
                        message: `[CROSS-FILE] Graph JSON for ${label}: ${graphJson ? `${graphJson.nodes.length} nodes, ${graphJson.edges.length} edges` : 'null (no nodes parsed)'}`,
                        context: this.stageName,
                        metadata: { hasGraph: !!graphJson, nodeCount: graphJson?.nodes?.length ?? 0, edgeCount: graphJson?.edges?.length ?? 0 },
                    });
                } catch (err) {
                    this.logger.warn({
                        message: `[CROSS-FILE] Graph JSON generation failed for ${label}, continuing without it`,
                        context: this.stageName,
                        error: err,
                    });
                }
            } else {
                this.logger.log({
                    message: `[CROSS-FILE] Skipping graph JSON: sandbox=${!!sandbox.run}, changedFiles=${context.changedFiles?.length ?? 0}`,
                    context: this.stageName,
                });
            }

            this.logger.log({
                message: `[CROSS-FILE] Storing sandbox for ${label}: type=${sandbox.type}, hasBaseBranch=${!!sandbox.baseBranch}, hasGraphJson=${!!graphJson}`,
                context: this.stageName,
            });

            return this.updateContext(context, (draft) => {
                draft.crossFileContexts = result;
                if (graphJson) {
                    draft.callGraphJson = graphJson;
                }
            });
        } catch (error) {
            // Non-fatal: log error and return context unchanged. Sandbox
            // lifecycle is owned by SandboxLeaseManager — no cleanup here.
            this.logger.error({
                message: `Failed to collect cross-file context for ${label}, continuing without it`,
                context: this.stageName,
                error,
                metadata: {
                    organizationAndTeamData: context?.organizationAndTeamData,
                    prNumber: context?.pullRequest?.number,
                },
            });
            return context;
        }
    }

    /**
     * Resolve clone parameters based on context origin.
     * - PR mode: uses codeManagementService.getCloneParams() as before
     * - CLI mode: parses git remote URL and tries to get auth from platform integration
     */
}
