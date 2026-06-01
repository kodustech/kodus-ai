/**
 * Single source of truth for which stages belong to each review engine
 * branch. Consumed by:
 *   - `CodeReviewPipelineStrategy` to group stage instances into the
 *     correct branch when assembling the unified stage list.
 *   - `SelectReviewEngineStage` as the `skipStages([...])` payload for
 *     the losing branch.
 *
 * A consistency test in `code-review-pipeline.strategy.spec.ts` asserts
 * that the strategy's per-branch stage instances produce these exact
 * names — so adding a branch stage requires updating both this file
 * and the strategy's grouping method in lockstep, or the test fails.
 */

// IMPORTANT: these MUST be the literal `stageName` strings the stage
// classes set, not the class names — the executor matches `stage.stageName`
// against this list, so a class-name vs stageName mismatch silently
// makes the skip a no-op and both branches end up running. The strategy
// spec asserts these match the real classes' stageName fields.
export const EE_BRANCH_STAGE_NAMES = [
    'FileContextGateStage',
    'CollectCrossFileContextStage',
    'KodyFineTuningStage',
    // `ProcessFilesPrLevelReviewStage` class → stageName 'PRLevelReviewStage'
    'PRLevelReviewStage',
    // `ProcessFilesReview` class → stageName 'FileAnalysisStage'
    'FileAnalysisStage',
] as const;

export const AGENT_BRANCH_STAGE_NAMES = [
    'BusinessLogicValidationStage',
    'CreateSandboxStage',
    'AgentReviewStage',
] as const;

export type EeBranchStageName = (typeof EE_BRANCH_STAGE_NAMES)[number];
export type AgentBranchStageName = (typeof AGENT_BRANCH_STAGE_NAMES)[number];
