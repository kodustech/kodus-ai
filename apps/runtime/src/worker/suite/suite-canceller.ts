import type { SuiteMode } from '@libs/runtime/contracts/runtime-commands';

/** What the canceller asks of the suite runs' store: the PR's runs that have not ended. */
export interface LiveSuiteRuns {
    livePullRequestRuns(organizationId: string, repositoryId: string, prNumber: number, keepHead?: string): Promise<Array<{ suiteRunId: string; mode: SuiteMode }>>;
}

/** What it asks of the engine: stop the suite's workflow. */
export interface SuiteWorkflowCanceller {
    cancelSuite(suiteRunId: string): Promise<void>;
}

/**
 * A new push on a PR, or its close, cancels the PR's suites that run for another head (docs/runtime/e2e-suites.md section 11),
 * the way a newer Run supersedes an older one. A CI-mode suite is a workflow of its own: cancelling it makes the engine see the
 * cancel, stop its commands and their children, release its claims and end its demand, and close its check cancelled (a
 * cancelled suite is never a regression finding). A Run-mode suite is a stage of its Run, whose own stop cancels it, so it is
 * left to that. One suite that cannot be cancelled does not keep the others from it.
 */
export class SuiteCanceller {
    constructor(
        private readonly runs: LiveSuiteRuns,
        private readonly workflows: SuiteWorkflowCanceller,
    ) {}

    /** How many suites were cancelled. */
    async cancelPullRequest(input: { organizationId: string; repositoryId: string; prNumber: number; keepHead?: string }): Promise<number> {
        const live = await this.runs.livePullRequestRuns(input.organizationId, input.repositoryId, input.prNumber, input.keepHead);
        let cancelled = 0;
        for (const run of live) {
            if (run.mode === 'run') continue;
            try {
                await this.workflows.cancelSuite(run.suiteRunId);
                cancelled++;
            } catch {
                // The next cancel of this PR asks again; the suite's own lease and demand lapse on their own.
            }
        }
        return cancelled;
    }
}
