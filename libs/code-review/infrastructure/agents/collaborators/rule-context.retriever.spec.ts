import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import {
    IKodyRule,
    KodyRuleContextNeed,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { RepoLookup, RepoLookupUnavailableError } from './repo-lookup';
import {
    needOf,
    resolveShardNeed,
    retrieveForShard,
    SHARD_CONTEXT_BUDGET_CHARS,
} from './rule-context.retriever';

function rule(
    need: IKodyRule['contextNeed'] extends infer _ ? string : never,
    overrides: Partial<IKodyRule> = {},
): Partial<IKodyRule> {
    return {
        uuid: overrides.uuid ?? `rule-${need}`,
        title: overrides.title ?? `rule needing ${need}`,
        rule: 'rule text',
        ...overrides,
        contextNeed: {
            need: need as any,
            sourceHash: 'hash',
            source: 'compiler',
            inferredAt: new Date(0),
        },
    };
}

function file(overrides: Partial<FileChange> = {}): FileChange {
    return {
        filename: 'src/invoice.ts',
        status: 'modified',
        patch: ['@@ -10,2 +10,3 @@', ' const a = 1;', '+  total += 1;'].join(
            '\n',
        ),
        content: null,
        sha: 'sha',
        additions: 1,
        deletions: 0,
        changes: 1,
        blob_url: '',
        raw_url: '',
        contents_url: '',
        ...overrides,
    } as FileChange;
}

function lookup(overrides: Partial<RepoLookup> = {}): RepoLookup {
    return {
        available: true,
        unavailableReason: '',
        grep: jest.fn(async () => ''),
        read: jest.fn(async () => ''),
        exists: jest.fn(async () => false),
        probe: jest.fn(async () => undefined),
        stats: { grep: 0, read: 0, exists: 0, failures: 0 },
        ...overrides,
    } as RepoLookup;
}

/** A lookup that behaves like a null sandbox: every accessor throws. */
function unavailableLookup(): RepoLookup {
    const boom = (op: string) => async () => {
        throw new RepoLookupUnavailableError(op, 'null sandbox');
    };
    return {
        available: false,
        unavailableReason: 'null sandbox',
        stats: { grep: 0, read: 0, exists: 0, failures: 0 },
        grep: boom('grep') as any,
        read: boom('read') as any,
        exists: boom('exists') as any,
        probe: jest.fn(async () => undefined),
    } as RepoLookup;
}

describe('needOf', () => {
    it('treats a rule with no declared need as diff-only', () => {
        expect(needOf({ uuid: 'r' })).toBe('diff-only');
    });

    it('returns the declared need', () => {
        expect(needOf(rule('symbol-references'))).toBe('symbol-references');
    });
});

describe('resolveShardNeed', () => {
    it('is diff-only for an empty shard', () => {
        expect(resolveShardNeed([])).toBe('diff-only');
    });

    it('picks the widest need declared in the shard', () => {
        expect(
            resolveShardNeed([
                rule('diff-only', { uuid: 'a' }),
                rule('sibling-file', { uuid: 'b' }),
                rule('symbol-references', { uuid: 'c' }),
            ]),
        ).toBe('symbol-references');
    });
});

describe('retrieveForShard — diff-only', () => {
    it('retrieves nothing and never touches the lookup', async () => {
        const repo = lookup();
        const result = await retrieveForShard({
            file: file(),
            rules: [rule('diff-only'), { uuid: 'no-need' }],
            lookup: repo,
        });

        expect(result).toEqual({ slices: [], unmet: [] });
        expect(repo.read).not.toHaveBeenCalled();
        expect(repo.grep).not.toHaveBeenCalled();
    });
});

describe('retrieveForShard — symbol-references (KRC-14)', () => {
    const symbolFile = file({
        patch: [
            '@@ -1,1 +1,2 @@',
            '+export function renderInvoice(order) {}',
        ].join('\n'),
    });

    it('greps the repository for the symbols the hunk defines', async () => {
        const grep = jest.fn(async () => 'src/b.ts:9: renderInvoice(order)');

        const result = await retrieveForShard({
            file: symbolFile,
            rules: [rule('symbol-references')],
            lookup: lookup({ grep }),
        });

        expect(grep).toHaveBeenCalledWith('renderInvoice');
        expect(result.unmet).toEqual([]);
        expect(result.slices).toEqual([
            {
                kind: 'symbol-references',
                label: 'repository occurrences of `renderInvoice`',
                content: 'src/b.ts:9: renderInvoice(order)',
                truncated: false,
            },
        ]);
    });

    it('records an empty grep as a real absence, not as a failure', async () => {
        const result = await retrieveForShard({
            file: symbolFile,
            rules: [rule('symbol-references')],
            lookup: lookup({ grep: jest.fn(async () => '') }),
        });

        expect(result.unmet).toEqual([]);
        expect(result.slices[0].content).toBe(
            '(no occurrence anywhere in the repository)',
        );
    });

    it('reads the raw patch, not the line-numbered one', async () => {
        // patchWithLinesStr prefixes every line with its number BEFORE the
        // '+', which hides the definition from the symbol extractor entirely.
        const grep = jest.fn(async () => 'src/b.ts:9: renderInvoice(order)');

        const result = await retrieveForShard({
            file: file({
                patch: [
                    '@@ -1,1 +1,2 @@',
                    '+export function renderInvoice(order) {}',
                ].join('\n'),
                patchWithLinesStr:
                    '@@ -1,1 +1,2 @@\n     1 +export function renderInvoice(order) {}',
            } as any),
            rules: [rule('symbol-references')],
            lookup: lookup({ grep }),
        });

        expect(grep).toHaveBeenCalledWith('renderInvoice');
        expect(result.unmet).toEqual([]);
    });

    it('reports the rule unmet when the hunk defines no symbol to search on', async () => {
        const rules = [rule('symbol-references')];

        const result = await retrieveForShard({
            file: file(),
            rules,
            lookup: lookup(),
        });

        expect(result.slices).toEqual([]);
        expect(result.unmet).toEqual(rules);
    });

    it('reports the rule unmet when the repository cannot be grepped', async () => {
        const rules = [rule('symbol-references')];

        const result = await retrieveForShard({
            file: symbolFile,
            rules,
            lookup: unavailableLookup(),
        });

        expect(result.slices).toEqual([]);
        expect(result.unmet).toEqual(rules);
    });
});

describe('retrieveForShard — sibling-file (KRC-26)', () => {
    it('reports whether each companion path exists and whether the PR changed it', async () => {
        const exists = jest.fn(
            async (path: string) => path === 'src/invoice.spec.ts',
        );

        const result = await retrieveForShard({
            file: file(),
            rules: [rule('sibling-file')],
            lookup: lookup({ exists }),
            changedFilenames: ['src/invoice.ts', 'src/invoice.spec.ts'],
        });

        expect(result.unmet).toEqual([]);
        expect(result.slices).toEqual([
            {
                kind: 'sibling-file',
                label: 'companion files of src/invoice.ts',
                content: [
                    '- src/invoice.spec.ts: exists, changed by this PR',
                    '- src/invoice.test.ts: does not exist',
                    '- src/invoice_test.ts: does not exist',
                    '- src/__tests__/invoice.ts: does not exist',
                ].join('\n'),
                truncated: false,
            },
        ]);
    });

    it('retrieves nothing for a file that is itself a test', async () => {
        const repo = lookup();

        const result = await retrieveForShard({
            file: file({ filename: 'src/invoice.spec.ts' }),
            rules: [rule('sibling-file')],
            lookup: repo,
        });

        expect(result).toEqual({ slices: [], unmet: [] });
        expect(repo.exists).not.toHaveBeenCalled();
    });

    it('reports the rule unmet when existence cannot be checked', async () => {
        const rules = [rule('sibling-file')];

        const result = await retrieveForShard({
            file: file(),
            rules,
            lookup: unavailableLookup(),
        });

        expect(result.slices).toEqual([]);
        expect(result.unmet).toEqual(rules);
    });
});

describe('retrieveForShard — mixed needs in one shard', () => {
    it('retrieves every declared need and fails only the rules whose need failed', async () => {
        const siblingRule = rule('sibling-file', { uuid: 'sibling' });
        const symbolRule = rule('symbol-references', { uuid: 'symbol' });

        const result = await retrieveForShard({
            file: file(),
            rules: [siblingRule, symbolRule],
            lookup: lookup({ exists: jest.fn(async () => false) }),
        });

        // The hunk defines no symbol, so only the symbol rule is unmet; the
        // sibling slice is still built and the shard keeps its widest
        // satisfiable need.
        expect(result.unmet).toEqual([symbolRule]);
        expect(result.slices.map((s) => s.kind)).toEqual(['sibling-file']);
        expect(resolveShardNeed([siblingRule, symbolRule])).toBe(
            'symbol-references',
        );
    });
});

describe('retrieveForShard — budget (KRC-28, KRC-29)', () => {
    it('defaults to a 6000-character per-shard budget', () => {
        expect(SHARD_CONTEXT_BUDGET_CHARS).toBe(6000);
    });

    // The second half of KRC-28 — "prefer retrieved slices over whole-file
    // content" — held only because no code path happened to read a whole file,
    // which nothing asserted (Verifier round 2, gap 6). This pins it: every
    // read the retriever issues is a bounded line range, so a future "just read
    // the file" shortcut fails here instead of quietly tripling every shard.
    // KRC-28 originally read "never reads a whole file: every read is a
    // bounded line range". Issue #1826's step 1 is precisely the opposite for
    // the file the shard is judging — the file shard now carries its file
    // whole — so that requirement was removed rather than worked around. What
    // survives is the part that still holds: RETRIEVAL of other files stays
    // bounded, because those are additional slices on top of the file.
    it('keeps retrieval of OTHER files bounded (KRC-28, narrowed)', async () => {
        const read = jest.fn(async () => 'const x = 1;');

        await retrieveForShard({
            file: file({
                patch: ['@@ -1,1 +1,2 @@', '+import { a } from "./a";'].join(
                    '\n',
                ),
            }),
            rules: [rule('sibling-file')],
            lookup: lookup({ read }),
        });

        for (const call of read.mock.calls as unknown as Array<
            [string, number, number]
        >) {
            const [, from, to] = call;
            expect(Number.isFinite(to)).toBe(true);
            expect(to - from).toBeLessThan(200);
        }
    });

    it('truncates an oversized slice, marks it, and keeps the rule judged', async () => {
        const oversized = 'x'.repeat(SHARD_CONTEXT_BUDGET_CHARS + 500);
        const rules = [rule('symbol-references')];

        const result = await retrieveForShard({
            file: file({
                patch: [
                    '@@ -1,1 +1,2 @@',
                    '+export function renderInvoice(order) {}',
                ].join('\n'),
            }),
            rules,
            lookup: lookup({ grep: jest.fn(async () => oversized) }),
        });

        expect(result.unmet).toEqual([]);
        expect(result.slices).toHaveLength(1);
        expect(result.slices[0].truncated).toBe(true);
        expect(result.slices[0].content).toHaveLength(
            SHARD_CONTEXT_BUDGET_CHARS,
        );
    });

    it('spends the budget across slices in order', async () => {
        const result = await retrieveForShard({
            file: file({
                patch: [
                    '@@ -1,1 +1,2 @@',
                    '+export function renderInvoice(order) {}',
                ].join('\n'),
            }),
            rules: [rule('symbol-references'), rule('sibling-file')],
            lookup: lookup({
                grep: jest.fn(async () => 'y'.repeat(40)),
                exists: jest.fn(async () => false),
            }),
            budgetChars: 50,
        });

        expect(result.slices[0].content).toHaveLength(40);
        expect(result.slices[0].truncated).toBe(false);
        expect(result.slices[1].content).toHaveLength(10);
        expect(result.slices[1].truncated).toBe(true);
        expect(result.unmet).toEqual([]);
    });
});

describe('retrieveForShard — a file this PR added', () => {
    it('retrieves nothing, because the diff already is the whole file', async () => {
        const repo = lookup();

        const result = await retrieveForShard({
            file: file({
                status: 'added',
                patch: [
                    '@@ -0,0 +1,2 @@',
                    '+export function renderInvoice(order) {}',
                ].join('\n'),
            }),
            rules: [rule('symbol-references'), rule('enclosing-scope')],
            lookup: repo,
        });

        expect(result).toEqual({ slices: [], unmet: [] });
        expect(repo.grep).not.toHaveBeenCalled();
        expect(repo.read).not.toHaveBeenCalled();
    });
});

/**
 * The regression guard for shipping `full-file` to an installed base.
 *
 * Re-classifying the fleet moves rules OUT of `diff-only`. If a need that fails
 * to retrieve always skipped the rule, then the first sandbox hiccup would take
 * rules that work today out of enforcement — which is a worse outcome than the
 * bug being fixed. `full-file` therefore degrades: the hunk is already part of
 * the file, so judging without the slice is exactly the behaviour every rule
 * had before this feature, and the claim checker still guards it.
 *
 * The outward-reaching needs must keep skipping: judging THEM blind is #1724.
 */
describe('#1826 — a failed retrieval must not take a working rule out of enforcement', () => {
    const file = {
        filename: 'src/reports/build-report.ts',
        patch: '@@ -1,2 +1,3 @@\n context\n+const x = 1;\n',
    } as any;

    const ruleNeeding = (need: KodyRuleContextNeed) =>
        ({
            uuid: `rule-${need}`,
            rule: 'r',
            contextNeed: {
                need,
                sourceHash: 'h',
                source: 'author' as const,
                inferredAt: new Date(),
            },
        }) as Partial<IKodyRule>;

    const brokenLookup = () =>
        ({
            available: true,
            unavailableReason: '',
            stats: { grep: 0, read: 0, exists: 0, failures: 0 },
            grep: async () => {
                throw new Error('sandbox went away');
            },
            read: async () => {
                throw new Error('sandbox went away');
            },
            exists: async () => {
                throw new Error('sandbox went away');
            },
            probe: async () => undefined,
        }) as any;

    it('still judges a full-file rule when the file cannot be read', async () => {
        const res = await retrieveForShard({
            file,
            rules: [ruleNeeding('full-file')],
            lookup: brokenLookup(),
            changedFilenames: [file.filename],
        });

        expect(res.unmet).toHaveLength(0);
        expect(res.slices).toHaveLength(0);
    });

    it('still SKIPS a symbol-references rule — judging it blind is the bug', async () => {
        const res = await retrieveForShard({
            file,
            rules: [ruleNeeding('symbol-references')],
            lookup: brokenLookup(),
            changedFilenames: [file.filename],
        });

        expect(res.unmet).toHaveLength(1);
    });

    it('still SKIPS a sibling-file rule for the same reason', async () => {
        const res = await retrieveForShard({
            file,
            rules: [ruleNeeding('sibling-file')],
            lookup: brokenLookup(),
            changedFilenames: [file.filename],
        });

        expect(res.unmet).toHaveLength(1);
    });

    it('skips only the rule that reaches outside, not its full-file neighbour', async () => {
        const res = await retrieveForShard({
            file,
            rules: [ruleNeeding('full-file'), ruleNeeding('symbol-references')],
            lookup: brokenLookup(),
            changedFilenames: [file.filename],
        });

        expect(res.unmet.map((r: any) => r.uuid)).toEqual([
            'rule-symbol-references',
        ]);
    });
});

/**
 * `full-file` is satisfied by the file already being on the page (#1826).
 *
 * The caller (kody-rules-agent.provider) reads every changed file
 * unconditionally for step 1. Retrieving the same file here produced a second
 * copy in the same prompt — identical text under the shard budget, a strict
 * subset of it above. The need is MET by the cheaper path, so it must not
 * yield a slice and must not count as unmet.
 */
describe('retrieveForShard — full-file when the file is already on the page', () => {
    it('retrieves nothing and reads nothing', async () => {
        const repo = lookup({
            read: jest.fn(async () => 'the whole file'),
        });

        const out = await retrieveForShard({
            file: file(),
            rules: [rule('full-file')],
            lookup: repo,
            wholeFileAlreadyOnPage: true,
        });

        expect(out.slices).toEqual([]);
        // MET, not unmet: an unmet need takes the rule out of the shard.
        expect(out.unmet).toEqual([]);
        expect(repo.read).not.toHaveBeenCalled();
    });

    it('still retrieves it when the caller did NOT put it on the page', async () => {
        const repo = lookup({ read: jest.fn(async () => 'the whole file') });

        const out = await retrieveForShard({
            file: file(),
            rules: [rule('full-file')],
            lookup: repo,
            wholeFileAlreadyOnPage: false,
        });

        expect(out.slices).toHaveLength(1);
        expect(out.slices[0].kind).toBe('full-file');
        expect(repo.read).toHaveBeenCalled();
    });

    it('does not suppress the OTHER needs a shard declares', async () => {
        // The flag is about one file's own text. A sibling file or a symbol's
        // references live elsewhere and are still missing from the page.
        const repo = lookup({
            read: jest.fn(async () => 'the whole file'),
            grep: jest.fn(async () => 'src/other.ts:3: total'),
        });

        const out = await retrieveForShard({
            // A hunk that DEFINES a symbol, so symbol-references has something
            // to look for.
            file: file({
                patch: [
                    '@@ -1,1 +1,2 @@',
                    '+export function renderInvoice(order) {}',
                ].join('\n'),
            }),
            rules: [rule('full-file'), rule('symbol-references')],
            lookup: repo,
            wholeFileAlreadyOnPage: true,
        });

        expect(out.slices.every((s) => s.kind !== 'full-file')).toBe(true);
        expect(out.slices.some((s) => s.kind === 'symbol-references')).toBe(
            true,
        );
    });
});
