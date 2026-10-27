/* eslint-disable @typescript-eslint/no-require-imports */
const { cases } = require('./cases');
const { sequences } = require('./lifecycle');
const { baseTreeOf, hunksOf, decisionsOf } = require('./pr-of-case');
const { inlineMirror, pullRequestFiles } = require('../shared/repo-mirror');

type Changed = { filename: string; patch?: string };
type Case = { id: string; repo: Record<string, string>; changedFiles?: Changed[] };

const rounds: Case[] = [
    ...cases,
    ...sequences().flatMap((s: { id: string; rounds: Case[] }) =>
        s.rounds.map((r, i) => ({ ...r, id: `${s.id}:round-${i}` })),
    ),
];

// The base tree and the PR are a function of the repository and the changed
// files alone, and lifecycle rounds repeat cases verbatim: each distinct change
// becomes one git mirror, named after every case that carries it.
const distinct = [
    ...rounds
        .reduce((byChange, c) => {
            const key = JSON.stringify([c.repo, c.changedFiles || []]);
            const seen = byChange.get(key);
            byChange.set(key, seen ? { ...seen, ids: [...seen.ids, c.id] } : { c, ids: [c.id] });
            return byChange;
        }, new Map<string, { c: Case; ids: string[] }>())
        .values(),
].map(({ c, ids }) => [ids.join(', '), c] as const);

// What a change does to a file, line by line: +1 per line added, -1 per line
// removed. git may align a diff differently from the case's hunk (a swap of two
// lines), never with a different net change.
const net = (pairs: [string, number][]) => {
    const m = new Map<string, number>();
    for (const [text, d] of pairs) m.set(text, (m.get(text) || 0) + d);
    return [...m].filter(([, v]) => v).sort();
};

describe('a review-rounds case as a pull request', () => {
    // The agents read the PR the platform lists between the base and the head
    // branch. That diff must be the change each case was written to show.
    // Each case spends ~10 git processes: build every PR up front, 16 at a time.
    const prs = new Map<string, Promise<{ filename: string; patch?: string }[]>>();
    const prOf = async (c: Case) => {
        const mirror = await inlineMirror(c.repo, { baseFiles: baseTreeOf(c) });
        try {
            return await pullRequestFiles(mirror.cloneUrl, mirror.base, mirror.branch);
        } finally {
            await mirror.cleanup();
        }
    };
    beforeAll(async () => {
        const queue = [...distinct];
        const worker = async () => {
            for (let next = queue.shift(); next; next = queue.shift()) {
                const pr = prOf(next[1]);
                prs.set(next[0], pr);
                await pr.catch(() => undefined);
            }
        };
        await Promise.all(Array.from({ length: 16 }, worker));
    }, 300_000);

    it.each(distinct)(
        '%s: the base tree undoes exactly the case’s change',
        async (id, c) => {
            const files = await prs.get(id)!;
            const changed = c.changedFiles || [];
            expect(files.map((f: { filename: string }) => f.filename).sort()).toEqual(
                [...new Set(changed.map((f) => f.filename))].sort(),
            );
            for (const file of files) {
                const hunks = changed.filter((f) => f.filename === file.filename).flatMap(hunksOf);
                const want = net(
                    hunks.flatMap((h: { head: string[]; base: string[] }) => [
                        ...h.head.map((t): [string, number] => [t, 1]),
                        ...h.base.map((t): [string, number] => [t, -1]),
                    ]),
                );
                const got = net(
                    String(file.patch)
                        .split('\n')
                        .filter((l) => /^[+-]/.test(l))
                        .map((l): [string, number] => [l.slice(1), l[0] === '+' ? 1 : -1]),
                );
                expect(got).toEqual(want);
            }
        },
    );

    it('a file the PR adds is absent from the base; one it removes is present', () => {
        const base = baseTreeOf({
            repo: { 'a.ts': 'export const a = 1;\n' },
            changedFiles: [
                { filename: 'a.ts', patch: '@@ -0,0 +1,1 @@\n+export const a = 1;' },
                { filename: 'b.ts', patch: '@@ -1,1 +0,0 @@\n-export const b = 2;' },
            ],
        });
        expect(base).toEqual({ 'b.ts': 'export const b = 2;\n' });
    });

    // The repeat check matches on the code an earlier suggestion pointed at,
    // which the decision store keeps for every file-level suggestion.
    it('an earlier suggestion carries the code it pointed at, as the decision store keeps it', () => {
        const c = {
            repo: { 'a.ts': 'one\nTWO\nthree\n' },
            changedFiles: [{ filename: 'a.ts', patch: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three' }],
            previousDecisions: [
                { suggestionId: 'hand-written', relevantFile: 'a.ts', relevantLinesStart: 2, relevantLinesEnd: 3 },
                { suggestionId: 'stored', relevantFile: 'a.ts', relevantLinesStart: 2, relevantLinesEnd: 2, existingCode: undefined },
                { suggestionId: 'elsewhere', relevantFile: 'b.ts', relevantLinesStart: 1, relevantLinesEnd: 1 },
            ],
        };
        const [handWritten, stored, elsewhere] = decisionsOf(c);
        expect(handWritten.existingCode).toBe('two\nthree');
        expect(stored.existingCode).toBeUndefined();
        expect('existingCode' in elsewhere).toBe(false);
    });

    it('a hunk not found at the head fails as case data, never silently', () => {
        expect(() =>
            baseTreeOf({
                repo: { 'a.ts': 'x\n' },
                changedFiles: [{ filename: 'a.ts', patch: '@@ -1,1 +1,1 @@\n-y\n+z' }],
            }),
        ).toThrow(/case data/);
    });
});
