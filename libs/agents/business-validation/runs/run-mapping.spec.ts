import { buildRun, detectAuthor, sameResult } from './run-mapping';

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

describe('sameResult (#2423)', () => {
    const run = (
        over: Record<string, unknown> = {},
        task: Record<string, unknown> = {},
    ) =>
        ({
            outcome: 'validated',
            passed: false,
            unseenFiles: [],
            tasks: [
                {
                    tracker: 'Linear',
                    id: 'SAA-96',
                    passed: false,
                    readAt: '2026-10-05T12:00:00.000Z',
                    textHash: 'same-task-text',
                    requirements: [
                        {
                            requirement:
                                'The order persists after a page reload',
                            state: 'missing',
                            evidence: [],
                            confidence: 'high',
                        },
                    ],
                    outOfScope: [],
                    ...task,
                },
            ],
            ...over,
        }) as any;

    it('reads a new push with the same verdict, in other words, as the same result', () => {
        const reworded = run(
            { headSha: 'b'.repeat(40) },
            {
                requirements: [
                    {
                        requirement: 'The order persists after the page reload',
                        state: 'missing',
                        evidence: [],
                        confidence: 'high',
                    },
                ],
            },
        );
        expect(sameResult(run({ headSha: 'a'.repeat(40) }), reworded)).toBe(
            true,
        );
    });

    it('reads a change of scope or of the files the judge could not see as a change', () => {
        expect(sameResult(run(), run({}, { scopeMismatch: true }))).toBe(false);
        expect(sameResult(run(), run({ unseenFiles: ['icons/a.svg'] }))).toBe(
            false,
        );
    });

    it('reads AC01 fixed while AC02 broke as a change, though the states add up the same', () => {
        const req = (requirement: string, source: string, state: string) => ({
            requirement,
            source,
            state,
            evidence: [],
            confidence: 'high',
        });
        const before = run(
            {},
            {
                requirements: [
                    req('Refunds are logged', 'AC01', 'missing'),
                    req('Refunds notify the buyer', 'AC02', 'met'),
                ],
            },
        );
        const after = run(
            {},
            {
                requirements: [
                    req('Refunds are logged', 'AC01', 'met'),
                    req('Refunds notify the buyer', 'AC02', 'missing'),
                ],
            },
        );
        expect(sameResult(before, after)).toBe(false);
    });

    it('reads a different out-of-scope change as a change', () => {
        const change = (text: string) =>
            run({}, { outOfScope: [{ change: text, evidence: [] }] });
        expect(
            sameResult(
                change('Added a Redis cache to refunds'),
                change('Removed the audit log on refunds'),
            ),
        ).toBe(false);
    });

    it('reads a skip about another task as a change', () => {
        const missing = (id: string) =>
            ({
                outcome: 'task_missing',
                tasks: [],
                unseenFiles: [],
                references: [
                    {
                        kind: 'key',
                        id,
                        raw: id,
                        source: 'command',
                        intent: 'mentions',
                    },
                ],
            }) as any;
        expect(sameResult(missing('PAY-12'), missing('PAY-21'))).toBe(false);
        expect(sameResult(missing('PAY-12'), missing('PAY-12'))).toBe(true);
    });
});
