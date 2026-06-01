import { CodeReviewPipelineContext } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { CliReviewResponse } from '@libs/cli-review/domain/types/cli-review.types';
import { PlatformType } from '@libs/core/domain/enums';

export interface CliGitContext {
    remote?: string;
    branch?: string;
    commitSha?: string;
    /**
     * Merge-base between HEAD and the upstream default branch. Used by the
     * sandbox to checkout a commit that exists on the remote (avoids the
     * "couldn't find remote ref" failure when the user's branch hasn't
     * been pushed yet) and then apply the local diff on top.
     */
    mergeBaseSha?: string;
    /**
     * Optional GitHub personal access token. Only meaningful in trial mode
     * (anonymous users have no stored credentials, so without this we can
     * only clone public repos). Held in memory for the duration of the
     * pipeline and never persisted to dataExecution / logs.
     */
    githubPat?: string;
    inferredPlatform?: PlatformType;
}

/**
 * Pipeline context for CLI code review
 * Extends CodeReviewPipelineContext to reuse existing stages
 * PR-specific fields are populated with dummy values
 */
export interface CliReviewPipelineContext extends CodeReviewPipelineContext {
    // CLI-specific fields
    /**
     * Fast mode: cap agent step budget and skip heavy verification/recovery
     * passes. Used by the CLI for pre-commit feedback. The concrete
     * behavior is driven by `codeReviewConfig.reviewMode === 'fast'`, which
     * is set by the CLI use case when this flag is true.
     */
    isFastMode: boolean;
    isTrialMode: boolean;
    startTime: number;
    correlationId: string;
    cliResponse?: CliReviewResponse;
    gitContext?: CliGitContext;
    /**
     * Raw unified diff sent by the CLI (the same string the user gets from
     * `git diff <merge-base>..HEAD` plus uncommitted changes). The sandbox
     * stage applies this on top of `gitContext.mergeBaseSha` so the agent
     * runs against the user's exact local state — even when the branch
     * hasn't been pushed yet.
     */
    cliRawDiff?: string;
}
