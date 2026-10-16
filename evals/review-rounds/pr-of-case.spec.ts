/* eslint-disable @typescript-eslint/no-require-imports */
const { cases } = require('./cases');
const { sequences } = require('./lifecycle');
const { baseTreeOf, hunksOf } = require('./pr-of-case');
const { inlineMirror, pullRequestFiles } = require('../shared/repo-mirror');

type Changed = { filename: string; patch?: string; patchWithLinesStr?: string };
type Case = { id: string; repo: Record<string, string>; changedFiles?: Changed[] };

const rounds: Case[] = [
    ...cases,
    ...sequences().flatMap((s: { id: string; rounds: Case[] }) =>
        s.rounds.map((r, i) => ({ ...r, id: `${s.id}:round-${i}` })),
    ),
];

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
    it.each(rounds.map((c) => [c.id, c] as const))(
        '%s: the base tree undoes exactly the case’s change',
        async (_id, c) => {
            const mirror = await inlineMirror(c.repo, { baseFiles: baseTreeOf(c) });
            try {
                const files = await pullRequestFiles(mirror.cloneUrl, mirror.base, mirror.branch);
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
            } finally {
                await mirror.cleanup();
            }
        },
        30_000,
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

    it('a hunk not found at the head fails as case data, never silently', () => {
        expect(() =>
            baseTreeOf({
                repo: { 'a.ts': 'x\n' },
                changedFiles: [{ filename: 'a.ts', patch: '@@ -1,1 +1,1 @@\n-y\n+z' }],
            }),
        ).toThrow(/case data/);
    });
});
