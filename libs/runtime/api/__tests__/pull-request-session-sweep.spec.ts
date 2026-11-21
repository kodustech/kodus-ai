import { RuntimePullRequestSessionSweep, STALE_SESSION_HOURS } from '../application/use-cases/pull-request-session-sweep.use-case';

// A lost PR close: the sweep asks the trigger's close path about each PR
// whose session is older than STALE_SESSION_HOURS; the trigger reads the PR's
// state from the Git API and sends the close only for one closed or merged.
describe('the PR session sweep', () => {
    const now = new Date('2026-11-13T12:00:00Z');
    const prs = [
        { organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 7 }, // closed, its close lost
        { organizationId: 'org-a', repositoryId: 'repo-1', prNumber: 8 }, // still open
        { organizationId: 'org-a', repositoryId: 'repo-x', prNumber: 1 }, // no Runtime environment
    ];

    it('sends the close of a closed PR, nothing for one still open, and skips what it cannot read', async () => {
        let asked: Date | undefined;
        const events: any[] = [];
        const sweep = new RuntimePullRequestSessionSweep(
            {
                async stalePullRequests(before) {
                    asked = before;
                    return prs;
                },
            },
            { environmentsOf: async (_o, repo) => (repo === 'repo-1' ? [{ env: { teamId: 'team-1' }, member: { repositoryName: 'acme/shop' } }] : []) },
            {
                async execute(ev: any, opts?: { closeOnlyWhenConfirmed?: boolean }) {
                    events.push({ ...ev, opts });
                    // PR 7 closed with no Run live: the close still went to the worker.
                    return ev.prNumber === 7 ? { action: 'skipped', reason: 'nothing_live' } : { action: 'skipped', reason: 'pr_still_open' };
                },
            },
            () => now,
        );
        expect(await sweep.run()).toEqual({ checked: 3, closed: 1, open: 1, unknown: 1 });
        expect(asked).toEqual(new Date(now.getTime() - STALE_SESSION_HOURS * 3_600_000));
        expect(events.map((e) => [e.event, e.teamId, e.repository, e.prNumber, e.opts])).toEqual([
            ['closed', 'team-1', { id: 'repo-1', name: 'acme/shop' }, 7, { closeOnlyWhenConfirmed: true }],
            ['closed', 'team-1', { id: 'repo-1', name: 'acme/shop' }, 8, { closeOnlyWhenConfirmed: true }],
        ]);
    });

    it('counts a PR whose state the Git API cannot say as unknown, never closed', async () => {
        const sweep = new RuntimePullRequestSessionSweep(
            { stalePullRequests: async () => [prs[0]] },
            { environmentsOf: async () => [{ env: { teamId: 'team-1' }, member: { repositoryName: 'acme/shop' } }] },
            { execute: async () => ({ action: 'skipped', reason: 'pr_state_unknown' }) },
            () => now,
        );
        expect(await sweep.run()).toEqual({ checked: 1, closed: 0, open: 0, unknown: 1 });
    });

    it('a PR whose check throws is counted unknown and the sweep goes on to the next one', async () => {
        const sweep = new RuntimePullRequestSessionSweep(
            { stalePullRequests: async () => prs.slice(0, 2) },
            {
                environmentsOf: async () => [{ env: { teamId: 'team-1' }, member: { repositoryName: 'acme/shop' } }],
            },
            {
                async execute(ev: any) {
                    if (ev.prNumber === 7) throw new Error('store unavailable');
                    return { action: 'skipped', reason: 'nothing_live' };
                },
            },
            () => now,
        );
        expect(await sweep.run()).toEqual({ checked: 2, closed: 1, open: 0, unknown: 1 });
    });
});
