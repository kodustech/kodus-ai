import type { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import type { OrchestratorInput } from '@libs/code-review/infrastructure/agents/review-orchestrator.service';

/**
 * The stage-computed locals that the orchestrator input needs on top of the
 * pipeline context (the call graph, the resolved GitHub token, the adaptive-fit
 * profile, the per-PR progress callback, etc.). Reuses OrchestratorInput's own
 * field types so the mapping below stays type-locked to the agent contract.
 */
export type OrchestratorInputComputed = Pick<
    OrchestratorInput,
    | 'changedFiles'
    | 'prNumber'
    | 'repositoryId'
    | 'reviewOptions'
    | 'onAgentProgress'
    | 'gitHubToken'
    | 'callGraph'
    | 'adaptiveProfile'
    // heavy is resolved by the stage (requested flag AND the feature-gate
    // release check) rather than read straight off the context, so the alpha
    // gate is applied in exactly one place.
    | 'heavy'
    | 'linkedRepoAccess'
> & {
    // Review-ready kody rules computed by the stage: long rules swapped for
    // their validated summaries (KodyRuleSummaryService). Optional so callers
    // without the service (specs, degraded paths) fall back to the raw config
    // rules — the context itself is never mutated (it is frozen).
    kodyRules?: OrchestratorInput['kodyRules'];
};

/**
 * Maps the pipeline context (+ stage-computed locals) into the agent
 * OrchestratorInput. Extracted as a PURE function so the context→input wiring is
 * unit-testable without standing up the whole AgentReviewStage — notably that
 * `reviewDirective` (from `@kody review <directive>`) actually reaches the
 * finder, an optional field that no typecheck would flag if a refactor silently
 * dropped it. Keep this the single place that builds the input.
 */
export function buildOrchestratorInput(
    context: CodeReviewPipelineContext,
    computed: OrchestratorInputComputed,
): OrchestratorInput {
    return {
        organizationAndTeamData: context.organizationAndTeamData,
        changedFiles: computed.changedFiles,
        // remoteCommands is undefined when no sandbox is available (e.g. trial
        // mode). The agent loop detects the empty-tools case and switches to a
        // self-contained analysis variant.
        remoteCommands: context.sandboxHandle?.remoteCommands as any,
        prNumber: computed.prNumber,
        repositoryId: computed.repositoryId,
        repositoryFullName:
            context.repository?.fullName ||
            context.pullRequest?.base?.repo?.fullName ||
            '',
        languageResultPrompt:
            context.codeReviewConfig?.languageResultPrompt || 'en-US',
        memoryRules: context.codeReviewConfig?.kodyMemoryRules,
        traceDecisions: context.traceDecisions,
        v2PromptOverrides: context.codeReviewConfig?.v2PromptOverrides,
        generationMain:
            context.codeReviewConfig?.v2PromptOverrides?.generation?.main,
        prTitle: context.pullRequest?.title,
        prBody: context.pullRequest?.body,
        // Commit list (oldest→newest) so commit-hygiene rules can be judged
        // against real commit boundaries. prAllCommits covers the whole PR; fall
        // back to prCommits (new-since-last) when absent.
        commits: (context.prAllCommits ?? context.prCommits)?.map((c) => ({
            sha: c.sha,
            message: c.commit?.message ?? '',
        })),
        // Free-text steering directive from `@kody review <directive>`.
        reviewDirective: context.reviewDirective,
        kodyRules: computed.kodyRules ?? context.codeReviewConfig?.kodyRules,
        reviewOptions: computed.reviewOptions,
        onAgentProgress: computed.onAgentProgress,
        gitHubToken: computed.gitHubToken,
        linkedRepoAccess: computed.linkedRepoAccess,
        baseBranch:
            context.sandboxHandle?.baseBranch ||
            context.pullRequest?.base?.ref ||
            context.repository?.defaultBranch,
        callGraph: computed.callGraph,
        callGraphJson: context.callGraphJson,
        reviewMode: context.codeReviewConfig?.reviewMode || 'normal',
        // HEAVY mode — opt-in per review (CLI `--heavy` / PR `@kody review
        // --heavy`), gated to the alpha release track by the stage. The stage
        // resolves the requested flag AND the feature gate into `computed.heavy`;
        // this reads only that so the gate can't be bypassed here.
        heavy: computed.heavy || undefined,
        // Trial-only forced model (ignored when a BYOK config is present —
        // byokToVercelModel prefers BYOK). Both subscription trial and the
        // anonymous public demo (try.kodus.io) → DeepSeek V4 Flash. The
        // isTrialMode flag lives on the CLI pipeline context; the cast avoids
        // inverting the dep graph (cli-review depends on code-review).
        defaultModelOverride:
            context.pipelineMetadata?.subscriptionStatus === 'trial'
                ? 'deepseek-v4-flash'
                : (context as { isTrialMode?: boolean }).isTrialMode
                  ? 'deepseek-v4-flash'
                  : undefined,
        // Per-repo/directory model override resolved by ValidateConfigStage.
        byokModel: context.codeReviewConfig?.byokModel,
        adaptiveProfile: computed.adaptiveProfile,
        skipHeavyPasses: computed.adaptiveProfile.skipHeavyPasses || undefined,
        // Experimental A/B knob (config-driven, default off): outline-first
        // readFile. Flows down to the finder's tool registry.
        outlineFirst: context.codeReviewConfig?.outlineFirst,
        parentSignal: context.parentSignal,
    };
}
