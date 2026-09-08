import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

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

describe('retrieveForShard — enclosing-scope (KRC-13)', () => {
    it('returns the scope the change sits inside', async () => {
        const read = jest.fn(async () =>
            [
                'const unrelated = 1;',
                'export function total(items) {',
                '  const a = 1;',
                '  total += 1;',
                '}',
            ].join('\n'),
        );

        const result = await retrieveForShard({
            file: file({
                patch: ['@@ -10,2 +10,3 @@', '+  total += 1;'].join('\n'),
            }),
            rules: [rule('enclosing-scope')],
            lookup: lookup({ read }),
        });

        expect(read).toHaveBeenCalledWith('src/invoice.ts', 1, 32);
        expect(result.unmet).toEqual([]);
        expect(result.slices).toHaveLength(1);
        expect(result.slices[0].kind).toBe('enclosing-scope');
        expect(result.slices[0].content).toBe(
            [
                'export function total(items) {',
                '  const a = 1;',
                '  total += 1;',
                '}',
            ].join('\n'),
        );
        expect(result.slices[0].truncated).toBe(false);
    });

    it('falls back to a bounded window when the language has no recognizable definitions (KRC-27)', async () => {
        const read = jest.fn(async () => '.total { color: red; }');

        const result = await retrieveForShard({
            file: file({
                filename: 'src/theme.scss',
                patch: ['@@ -30,1 +30,2 @@', '+  color: red;'].join('\n'),
            }),
            rules: [rule('enclosing-scope')],
            lookup: lookup({ read }),
        });

        expect(read).toHaveBeenCalledWith('src/theme.scss', 10, 51);
        expect(result.unmet).toEqual([]);
        expect(result.slices[0].content).toBe('.total { color: red; }');
        expect(result.slices[0].label).toContain('lines 10-51');
    });

    it('falls back to a bounded window when no definition sits above the hunk', async () => {
        const read = jest
            .fn()
            .mockResolvedValueOnce('  a = 1;\n  b = 2;')
            .mockResolvedValueOnce('window content');

        const result = await retrieveForShard({
            file: file({
                patch: ['@@ -30,1 +30,2 @@', '+  b = 2;'].join('\n'),
            }),
            rules: [rule('enclosing-scope')],
            lookup: lookup({ read }),
        });

        expect(read).toHaveBeenNthCalledWith(2, 'src/invoice.ts', 10, 51);
        expect(result.slices[0].content).toBe('window content');
    });

    it('reports the rule unmet when the repository cannot be read', async () => {
        const rules = [rule('enclosing-scope')];

        const result = await retrieveForShard({
            file: file(),
            rules,
            lookup: unavailableLookup(),
        });

        expect(result.slices).toEqual([]);
        expect(result.unmet).toEqual(rules);
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
    it('never reads a whole file: every read is a bounded line range (KRC-28)', async () => {
        const read = jest.fn(async () => 'const x = 1;');
        const hunkStart = 400;
        const patch = [
            `@@ -${hunkStart},1 +${hunkStart},2 @@`,
            '+export function renderInvoice(order) {}',
        ].join('\n');

        await retrieveForShard({
            file: file({ patch }),
            rules: [rule('enclosing-scope')],
            lookup: lookup({ read }),
        });

        expect(read).toHaveBeenCalled();
        for (const [, from, to] of read.mock.calls as unknown as Array<
            [string, number, number]
        >) {
            expect(from).toBeGreaterThan(1);
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
