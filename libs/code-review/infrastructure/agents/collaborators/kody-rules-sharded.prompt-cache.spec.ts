import { judgeKodyRulesSharded, RunJudge } from './kody-rules-sharded.judge';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

const file = (filename: string, patch = '1 +x'): any => ({
    filename,
    patchWithLinesStr: patch,
    patch,
});

const RULES = [
    { uuid: 'ts', title: 'no any', rule: 'no any', path: '**/*.ts' },
    { uuid: 'md', title: 'title case', rule: 'title case', path: '**/*.md' },
    { uuid: 'py', title: 'no print', rule: 'no print', path: '**/*.py' },
];

type Call = Parameters<RunJudge>[0];

/** A runJudge whose calls settle only when the test says so. */
function controlledJudge() {
    const calls: Call[] = [];
    const started: string[] = [];
    const pending = new Map<
        string,
        { resolve: () => void; reject: (e: Error) => void }
    >();
    const answered = new Map<string, () => void>();
    let running = 0;
    let maxRunning = 0;
    const run: RunJudge = (args) => {
        calls.push(args);
        const name = args.filename ?? '__PR__';
        started.push(name);
        if (args.onAnswered) answered.set(name, args.onAnswered);
        running++;
        maxRunning = Math.max(maxRunning, running);
        return new Promise((resolve, reject) => {
            pending.set(name, {
                resolve: () => {
                    running--;
                    resolve([]);
                },
                reject: (e) => {
                    running--;
                    reject(e);
                },
            });
        });
    };
    const flush = () => new Promise((r) => setImmediate(r));
    return {
        run,
        calls,
        started,
        maxRunning: () => maxRunning,
        async finish(name: string) {
            await flush();
            pending.get(name)!.resolve();
            await flush();
        },
        /** The model answered; the shard's own follow-up work is still running. */
        async answer(name: string) {
            await flush();
            answered.get(name)!();
            await flush();
        },
        async fail(name: string) {
            await flush();
            pending.get(name)!.reject(new Error('boom'));
            await flush();
        },
        async finishAll() {
            for (let i = 0; i < 50; i++) {
                await flush();
                const next = [...pending.entries()].find(([n]) =>
                    started.includes(n),
                );
                if (!next) continue;
                pending.delete(next[0]);
                next[1].resolve();
            }
        },
    };
}

const instantJudge = () => {
    const calls: Call[] = [];
    const run: RunJudge = async (args) => {
        calls.push(args);
        return [];
    };
    return { run, calls };
};

const callFor = (calls: Call[], name: string | null) =>
    calls.find((c) => c.filename === name)!;

describe('judgeKodyRulesSharded — shared prompt prefix', () => {
    it('gives the shards of one rule set the same two nested prefixes: the rules, then the head', async () => {
        const { run, calls } = instantJudge();
        await judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('c.ts')],
            rules: RULES,
            runJudge: run,
            prTitle: 'Add things',
            prBody: 'Why we add things',
            concurrency: 1,
        } as any);
        const sets = calls.map((c) => JSON.stringify(c.cachePrefixes));
        expect(new Set(sets).size).toBe(1);
        const [rules, head] = calls[0].cachePrefixes!;
        expect(rules.startsWith('<Rules>')).toBe(true);
        expect(rules).toContain('</Rules>');
        // The rules part is shared across PRs: it stops before the PR intent.
        expect(rules).not.toContain('<PR title=');
        expect(head.startsWith(rules)).toBe(true);
        expect(
            head.slice(rules.length).startsWith('<PR title="Add things">'),
        ).toBe(true);
        for (const c of calls) {
            expect(c.user.startsWith(head)).toBe(true);
            expect(c.user.slice(head.length)).toMatch(
                /^<(File|FileContent) path="/,
            );
        }
    });

    it('gives one prefix when the PR has no title or description', async () => {
        const { run, calls } = instantJudge();
        await judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts')],
            rules: RULES,
            runJudge: run,
            concurrency: 1,
        } as any);
        const [only, ...rest] = callFor(calls, 'b.ts').cachePrefixes!;
        expect(rest).toEqual([]);
        expect(only).toContain('</Rules>');
        expect(callFor(calls, 'b.ts').user.startsWith(only)).toBe(true);
    });

    it('gives a shard alone with its rule set no prefix to mark', async () => {
        const { run, calls } = instantJudge();
        await judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('z.py')],
            rules: RULES,
            runJudge: run,
        } as any);
        expect(callFor(calls, 'z.py').cachePrefixes).toEqual([]);
        expect(callFor(calls, 'a.ts').cachePrefixes).toHaveLength(1);
    });

    it('gives the PR-scope shard no prefix to mark', async () => {
        const { run, calls } = instantJudge();
        await judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts')],
            rules: [
                ...RULES,
                {
                    uuid: 'pr',
                    title: 'one change',
                    rule: 'one change',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ],
            runJudge: run,
        } as any);
        expect(callFor(calls, null).cachePrefixes).toEqual([]);
    });

    it('splits different rule sets into different heads', async () => {
        const { run, calls } = instantJudge();
        await judgeKodyRulesSharded({
            changedFiles: [
                file('a.ts'),
                file('b.ts'),
                file('x.md'),
                file('y.md'),
            ],
            rules: RULES,
            runJudge: run,
            concurrency: 1,
        } as any);
        expect(callFor(calls, 'a.ts').cachePrefixes).toEqual(
            callFor(calls, 'b.ts').cachePrefixes,
        );
        expect(callFor(calls, 'x.md').cachePrefixes).toEqual(
            callFor(calls, 'y.md').cachePrefixes,
        );
        expect(callFor(calls, 'a.ts').cachePrefixes).not.toEqual(
            callFor(calls, 'x.md').cachePrefixes,
        );
    });

    it('reports how the shards were grouped and scheduled', async () => {
        const { run } = instantJudge();
        const res = await judgeKodyRulesSharded({
            changedFiles: [
                file('a.ts'),
                file('b.ts'),
                file('c.ts'),
                file('x.md'),
                file('y.md'),
                file('z.py'),
            ],
            rules: RULES,
            runJudge: run,
            concurrency: 1,
        } as any);
        expect(res.promptCacheStats).toEqual({
            fileShards: 6,
            groups: 3,
            sharedGroups: 2,
            siblings: 3,
            siblingsAfterLeader: 3,
            siblingsEarly: 0,
            idleWaits: 0,
            idleWaitMs: 0,
            leadersReleasedAtAnswer: 0,
            leaderHandovers: 0,
        });
    });
});

describe('judgeKodyRulesSharded — leader-first scheduling with a bounded wait', () => {
    const files = [
        file('a.ts'),
        file('x.md'),
        file('b.ts'),
        file('z.py'),
        file('c.ts'),
        file('y.md'),
    ];

    it('starts each shared group’s leader first, largest group first', async () => {
        const j = controlledJudge();
        // Smallest group first in file order, so only the size sort puts a.ts first.
        const done = judgeKodyRulesSharded({
            changedFiles: [
                file('z.py'),
                file('x.md'),
                file('a.ts'),
                file('y.md'),
                file('b.ts'),
                file('c.ts'),
            ],
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
        } as any);
        await new Promise((r) => setImmediate(r));
        expect(j.started).toEqual(['a.ts', 'x.md']);
        await j.finishAll();
        await done;
    });

    it('runs a sibling after its leader returned before starting more work', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: files,
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
        } as any);
        await j.finish('x.md');
        // x.md's sibling is ready and reads its cache: it goes before the singleton
        expect(j.started.slice(0, 3)).toEqual(['a.ts', 'x.md', 'y.md']);
        await j.finishAll();
        await done;
    });

    it('has a free worker wait for the running leader instead of sending its sibling at once', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('c.ts')],
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
            leaderWaitMs: 60_000,
        } as any);
        await new Promise((r) => setImmediate(r));
        expect(j.started).toEqual(['a.ts']);
        await j.finish('a.ts');
        // both siblings start once the leader answered, and both read its head
        expect(j.started).toEqual(['a.ts', 'b.ts', 'c.ts']);
        const head = callFor(j.calls, 'a.ts').cachePrefixes;
        expect(head).toHaveLength(1);
        expect(callFor(j.calls, 'b.ts').cachePrefixes).toEqual(head);
        expect(callFor(j.calls, 'c.ts').cachePrefixes).toEqual(head);
        await j.finishAll();
        const res = await done;
        expect(res.promptCacheStats.siblingsAfterLeader).toBe(2);
        expect(res.promptCacheStats.siblingsEarly).toBe(0);
        expect(res.promptCacheStats.idleWaits).toBe(1);
    });

    it('releases the siblings when the leader’s model answers, before its follow-up work ends', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts')],
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
            leaderWaitMs: 60_000,
        } as any);
        await j.answer('a.ts');
        // a.ts is still checking evidence; b.ts reads the head it wrote anyway
        expect(j.started).toEqual(['a.ts', 'b.ts']);
        expect(callFor(j.calls, 'b.ts').cachePrefixes).toHaveLength(1);
        await j.finishAll();
        const res = await done;
        expect(res.promptCacheStats.leadersReleasedAtAnswer).toBe(1);
    });

    describe('when the leader runs past the wait', () => {
        beforeEach(() => jest.useFakeTimers({ doNotFake: ['setImmediate'] }));
        afterEach(() => jest.useRealTimers());

        it('sends a waiting sibling unmarked, so it pays no write nobody reads', async () => {
            const j = controlledJudge();
            const done = judgeKodyRulesSharded({
                changedFiles: [file('a.ts'), file('b.ts'), file('c.ts')],
                rules: RULES,
                runJudge: j.run,
                concurrency: 2,
                leaderWaitMs: 5_000,
            } as any);
            await new Promise((r) => setImmediate(r));
            expect(j.started).toEqual(['a.ts']);
            await jest.advanceTimersByTimeAsync(4_999);
            expect(j.started).toEqual(['a.ts']);
            await jest.advanceTimersByTimeAsync(1);
            expect(j.started).toEqual(['a.ts', 'b.ts']);
            expect(callFor(j.calls, 'b.ts').cachePrefixes).toEqual([]);
            await j.finish('a.ts');
            await j.finishAll();
            const res = await done;
            expect(callFor(j.calls, 'c.ts').cachePrefixes).toEqual(
                callFor(j.calls, 'a.ts').cachePrefixes,
            );
            expect(res.promptCacheStats.siblingsEarly).toBe(1);
            expect(res.promptCacheStats.siblingsAfterLeader).toBe(1);
        });

        it('does not restart the wait when an answer frees no work', async () => {
            const j = controlledJudge();
            const done = judgeKodyRulesSharded({
                changedFiles: [file('x.md'), file('y.md'), file('z.py')],
                rules: RULES,
                runJudge: j.run,
                concurrency: 3,
                leaderWaitMs: 5_000,
            } as any);
            await new Promise((r) => setImmediate(r));
            expect(j.started).toEqual(['x.md', 'z.py']);
            await jest.advanceTimersByTimeAsync(3_000);
            // z.py is alone: its answer releases nobody
            await j.answer('z.py');
            await jest.advanceTimersByTimeAsync(1_999);
            expect(j.started).toEqual(['x.md', 'z.py']);
            await jest.advanceTimersByTimeAsync(1);
            expect(j.started).toEqual(['x.md', 'z.py', 'y.md']);
            await j.finishAll();
            await done;
        });

        it('starts a fresh wait once the worker has run a shard', async () => {
            const j = controlledJudge();
            // Two groups, three workers: the third waits on two running leaders.
            const done = judgeKodyRulesSharded({
                changedFiles: [
                    file('a.ts'),
                    file('b.ts'),
                    file('x.md'),
                    file('y.md'),
                    file('z.md'),
                ],
                rules: RULES,
                runJudge: j.run,
                concurrency: 3,
                leaderWaitMs: 5_000,
            } as any);
            await new Promise((r) => setImmediate(r));
            expect(j.started).toEqual(['x.md', 'a.ts']);
            await jest.advanceTimersByTimeAsync(3_000);
            await j.answer('a.ts');
            // the idle worker takes a.ts's ready sibling at once
            expect(j.started).toEqual(['x.md', 'a.ts', 'b.ts']);
            await j.finish('b.ts');
            // a new idle stretch starts now: x.md's siblings wait a full 5 s
            await jest.advanceTimersByTimeAsync(4_999);
            expect(j.started).toHaveLength(3);
            await jest.advanceTimersByTimeAsync(1);
            expect(j.started).toEqual(['x.md', 'a.ts', 'b.ts', 'y.md']);
            await j.finishAll();
            await done;
        });
    });

    it('never waits when the wait is turned off', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('c.ts')],
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
            leaderWaitMs: 0,
        } as any);
        await new Promise((r) => setImmediate(r));
        expect(j.started).toEqual(['a.ts', 'b.ts']);
        expect(callFor(j.calls, 'b.ts').cachePrefixes).toEqual([]);
        await j.finishAll();
        await done;
    });

    it('hands the lead to the next sibling when the leader fails, and the others keep waiting', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: [
                file('a.ts'),
                file('b.ts'),
                file('c.ts'),
                file('d.ts'),
            ],
            rules: RULES,
            runJudge: j.run,
            concurrency: 3,
            leaderWaitMs: 60_000,
        } as any);
        await new Promise((r) => setImmediate(r));
        expect(j.started).toEqual(['a.ts']);
        await j.fail('a.ts');
        // a.ts wrote nothing: b.ts takes the lead alone, marked, to write it
        expect(j.started).toEqual(['a.ts', 'b.ts']);
        const head = callFor(j.calls, 'b.ts').cachePrefixes;
        expect(head).toHaveLength(1);
        await j.finish('b.ts');
        expect(j.started).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
        expect(callFor(j.calls, 'c.ts').cachePrefixes).toEqual(head);
        expect(callFor(j.calls, 'd.ts').cachePrefixes).toEqual(head);
        await j.finishAll();
        const res = await done;
        expect(res.promptCacheStats.leaderHandovers).toBe(1);
        expect(res.shardsErrored).toBe(1);
    });

    it('marks the siblings of a leader that failed, so one of them writes the head', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts')],
            rules: RULES,
            runJudge: j.run,
            concurrency: 1,
        } as any);
        await j.fail('a.ts');
        await j.finishAll();
        await done;
        expect(callFor(j.calls, 'b.ts').cachePrefixes).toHaveLength(1);
    });

    it('never runs more shards at once than the concurrency limit', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: files,
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
        } as any);
        await j.finishAll();
        await done;
        expect(j.maxRunning()).toBeLessThanOrEqual(2);
        expect(j.started.sort()).toEqual([
            'a.ts',
            'b.ts',
            'c.ts',
            'x.md',
            'y.md',
            'z.py',
        ]);
    });

    it('still runs the siblings of a leader that failed', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('c.ts')],
            rules: RULES,
            runJudge: j.run,
            concurrency: 1,
        } as any);
        await j.fail('a.ts');
        await j.finishAll();
        const res = await done;
        expect(j.started).toEqual(['a.ts', 'b.ts', 'c.ts']);
        expect(res.shardsRun).toBe(3);
        expect(res.shardsErrored).toBe(1);
    });

    it('returns violations in file order whatever order the shards ran in', async () => {
        const run: RunJudge = async ({ filename }) => [
            {
                ruleId: 1,
                relevantLinesStart: 1,
                suggestionContent: filename!,
                oneSentenceSummary: 's',
                improvedCode: 'y',
                existingCode: 'x',
            } as any,
        ];
        const res = await judgeKodyRulesSharded({
            changedFiles: files,
            rules: RULES,
            runJudge: run,
            concurrency: 1,
        } as any);
        expect(res.violations.map((v) => v.relevantFile)).toEqual([
            'a.ts',
            'x.md',
            'b.ts',
            'z.py',
            'c.ts',
            'y.md',
        ]);
    });
});
