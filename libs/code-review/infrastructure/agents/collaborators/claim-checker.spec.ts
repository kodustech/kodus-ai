import { SHARD_CONCURRENCY_DEFAULT } from './kody-rules-sharded.judge';
import { checkClaims, readClaim } from './claim-checker';
import { RepoLookupUnavailableError, type RepoLookup } from './repo-lookup';
import type { ShardViolation } from './kody-rules-sharded.judge';

// Derived from spec.md's P1 claim story — the checker is the first merit gate
// this path has ever had, so every assertion below is a spec AC, not a
// description of the implementation:
//   KRC-03  a violation carrying a verifiable claim gets the matching check
//   KRC-04  a check that contradicts the claim discards the finding
//   KRC-05  a verifiable claim + unavailable lookup discards the finding
//   KRC-07  checks are bounded to the shard concurrency limit
//   KRC-08  a check over its time budget is unverifiable, never confirmed
//   KRC-09  a malformed or empty claim is `none` and publishes unchanged
//   KRC-21  a claim naming an empty/whitespace target is `none`
//   edge    a symbol whose only matches are the finding's own lines keeps it

const violation = (over: Partial<ShardViolation> = {}): ShardViolation => ({
    ruleUuid: 'r1',
    relevantFile: 'src/orders/order-mapper.ts',
    relevantLinesStart: 3,
    relevantLinesEnd: 3,
    suggestionContent: 'WHAT/WHY/HOW',
    ...over,
});

interface FakeLookupOptions {
    available?: boolean;
    unavailableReason?: string;
    grep?: (pattern: string) => Promise<string> | string;
    exists?: (path: string) => Promise<boolean> | boolean;
}

const fakeLookup = (
    opts: FakeLookupOptions = {},
): RepoLookup & { grepCalls: string[] } => {
    const grepCalls: string[] = [];
    const available = opts.available ?? true;
    return {
        get available() {
            return available;
        },
        get unavailableReason() {
            return available ? '' : (opts.unavailableReason ?? 'null sandbox');
        },
        grepCalls,
        stats: { grep: 0, read: 0, exists: 0, failures: 0 },
        async grep(pattern: string) {
            grepCalls.push(pattern);
            if (!opts.grep) return 'No matches found.';
            return opts.grep(pattern);
        },
        async read() {
            throw new Error('not used');
        },
        async exists(path: string) {
            if (!opts.exists) return false;
            return opts.exists(path);
        },
        async probe() {},
    } as RepoLookup & { grepCalls: string[] };
};

describe('readClaim — what a violation actually claims', () => {
    it('reads a well-formed unused claim', () => {
        expect(
            readClaim(
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
            ),
        ).toEqual({ kind: 'unused', symbol: 'formatDate', path: undefined });
    });

    it('treats an absent claim as none', () => {
        expect(readClaim(violation()).kind).toBe('none');
    });

    it('treats an unused claim with a whitespace-only symbol as none (KRC-21)', () => {
        expect(
            readClaim(
                violation({ claimKind: 'unused', claimSymbol: '   ' }),
            ).kind,
        ).toBe('none');
    });

    it('treats a missing claim with no path as none (KRC-21)', () => {
        expect(
            readClaim(
                violation({ claimKind: 'missing', claimSymbol: 'thing' }),
            ).kind,
        ).toBe('none');
    });

    it('treats an explicit none as none', () => {
        expect(
            readClaim(
                violation({ claimKind: 'none', claimSymbol: 'formatDate' }),
            ).kind,
        ).toBe('none');
    });
});

describe('checkClaims — unused (KRC-03, KRC-04)', () => {
    it('drops a finding whose symbol is used elsewhere in the repository', async () => {
        // The #1724 shape: the import is on line 3, the real use is on line 24,
        // twenty lines below the shard's window.
        const lookup = fakeLookup({
            grep: () =>
                'src/orders/order-mapper.ts:3:import { formatDate }\nsrc/orders/order-mapper.ts:24:  return formatDate(x);',
        });
        const v = violation({ claimKind: 'unused', claimSymbol: 'formatDate' });

        const res = await checkClaims({
            violations: [v],
            changedFiles: [{ filename: 'src/orders/order-mapper.ts' }],
            lookup,
        });

        expect(res.kept).toEqual([]);
        expect(res.dropped).toHaveLength(1);
        expect(res.dropped[0].violation).toBe(v);
        expect(res.dropped[0].reason).toContain('formatDate');
        expect(res.dropped[0].reason).toContain(
            'src/orders/order-mapper.ts:24',
        );
    });

    it('drops a finding whose symbol is used in another file', async () => {
        const lookup = fakeLookup({
            grep: () => 'src/invoices/print.ts:8:  formatDate(d)',
        });
        const res = await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped).toHaveLength(1);
    });

    it('keeps a finding whose symbol matches nowhere', async () => {
        const lookup = fakeLookup({ grep: () => 'No matches found.' });
        const res = await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(res.dropped).toEqual([]);
    });

    it('keeps the finding when the only matches lie inside its own lines', async () => {
        // Spec edge case: the import line IS a match for its own symbol, and
        // refuting the finding with the finding is not a check.
        const lookup = fakeLookup({
            grep: () =>
                'src/orders/order-mapper.ts:3:import { formatDate } from "../shared/date";',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'unused',
                    claimSymbol: 'formatDate',
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(res.dropped).toEqual([]);
    });

    it('counts a match just past the finding range as elsewhere', async () => {
        const lookup = fakeLookup({
            grep: () => 'src/orders/order-mapper.ts:6:  formatDate(x)',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'unused',
                    claimSymbol: 'formatDate',
                    relevantLinesStart: 3,
                    relevantLinesEnd: 5,
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.dropped).toHaveLength(1);
    });

    it('searches the symbol literally, not as a regex', async () => {
        const lookup = fakeLookup();
        await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'find(x)' }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(lookup.grepCalls).toEqual(['find\\(x\\)']);
    });
});

describe('checkClaims — missing (KRC-03, KRC-04)', () => {
    it('drops a finding claiming a path is missing when the repository has it', async () => {
        const lookup = fakeLookup({ exists: () => true });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'missing',
                    claimPath: 'src/orders/order-mapper.spec.ts',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('it exists in the repository');
    });

    it('drops a finding claiming a path is missing when this PR changes it', async () => {
        const lookup = fakeLookup({ exists: () => false });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'missing',
                    claimPath: './src/orders/order-mapper.spec.ts',
                }),
            ],
            changedFiles: [
                { filename: 'src/orders/order-mapper.spec.ts' },
                { filename: 'src/orders/order-mapper.ts' },
            ],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('this PR changes it');
    });

    it('keeps a finding whose claimed path is genuinely absent', async () => {
        const lookup = fakeLookup({ exists: () => false });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'missing',
                    claimPath: 'src/orders/order-mapper.spec.ts',
                }),
            ],
            changedFiles: [{ filename: 'src/orders/order-mapper.ts' }],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(res.dropped).toEqual([]);
    });
});

describe('checkClaims — duplicate (KRC-03, KRC-04)', () => {
    it('keeps a finding when the symbol it says already exists does exist elsewhere', async () => {
        const lookup = fakeLookup({
            grep: () => 'src/shared/date.ts:12:export function formatDate(',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'duplicate',
                    claimSymbol: 'formatDate',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(res.dropped).toEqual([]);
    });

    it('drops a finding claiming a duplicate of something that exists nowhere else', async () => {
        const lookup = fakeLookup({ grep: () => 'No matches found.' });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'duplicate',
                    claimSymbol: 'formatDate',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain(
            'exists nowhere else in the repository',
        );
    });

    it('does not let the finding own lines stand in as the pre-existing helper', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'src/orders/order-mapper.ts:3:function formatDate(d) {',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    claimKind: 'duplicate',
                    claimSymbol: 'formatDate',
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped).toHaveLength(1);
    });
});

describe('checkClaims — no claim is published unchanged (KRC-09, KRC-21)', () => {
    it('publishes a finding with no claim without touching the repository', async () => {
        const lookup = fakeLookup();
        const v = violation();
        const res = await checkClaims({
            violations: [v],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([v]);
        expect(lookup.grepCalls).toEqual([]);
    });

    it('publishes a finding whose claim names an empty symbol', async () => {
        const lookup = fakeLookup();
        const res = await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: '   ' }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(lookup.grepCalls).toEqual([]);
    });

    it('publishes a claim-free finding even when the lookup is unavailable', async () => {
        const lookup = fakeLookup({ available: false });
        const res = await checkClaims({
            violations: [violation()],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(res.dropped).toEqual([]);
    });
});

describe('checkClaims — fails closed (KRC-05, KRC-08)', () => {
    it('drops every verifiable claim when the lookup is unavailable, and keeps the rest', async () => {
        const lookup = fakeLookup({
            available: false,
            unavailableReason: 'null sandbox',
        });
        const unchecked = violation({ ruleUuid: 'r-none' });
        const res = await checkClaims({
            violations: [
                violation({
                    ruleUuid: 'r-unused',
                    claimKind: 'unused',
                    claimSymbol: 'formatDate',
                }),
                violation({
                    ruleUuid: 'r-missing',
                    claimKind: 'missing',
                    claimPath: 'src/x.spec.ts',
                }),
                unchecked,
            ],
            changedFiles: [],
            lookup,
        });

        expect(res.kept).toEqual([unchecked]);
        expect(res.dropped.map((d) => d.violation.ruleUuid)).toEqual([
            'r-unused',
            'r-missing',
        ]);
        for (const d of res.dropped) {
            expect(d.reason).toContain('unverifiable');
            expect(d.reason).toContain('null sandbox');
        }
    });

    it('drops the finding when a check exceeds its time budget', async () => {
        const lookup = fakeLookup({
            grep: () => new Promise<string>(() => {}),
        });
        const res = await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
            ],
            changedFiles: [],
            lookup,
            timeoutMs: 5,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('unverifiable');
        expect(res.dropped[0].reason).toContain('5ms budget');
    });

    it('drops the finding when the lookup throws mid-review, without the throw escaping', async () => {
        const lookup = fakeLookup({
            grep: () => {
                throw new RepoLookupUnavailableError(
                    'grep "formatDate"',
                    'null sandbox',
                );
            },
        });
        const other = violation({ ruleUuid: 'r-none' });
        const res = await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
                other,
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.dropped).toHaveLength(1);
        expect(res.dropped[0].reason).toContain('unverifiable');
        // the rest of the shard's findings survive the failure
        expect(res.kept).toEqual([other]);
    });

    it('treats a grep transport error as unverifiable, not as no matches', async () => {
        const lookup = fakeLookup({ grep: () => 'Error: regex parse error' });
        const res = await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('unverifiable');
    });

    it('logs why a claim could not be verified', async () => {
        const warn = jest.fn();
        const lookup = fakeLookup({
            grep: () => {
                throw new Error('boom');
            },
        });
        await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
            ],
            changedFiles: [],
            lookup,
            logger: { warn },
        });
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0].metadata).toEqual({
            ruleUuid: 'r1',
            filename: 'src/orders/order-mapper.ts',
            claimKind: 'unused',
        });
    });
});

describe('checkClaims — batch behavior (KRC-07)', () => {
    it('never runs more checks at once than the given concurrency', async () => {
        let inFlight = 0;
        let peak = 0;
        const lookup = fakeLookup({
            grep: async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setImmediate(r));
                inFlight--;
                return 'No matches found.';
            },
        });
        const violations = Array.from({ length: 10 }, (_, i) =>
            violation({ ruleUuid: `r${i}`, claimKind: 'unused', claimSymbol: 's' }),
        );

        await checkClaims({
            violations,
            changedFiles: [],
            lookup,
            concurrency: 2,
        });

        expect(peak).toBeLessThanOrEqual(2);
        expect(lookup.grepCalls).toHaveLength(10);
    });

    it('defaults to the shard concurrency limit, not a number of its own', async () => {
        let inFlight = 0;
        let peak = 0;
        const lookup = fakeLookup({
            grep: async () => {
                inFlight++;
                peak = Math.max(peak, inFlight);
                await new Promise((r) => setImmediate(r));
                inFlight--;
                return 'No matches found.';
            },
        });
        const violations = Array.from({ length: 12 }, (_, i) =>
            violation({ ruleUuid: `r${i}`, claimKind: 'unused', claimSymbol: 's' }),
        );

        // No `concurrency` passed: the default must BE the shard's limit, not a
        // literal that happens to match it today and drifts tomorrow (KRC-07).
        await checkClaims({ violations, changedFiles: [], lookup });

        expect(peak).toBe(SHARD_CONCURRENCY_DEFAULT);
    });

    it('preserves the order of the findings it keeps', async () => {
        const lookup = fakeLookup({
            grep: (pattern) =>
                pattern === 'used'
                    ? 'src/other.ts:1:used'
                    : 'No matches found.',
        });
        const res = await checkClaims({
            violations: [
                violation({ ruleUuid: 'a' }),
                violation({
                    ruleUuid: 'b',
                    claimKind: 'unused',
                    claimSymbol: 'used',
                }),
                violation({ ruleUuid: 'c' }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept.map((v) => v.ruleUuid)).toEqual(['a', 'c']);
        expect(res.dropped.map((d) => d.violation.ruleUuid)).toEqual(['b']);
    });

    it('returns the canonical empty result for an empty batch', async () => {
        const res = await checkClaims({
            violations: [],
            changedFiles: [],
            lookup: fakeLookup(),
        });
        expect(res).toEqual({ kept: [], dropped: [] });
    });
});


// Regression: the checked unit must be the PUBLISHED unit.
//
// The shard prompt asks for "one entry PER violating line PER rule; do not
// collapse repeats", and `dedupKodyRulesByRuleUuid` folds the repeats back into
// one comment. Observed on kimi-k2.7-code via Fireworks: the same case returned
// one ranged finding in seven runs and eight per-line findings in the eighth.
// In that eighth run the model declared the claim on ONE finding; the checker
// refuted it and dropped that one, and the seven undeclared siblings published
// the refuted assertion anyway.
describe('claim check groups by (rule, file), not by finding', () => {
    const eightSiblings = (): ShardViolation[] =>
        [2, 3, 4, 5, 6, 7, 8].map((line) =>
            violation({
                ruleUuid: 'rule-no-reimplemented-helper',
                relevantFile: 'src/blog/slug.ts',
                relevantLinesStart: line,
                relevantLinesEnd: line,
                suggestionContent:
                    'Reimplemented a `slugify` helper instead of using the existing one in `src/shared`.',
            }),
        );

    it('drops undeclared siblings when the group\'s claim is refuted', async () => {
        const declared = violation({
            ruleUuid: 'rule-no-reimplemented-helper',
            relevantFile: 'src/blog/slug.ts',
            relevantLinesStart: 1,
            relevantLinesEnd: 1,
            suggestionContent:
                'Reimplemented a `slugify` helper instead of using the existing one in `src/shared`.',
            claimKind: 'duplicate',
            claimSymbol: 'slugify',
            claimPath: 'src/shared',
        });

        // `slugify` exists nowhere else: the duplicate claim is false.
        const lookup = fakeLookup({ grep: () => 'No matches found.' });

        const res = await checkClaims({
            violations: [declared, ...eightSiblings()],
            changedFiles: [{ filename: 'src/blog/slug.ts' }],
            lookup,
        });

        expect(res.kept).toHaveLength(0);
        expect(res.dropped).toHaveLength(8);
        for (const d of res.dropped) {
            expect(d.reason).toContain('exists nowhere else');
        }
    });

    it('checks one distinct claim once for the whole group', async () => {
        const lookup = fakeLookup({ grep: () => 'No matches found.' });
        const group = eightSiblings().map((v) => ({
            ...v,
            claimKind: 'duplicate' as const,
            claimSymbol: 'slugify',
            claimPath: 'src/shared',
        }));

        await checkClaims({
            violations: group,
            changedFiles: [{ filename: 'src/blog/slug.ts' }],
            lookup,
        });

        expect(lookup.grepCalls).toHaveLength(1);
    });

    it('leaves a group nobody made a claim in untouched', async () => {
        const lookup = fakeLookup({ grep: () => 'No matches found.' });

        const res = await checkClaims({
            violations: eightSiblings(),
            changedFiles: [{ filename: 'src/blog/slug.ts' }],
            lookup,
        });

        expect(res.kept).toHaveLength(7);
        expect(res.dropped).toHaveLength(0);
        expect(lookup.grepCalls).toHaveLength(0);
    });

    it('does not let one file\'s refutation drop another file\'s finding', async () => {
        const refuted = violation({
            ruleUuid: 'rule-no-unused-imports',
            relevantFile: 'src/a.ts',
            relevantLinesStart: 2,
            relevantLinesEnd: 2,
            claimKind: 'unused',
            claimSymbol: 'helperA',
        });
        const other = violation({
            ruleUuid: 'rule-no-unused-imports',
            relevantFile: 'src/b.ts',
            relevantLinesStart: 5,
            relevantLinesEnd: 5,
        });

        // helperA IS used elsewhere, so the `unused` claim on src/a.ts is refuted.
        const lookup = fakeLookup({
            grep: () => 'src/z.ts:40:helperA()',
        });

        const res = await checkClaims({
            violations: [refuted, other],
            changedFiles: [],
            lookup,
        });

        expect(res.dropped.map((d) => d.violation.relevantFile)).toEqual([
            'src/a.ts',
        ]);
        expect(res.kept.map((v) => v.relevantFile)).toEqual(['src/b.ts']);
    });

    it('spans the whole group when deciding what counts as elsewhere', async () => {
        // A symbol occurring only INSIDE the group's own lines does not refute
        // an `unused` claim the group makes: those are the flagged lines.
        const group = [2, 3, 4].map((line) =>
            violation({
                ruleUuid: 'rule-no-unused-imports',
                relevantFile: 'src/a.ts',
                relevantLinesStart: line,
                relevantLinesEnd: line,
                claimKind: 'unused',
                claimSymbol: 'helperA',
            }),
        );

        const lookup = fakeLookup({ grep: () => 'src/a.ts:3:helperA()' });

        const res = await checkClaims({
            violations: group,
            changedFiles: [],
            lookup,
        });

        expect(res.kept).toHaveLength(3);
        expect(res.dropped).toHaveLength(0);
    });

    // A claim of any kind may name a path as SUPPORTING evidence — "reuse the
    // one already in src/shared/slugify.ts". Only the `missing` branch ever
    // read `claimPath`, so a fabricated path shipped whenever the symbol
    // itself was real: the finding was right and the address was invented.
    describe('a path named as evidence by a non-missing claim', () => {
        const dupWithPath = (claimPath: string) => ({
            ruleUuid: 'r1',
            relevantFile: 'src/blog/slug.ts',
            relevantLinesStart: 1,
            relevantLinesEnd: 8,
            claimKind: 'duplicate' as const,
            claimSymbol: 'slugify',
            claimPath,
            suggestionContent: 'reuse the shared helper',
            oneSentenceSummary: 'duplicate helper',
        });

        it('drops a finding whose cited file does not exist', async () => {
            const res = await checkClaims({
                violations: [dupWithPath('src/shared/slugify.ts')],
                changedFiles: [{ filename: 'src/blog/slug.ts' } as any],
                lookup: fakeLookup({
                    grep: () => 'src/shared/strings.ts:9:export function slugify',
                    exists: () => false,
                }),
            });

            expect(res.kept).toHaveLength(0);
            expect(res.dropped[0].reason).toContain('does not exist');
        });

        it('keeps it when the cited file is really there', async () => {
            const res = await checkClaims({
                violations: [dupWithPath('src/shared/strings.ts')],
                changedFiles: [{ filename: 'src/blog/slug.ts' } as any],
                lookup: fakeLookup({
                    grep: () => 'src/shared/strings.ts:9:export function slugify',
                    exists: () => true,
                }),
            });

            expect(res.kept).toHaveLength(1);
        });

        // "src/shared" is a directory and a perfectly good thing to name.
        // `exists` lists files, so it always answers false for one — judging it
        // would make the checker invent a defect.
        it('does not judge a path that names a directory', async () => {
            const res = await checkClaims({
                violations: [dupWithPath('src/shared')],
                changedFiles: [{ filename: 'src/blog/slug.ts' } as any],
                lookup: fakeLookup({
                    grep: () => 'src/shared/strings.ts:9:export function slugify',
                    exists: () => false,
                }),
            });

            expect(res.kept).toHaveLength(1);
        });

        it('does not judge a path this very PR adds', async () => {
            const res = await checkClaims({
                violations: [dupWithPath('src/shared/new-helper.ts')],
                changedFiles: [
                    { filename: 'src/blog/slug.ts' } as any,
                    { filename: 'src/shared/new-helper.ts' } as any,
                ],
                lookup: fakeLookup({
                    grep: () => 'src/shared/new-helper.ts:1:export function slugify',
                    exists: () => false,
                }),
            });

            expect(res.kept).toHaveLength(1);
        });
    });
});
