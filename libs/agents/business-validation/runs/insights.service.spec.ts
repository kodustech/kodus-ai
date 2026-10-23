import { summarizeIntent, summarizeStatus } from './insights';
import { BusinessLogicInsightsService } from './insights.service';
import type { ValidationRunRecord } from './validation-run.repository';

/**
 * The service reads each PR's newest run and a few others from Mongo instead
 * of every run. A repository that answers those queries from a list in
 * memory shows the summaries come out as they would over every run.
 */
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 20, 12, minutes, 0));

let seq = 0;
const run = (overrides: Partial<ValidationRunRecord>): ValidationRunRecord => ({
    id: String(++seq),
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    pullRequestNumber: 1,
    door: 'auto',
    outcome: 'validated',
    references: [],
    attempts: [],
    trackers: ['Linear'],
    tasks: [],
    unseenFiles: [],
    createdAt: at(0),
    ...overrides,
});

const task = (requirements: any[] = [], outOfScope: any[] = []) => ({
    tracker: 'Linear',
    id: 'SAA-96',
    readAt: '2026-10-20T12:00:00Z',
    passed: false,
    requirements,
    outOfScope,
});

const down = (n: number, minutes: number) =>
    run({
        pullRequestNumber: n,
        outcome: 'skipped',
        skipReason: 'tracker_unavailable',
        attempts: [{ reference: 'SAA-1', tracker: 'Linear', status: 'error' }],
        createdAt: at(minutes),
    });

const RUNS: ValidationRunRecord[] = [
    run({
        pullRequestNumber: 1,
        passed: false,
        author: { kind: 'agent', agent: 'Claude Code' },
        tasks: [task([{ requirement: 'a', state: 'missing', evidence: [] }])],
        createdAt: at(1),
    }),
    run({
        pullRequestNumber: 1,
        passed: true,
        tasks: [
            task([
                {
                    requirement: 'a',
                    state: 'missing',
                    evidence: [],
                    accepted: { by: 'nina', at: '' },
                },
            ]),
        ],
        createdAt: at(5),
    }),
    run({
        pullRequestNumber: 2,
        passed: false,
        author: { kind: 'person' },
        tasks: [task([], [{ change: 'x' }])],
        createdAt: at(2),
    }),
    run({
        pullRequestNumber: 3,
        outcome: 'skipped',
        skipReason: 'no_capable_tracker',
        references: [
            {
                kind: 'git_issue',
                id: '12',
                raw: '#12',
                source: 'body',
                intent: 'closes',
            },
        ],
        createdAt: at(3),
    }),
    run({
        pullRequestNumber: undefined,
        repositoryId: undefined,
        door: 'cli',
        tasks: [{ ...task(), id: 'SAA-200' }],
        createdAt: at(4),
    }),
    down(4, 6),
    down(5, 7),
    down(4, 8),
];

/** The repository's queries, answered from `RUNS` the way Mongo would. */
const repository = {
    latestPerPullRequest: async (
        _org: string,
        range: { from: Date; to?: Date },
    ) => {
        const inRange = RUNS.filter(
            (r) =>
                r.pullRequestNumber !== undefined &&
                r.repositoryId &&
                r.createdAt >= range.from &&
                (!range.to || r.createdAt <= range.to),
        ).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        const groups = new Map<string, ValidationRunRecord[]>();
        for (const r of inRange) {
            const key = `${r.repositoryId}#${r.pullRequestNumber}`;
            groups.set(key, [...(groups.get(key) ?? []), r]);
        }
        return [...groups.values()].map((group) => ({
            ...group[0],
            firstAuthor: [...group].reverse().find((r) => r.author)?.author,
        }));
    },
    statusSignals: async () => {
        const newest = [...RUNS].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );
        const unavailable = (r: ValidationRunRecord) =>
            r.outcome === 'skipped' && r.skipReason === 'tracker_unavailable';
        const answered = newest.find(
            (r) =>
                r.outcome !== 'skipped' ||
                (r.skipReason !== 'tracker_unavailable' &&
                    r.attempts.some((a) => a.status !== 'error')),
        );
        const firstFailure = [...newest]
            .reverse()
            .find(
                (r) =>
                    unavailable(r) &&
                    (!answered || r.createdAt > answered.createdAt),
            );
        return [
            newest.find((r) => r.tasks.length),
            newest.find(unavailable),
            answered,
            ...newest
                .filter(
                    (r) =>
                        r.references.some((ref) => ref.kind === 'git_issue') &&
                        r.attempts.some((a) => a.status === 'found'),
                )
                .slice(0, 20),
            firstFailure,
        ].filter((r): r is ValidationRunRecord => !!r);
    },
    forPullRequest: jest.fn(),
};

describe('BusinessLogicInsightsService', () => {
    const service = new BusinessLogicInsightsService(repository as any);
    const realNow = Date.now;
    beforeAll(() => {
        Date.now = () => at(30).getTime();
    });
    afterAll(() => {
        Date.now = realNow;
    });

    it('summarizes the card from the newest run per PR and a few others, as from every run', async () => {
        const everyRun = [...RUNS].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
        );
        await expect(service.status('org-1')).resolves.toEqual(
            summarizeStatus(everyRun),
        );
    });

    it("summarizes the Cockpit per PR, crediting each PR to its first run's author", async () => {
        const cockpit = await service.intent('org-1', {
            startDate: at(0),
            endDate: at(30),
        });
        expect(cockpit).toMatchObject(
            summarizeIntent(
                RUNS.filter((r) => r.createdAt <= at(30)).sort(
                    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
                ),
            ),
        );
        expect(cockpit.byAuthor).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ author: 'Claude Code' }),
            ]),
        );
    });
});
