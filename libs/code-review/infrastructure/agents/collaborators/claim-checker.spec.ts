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
