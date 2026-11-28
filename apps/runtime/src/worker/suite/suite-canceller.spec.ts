import { SuiteCanceller } from './suite-canceller';

// A new push on a PR, or its close, cancels the suites of that PR that run for another head: CI mode's own workflow is
// cancelled (the engine stops its commands and releases its claims and demand when it sees the cancel); a Run-mode suite
// is a stage of its Run and goes with the Run's stop.

const live = [
    { suiteRunId: 'ci-old', mode: 'ci' as const },
    { suiteRunId: 'run-old', mode: 'run' as const },
];

function world(rows = live) {
    const asked: unknown[] = [];
    const cancelled: string[] = [];
    const canceller = new SuiteCanceller(
        { livePullRequestRuns: async (...a: unknown[]) => (asked.push(a), rows) },
        { cancelSuite: async (id: string) => void cancelled.push(id) },
    );
    return { canceller, asked, cancelled };
}

describe('cancelling the suites of a pull request', () => {
    it('asks for the PR\'s live suite runs of other heads and cancels the CI one, leaving the Run-mode suite to its Run', async () => {
        const w = world();
        const n = await w.canceller.cancelPullRequest({ organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 7, keepHead: 'c'.repeat(40) });
        expect(w.asked).toEqual([['org-a', 'repo-1', 7, 'c'.repeat(40)]]);
        expect(w.cancelled).toEqual(['ci-old']);
        expect(n).toBe(1);
    });

    it('a closed PR keeps no head', async () => {
        const w = world();
        await w.canceller.cancelPullRequest({ organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 7 });
        expect(w.asked).toEqual([['org-a', 'repo-1', 7, undefined]]);
    });

    it('one suite that cannot be cancelled does not keep the others from it', async () => {
        const cancelled: string[] = [];
        const canceller = new SuiteCanceller(
            { livePullRequestRuns: async () => [{ suiteRunId: 'a', mode: 'ci' as const }, { suiteRunId: 'b', mode: 'ci' as const }] },
            { cancelSuite: async (id: string) => { if (id === 'a') throw new Error('dbos down'); cancelled.push(id); } },
        );
        expect(await canceller.cancelPullRequest({ organizationId: 'o', repositoryId: 'r', prNumber: 1 })).toBe(1);
        expect(cancelled).toEqual(['b']);
    });
});
