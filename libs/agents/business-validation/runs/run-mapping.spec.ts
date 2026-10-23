import { buildRun, detectAuthor } from './run-mapping';

describe('detectAuthor', () => {
    it('names the coding agent from a Co-Authored-By trailer', () => {
        expect(
            detectAuthor(
                [
                    {
                        message:
                            'feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>',
                        authorName: 'rafa',
                        authorEmail: 'rafa@example.com',
                    },
                ],
                'rafa',
            ),
        ).toEqual({ kind: 'agent', agent: 'Claude Code', login: 'rafa' });
    });

    it('names the agent that authored the commit', () => {
        expect(
            detectAuthor([
                { message: 'fix', authorName: 'copilot-swe-agent[bot]' },
            ]),
        ).toMatchObject({ kind: 'agent', agent: 'Copilot agent' });
    });

    it('is a person when no commit names an agent, and unknown without commits', () => {
        expect(
            detectAuthor([{ message: 'fix: y', authorName: 'nina' }]).kind,
        ).toBe('person');
        expect(detectAuthor(undefined).kind).toBe('unknown');
    });
});

describe('buildRun: a PR waiting on its tracker (UC-22)', () => {
    const skipped = {
        outcome: {
            kind: 'skipped' as const,
            reason: 'tracker_unavailable' as const,
            message: 'Linear is down',
        },
        references: [],
        attempts: [],
        trackers: ['Linear'],
    };
    const request = (door: 'auto' | 'cli') => ({
        door,
        organizationAndTeamData: { organizationId: 'org-1' },
        repository: { id: 'repo-1', name: 'notes' },
        pullRequest: { number: 47 },
        diff: '',
    });

    it('waits for a re-check from its first skip on, carried by each one that finds the tracker still down', () => {
        const first = buildRun(request('auto'), skipped as any);
        expect(first.pendingRecheck).toBe(true);
        expect(first.pendingSince).toBeInstanceOf(Date);

        const since = new Date('2026-10-21T02:00:00Z');
        expect(
            buildRun(request('auto'), skipped as any, { pendingSince: since })
                .pendingSince,
        ).toBe(since);
    });

    it('never queues a CLI check, which never comments on the PR', () => {
        const run = buildRun(request('cli'), skipped as any);
        expect(run.pendingRecheck).toBeUndefined();
        expect(run.pendingSince).toBeUndefined();
    });
});
