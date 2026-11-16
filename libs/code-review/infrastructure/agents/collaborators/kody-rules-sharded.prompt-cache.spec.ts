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
    let running = 0;
    let maxRunning = 0;
    const run: RunJudge = (args) => {
        calls.push(args);
        const name = args.filename ?? '__PR__';
        started.push(name);
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
    it('gives the shards of one rule set the same cachePrefix, a head of their user turn', async () => {
        const { run, calls } = instantJudge();
        await judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('c.ts')],
            rules: RULES,
            runJudge: run,
            prTitle: 'Add things',
            prBody: 'Why we add things',
        } as any);
        const prefixes = calls.map((c) => c.cachePrefix);
        expect(new Set(prefixes).size).toBe(1);
        const head = prefixes[0]!;
        expect(head.startsWith('<Rules>')).toBe(true);
        expect(head).toContain('</Rules>');
        expect(head).toContain('<PR title="Add things">');
        for (const c of calls) {
            expect(c.user.startsWith(head)).toBe(true);
            expect(c.user.slice(head.length)).toMatch(
                /^<(File|FileContent) path="/,
            );
        }
    });

    it('gives a shard alone with its rule set no cachePrefix', async () => {
        const { run, calls } = instantJudge();
        await judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('z.py')],
            rules: RULES,
            runJudge: run,
        } as any);
        expect(callFor(calls, 'z.py').cachePrefix).toBeUndefined();
        expect(callFor(calls, 'a.ts').cachePrefix).toBeDefined();
    });

    it('gives the PR-scope shard no cachePrefix', async () => {
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
        expect(callFor(calls, null).cachePrefix).toBeUndefined();
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
        } as any);
        expect(callFor(calls, 'a.ts').cachePrefix).toBe(
            callFor(calls, 'b.ts').cachePrefix,
        );
        expect(callFor(calls, 'x.md').cachePrefix).toBe(
            callFor(calls, 'y.md').cachePrefix,
        );
        expect(callFor(calls, 'a.ts').cachePrefix).not.toBe(
            callFor(calls, 'x.md').cachePrefix,
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
        });
    });
});

describe('judgeKodyRulesSharded — leader-first scheduling that never idles', () => {
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
        const done = judgeKodyRulesSharded({
            changedFiles: files,
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
        } as any);
        await j.finish('a.ts').catch(() => undefined);
        expect(j.started.slice(0, 2)).toEqual(['a.ts', 'x.md']);
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

    it('starts a waiting sibling rather than leave a worker idle', async () => {
        const j = controlledJudge();
        const done = judgeKodyRulesSharded({
            changedFiles: [file('a.ts'), file('b.ts'), file('c.ts')],
            rules: RULES,
            runJudge: j.run,
            concurrency: 2,
        } as any);
        await new Promise((r) => setImmediate(r));
        // a.ts is the leader and still running; the second worker takes b.ts anyway
        expect(j.started).toEqual(['a.ts', 'b.ts']);
        await j.finishAll();
        const res = await done;
        expect(res.promptCacheStats.siblingsEarly).toBe(1);
        expect(res.promptCacheStats.siblingsAfterLeader).toBe(1);
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
