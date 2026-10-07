import { summarizeIntent, summarizeStatus } from './insights';
import type { ValidationRunRecord } from './validation-run.repository';

let seq = 0;
const run = (overrides: Partial<ValidationRunRecord>): ValidationRunRecord => ({
    id: String(++seq),
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    pullRequestNumber: seq,
    door: 'auto',
    outcome: 'validated',
    references: [],
    attempts: [],
    trackers: ['Linear'],
    tasks: [],
    unseenFiles: [],
    createdAt: new Date('2026-10-05T12:00:00Z'),
    ...overrides,
});

const task = (requirements: any[] = [], outOfScope: any[] = []) => ({
    tracker: 'Linear',
    id: 'SAA-96',
    readAt: '2026-10-05T12:00:00Z',
    passed: true,
    requirements,
    outOfScope,
});

describe('summarizeStatus', () => {
    it("counts checked PRs, how many met their task and what couldn't be read", () => {
        const status = summarizeStatus([
            run({ passed: true, tasks: [task()] }),
            run({ passed: false, tasks: [task()] }),
            run({ outcome: 'skipped', skipReason: 'task_not_found' }),
            run({ outcome: 'skipped', skipReason: 'no_reference' }),
        ]);
        expect(status.state).toBe('working');
        expect(status.lastTaskRead).toMatchObject({
            id: 'SAA-96',
            tracker: 'Linear',
        });
        expect(status.stats).toMatchObject({
            pullRequestsChecked: 2,
            metRate: 0.5,
            couldntRead: 1,
            couldntReadByReason: { task_not_found: 1 },
        });
    });

    it("says paused when the tracker stopped answering and hasn't answered since (UC-06)", () => {
        const status = summarizeStatus([
            run({
                outcome: 'skipped',
                skipReason: 'tracker_unavailable',
                attempts: [
                    { reference: 'SAA-1', tracker: 'Linear', status: 'error' },
                ],
                createdAt: new Date('2026-10-05T12:00:00Z'),
            }),
            run({
                outcome: 'skipped',
                skipReason: 'tracker_unavailable',
                attempts: [
                    { reference: 'SAA-2', tracker: 'Linear', status: 'error' },
                ],
                createdAt: new Date('2026-10-05T10:42:00Z'),
            }),
            run({
                passed: true,
                tasks: [task()],
                createdAt: new Date('2026-10-05T09:00:00Z'),
            }),
        ]);
        expect(status.state).toBe('paused');
        expect(status.paused).toMatchObject({
            tracker: 'Linear',
            since: '2026-10-05T10:42:00.000Z',
            uncheckedPullRequests: 2,
        });
    });

    it('counts PRs that referenced git issues no connected tracker reads (UC-07)', () => {
        const status = summarizeStatus([
            run({
                outcome: 'skipped',
                skipReason: 'no_capable_tracker',
                references: [
                    {
                        kind: 'git_issue',
                        id: '183',
                        raw: '#183',
                        source: 'body',
                        intent: 'closes',
                    },
                ],
            }),
        ]);
        expect(status.pointsElsewhere).toEqual({
            pullRequests: 1,
            kind: 'git_issue',
        });
    });

    it('measures agreement as the flagged findings nobody waived or overturned', () => {
        const status = summarizeStatus([
            run({
                tasks: [
                    task([
                        {
                            requirement: 'a',
                            state: 'missing',
                            evidence: [],
                            confidence: 'high',
                        },
                        {
                            requirement: 'b',
                            state: 'missing',
                            evidence: [],
                            confidence: 'high',
                            accepted: { by: 'nina', at: 'x' },
                        },
                        {
                            requirement: 'c',
                            state: 'met',
                            evidence: [],
                            confidence: 'high',
                            previousState: 'missing',
                        },
                        {
                            requirement: 'd',
                            state: 'met',
                            evidence: [],
                            confidence: 'high',
                            disputed: 'overturned',
                        },
                    ]),
                ],
            }),
        ]);
        expect(status.stats.agreedRate).toBe(0.5);
    });
});

describe('summarizeIntent (UC-42)', () => {
    it('splits met rate by who wrote the code and lists what is most often missed', () => {
        const cockpit = summarizeIntent([
            run({
                passed: true,
                author: { kind: 'person' },
                tasks: [task([], [{ change: 'pagination', evidence: [] }])],
            }),
            run({
                passed: false,
                author: { kind: 'agent', agent: 'Claude Code' },
                tasks: [
                    task([
                        {
                            requirement: 'empty state',
                            state: 'missing',
                            evidence: [],
                            confidence: 'high',
                            topic: 'empty_and_error_states',
                        },
                    ]),
                ],
            }),
            run({ outcome: 'skipped', skipReason: 'no_reference' }),
        ]);
        expect(cockpit.pullRequests).toBe(2);
        expect(cockpit.metRate).toBe(0.5);
        expect(cockpit.notInTaskRate).toBe(0.5);
        expect(cockpit.withoutTaskRate).toBeCloseTo(1 / 3);
        expect(cockpit.byAuthor).toEqual(
            expect.arrayContaining([
                { author: 'People', pullRequests: 1, metRate: 1 },
                { author: 'Claude Code', pullRequests: 1, metRate: 0 },
            ]),
        );
        expect(cockpit.mostMissed).toEqual([
            { topic: 'empty_and_error_states', pullRequests: 1 },
        ]);
        expect(cockpit.byTeam[0]).toMatchObject({
            teamId: 'team-1',
            pullRequests: 2,
        });
    });
});
