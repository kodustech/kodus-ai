import { createTwoFilesPatch } from 'diff';

import {
    AZURE_FILE_DIFF_SYNC_BUDGET_MS,
    createFilePatchYielding,
} from './azure-file-patch';

// Longest the loop may be held: the synchronous attempt plus scheduling slack.
const MAX_GAP_MS = AZURE_FILE_DIFF_SYNC_BUDGET_MS + 150;

// A large file whose every line changed: Myers' O(N·D) worst case, the
// shape that froze workers for minutes on Azure Repos PRs.
function fullyChangedFile(lines: number) {
    const before = Array.from(
        { length: lines },
        (_, i) => `const value${i} = compute(${i}, "before");`,
    ).join('\n');
    const after = Array.from(
        { length: lines },
        (_, i) => `let renamed${i * 7} = other(${i * 3}, "after");`,
    ).join('\n');
    return { before, after };
}

/** Longest gap between ticks of a 10ms interval while `work` runs. */
async function maxEventLoopGap<T>(
    work: () => Promise<T>,
): Promise<{ result: T; maxGapMs: number }> {
    let last = Date.now();
    let maxGapMs = 0;
    const ticker = setInterval(() => {
        const now = Date.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
    }, 10);
    try {
        const result = await work();
        return { result, maxGapMs };
    } finally {
        clearInterval(ticker);
    }
}

describe('createFilePatchYielding', () => {
    jest.setTimeout(60_000);

    it.each([
        ['an edited file', 'a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n'],
        ['an added file', '', 'new line 1\nnew line 2\n'],
        ['a removed file', 'old line 1\nold line 2\n', ''],
        ['no change', 'same\n', 'same\n'],
    ])(
        'produces the same patch as the synchronous call for %s',
        async (_l, a, b) => {
            const expected = createTwoFilesPatch(
                'f.ts',
                'f.ts',
                a,
                b,
                'base',
                'head',
                {
                    context: 3,
                },
            );
            await expect(
                createFilePatchYielding('f.ts', 'f.ts', a, b, 'base', 'head'),
            ).resolves.toBe(expected);
        },
    );

    it('produces the same patch for a large realistic edit', async () => {
        const base = Array.from({ length: 3_000 }, (_, i) => `line ${i}`);
        const head = base.map((l, i) => (i % 97 === 0 ? `${l} changed` : l));
        const a = base.join('\n');
        const b = head.join('\n');
        const expected = createTwoFilesPatch('x.ts', 'x.ts', a, b, 'b', 'h', {
            context: 3,
        });
        await expect(
            createFilePatchYielding('x.ts', 'x.ts', a, b, 'b', 'h'),
        ).resolves.toBe(expected);
    });

    it('keeps the latency of the synchronous call on a large added file', async () => {
        // The yielding mode costs ~1ms per edit step: on its own it turned
        // this ~15ms diff into ~11s.
        const added = Array.from(
            { length: 10_000 },
            (_, i) => `line ${i}`,
        ).join('\n');
        const expected = createTwoFilesPatch(
            'n.ts',
            'n.ts',
            '',
            added,
            'b',
            'h',
            {
                context: 3,
            },
        );
        const started = Date.now();
        await expect(
            createFilePatchYielding('n.ts', 'n.ts', '', added, 'b', 'h'),
        ).resolves.toBe(expected);
        expect(Date.now() - started).toBeLessThan(1_000);
    });

    it('treats a zero or invalid timeout as the default', async () => {
        for (const timeout of [0, -1, Number.NaN]) {
            await expect(
                createFilePatchYielding(
                    'f.ts',
                    'f.ts',
                    'a\n',
                    'b\n',
                    'x',
                    'y',
                    timeout,
                ),
            ).resolves.toEqual(expect.stringContaining('@@'));
        }
    });

    it('keeps the event loop responsive on a file the sync call blocks on', async () => {
        const { before, after } = fullyChangedFile(5_000);

        // Reference: the synchronous call holds the thread for the whole diff.
        const syncStart = Date.now();
        createTwoFilesPatch('big.ts', 'big.ts', before, after, 'b', 'h', {
            context: 3,
        });
        const syncMs = Date.now() - syncStart;

        const { result, maxGapMs } = await maxEventLoopGap(() =>
            createFilePatchYielding(
                'big.ts',
                'big.ts',
                before,
                after,
                'b',
                'h',
            ),
        );

        expect(result).toEqual(expect.stringContaining('@@'));
        // The sync call blocks for its whole duration; the yielding one never
        // holds the loop for more than a small slice of it.
        expect(syncMs).toBeGreaterThan(3 * MAX_GAP_MS);
        expect(maxGapMs).toBeLessThan(MAX_GAP_MS);
    });

    it('gives up on a pathological file instead of running unbounded', async () => {
        const { before, after } = fullyChangedFile(8_000);
        const started = Date.now();

        const { result, maxGapMs } = await maxEventLoopGap(() =>
            createFilePatchYielding(
                'big.ts',
                'big.ts',
                before,
                after,
                'b',
                'h',
                500,
            ),
        );

        expect(result).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(maxGapMs).toBeLessThan(MAX_GAP_MS);
    });
});
