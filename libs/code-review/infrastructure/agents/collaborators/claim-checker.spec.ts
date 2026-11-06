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

    it('treats a missing claim with no path as none (KRC-21)', () => {
        expect(
            readClaim(violation({ claimKind: 'missing', claimSymbol: 'thing' }))
                .kind,
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

describe('checkClaims — an unused import is about the file that imports it (#1724 QA)', () => {
    // QA on GitLab: report.js adds `import { debounce } from "./timing.js"`
    // and never uses it. The only other occurrence is the definition in
    // timing.js, which every local import has, so the true finding was dropped.
    const importLine = (over: Partial<ShardViolation> = {}) =>
        violation({
            relevantFile: 'helpers/report.js',
            relevantLinesStart: 2,
            relevantLinesEnd: 2,
            claimKind: 'unused',
            claimSymbol: 'debounce',
            ...over,
        });

    it('keeps it when the symbol occurs only where it is defined', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:2:import { debounce } from "./timing.js";\nhelpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [importLine()],
            changedFiles: [],
            lookup,
        });
        expect(res.dropped).toEqual([]);
        expect(res.kept).toHaveLength(1);
    });

    it('keeps it when other files import and use the same symbol', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:2:import { debounce } from "./timing.js";\nsrc/search.js:1:import { debounce } from "../helpers/timing.js";\nsrc/search.js:9:  debounce(run, 200);',
        });
        const res = await checkClaims({
            violations: [importLine()],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('drops it when the importing file uses the symbol outside the finding', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:2:import { debounce } from "./timing.js";\nhelpers/report.js:24:  const save = debounce(write, 300);',
        });
        const res = await checkClaims({
            violations: [importLine()],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('helpers/report.js:24');
    });

    it('does not count a longer identifier in the same file as a use', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:2:import { debounce } from "./timing.js";\nhelpers/report.js:30:  const debounced = true;',
        });
        const res = await checkClaims({
            violations: [importLine()],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('reads a multi-line import from the code the finding cites', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:3:  debounce,\nhelpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [
                importLine({
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                    existingCode:
                        'import {\n  formatDate,\n  debounce,\n} from "./timing.js";',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('counts the same text as a use when it sits outside the import the finding cites', async () => {
        // The import is on lines 10-12; `  debounce,` on line 8 is a shorthand
        // property of an object above it, a few lines away and with the same
        // text as the import's member line.
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:8:  debounce,\nhelpers/report.js:11:  debounce,',
        });
        const res = await checkClaims({
            violations: [
                importLine({
                    relevantLinesStart: 10,
                    relevantLinesEnd: 10,
                    existingCode:
                        'import {\n  debounce,\n} from "./timing.js";',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('helpers/report.js:8');
    });

    it('does not count the import own member line below the finding as a use', async () => {
        const lookup = fakeLookup({
            grep: () => 'helpers/report.js:11:  debounce,',
        });
        const res = await checkClaims({
            violations: [
                importLine({
                    relevantLinesStart: 10,
                    relevantLinesEnd: 10,
                    existingCode:
                        'import {\n  debounce,\n} from "./timing.js";',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('does not publish an unused stylesheet import, whose members are used rather than its name', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'src/app/theme.scss:3:@import "variables";\nsrc/app/other.scss:1:@import "variables";',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'src/app/theme.scss',
                    claimKind: 'unused',
                    claimSymbol: 'variables',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('unverifiable');
    });

    it('does not publish an unused import from a finding that names no file', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [
                importLine({
                    relevantFile: undefined,
                    existingCode: 'import { debounce } from "./timing.js";',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('unverifiable');
    });

    it('judges a re-export by the files that import it, as before', async () => {
        const lookup = fakeLookup({
            grep: () =>
                "src/index.ts:1:export { debounce } from './timing';\nsrc/app.ts:9:  debounce(run, 200);",
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'src/index.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    claimKind: 'unused',
                    claimSymbol: 'debounce',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('src/app.ts:9');
    });

    it("judges a package __init__.py's import by the files that import the package", async () => {
        const lookup = fakeLookup({
            grep: () =>
                'pkg/__init__.py:1:from .core import helper\napp/main.py:4:    helper()',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'pkg/__init__.py',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    claimKind: 'unused',
                    claimSymbol: 'helper',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('app/main.py:4');
    });

    it('does not judge a claim as an import when the cited import names another symbol', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'src/a.ts:10:export function formatTotal(n) {\nsrc/b.ts:4:  formatTotal(sum)',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'src/a.ts',
                    relevantLinesStart: 10,
                    relevantLinesEnd: 12,
                    claimKind: 'unused',
                    claimSymbol: 'formatTotal',
                    existingCode:
                        "import { x } from './x';\n\nexport function formatTotal(n) {",
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('src/b.ts:4');
    });

    it('reads only the import statement, not the rest of the cited code, when it spans lines', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'src/a.ts:12:export function formatTotal(n) {\nsrc/b.ts:4:  formatTotal(sum)',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'src/a.ts',
                    relevantLinesStart: 12,
                    relevantLinesEnd: 14,
                    claimKind: 'unused',
                    claimSymbol: 'formatTotal',
                    existingCode:
                        "import {\n  x,\n} from './x';\nexport function formatTotal(n) {",
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('src/b.ts:4');
    });

    it('keeps an unused import bound under another name when the file never uses that name', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:2:import { debounce as wait } from "./timing.js";\nhelpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [importLine()],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(lookup.grepCalls).toHaveLength(2);
    });

    it('drops an import bound under another name when the file uses that name', async () => {
        const lookup = fakeLookup({
            grep: (pattern) =>
                pattern === 'wait'
                    ? 'helpers/report.js:2:import { debounce as wait } from "./timing.js";\nhelpers/report.js:14:  wait(save, 300);'
                    : 'helpers/report.js:2:import { debounce as wait } from "./timing.js";\nhelpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [importLine()],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('helpers/report.js:14');
        expect(res.dropped[0].reason).toContain('bound as debounce, wait');
    });

    it('reads a multi-line import to its real end when a comment holds a brace', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:3:  debounce,\nhelpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [
                importLine({
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                    existingCode:
                        'import { // see } below\n  formatDate,\n  debounce,\n} from "./timing.js" with { type: "js" };',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('does not read "as" in a comment on the import as an alias', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:2:import { debounce } from "./timing.js"; // was debounce as wait\nhelpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [importLine()],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('judges an import that names the symbol only in its path as main does', async () => {
        // Go binds `f`, not `fmt`: the same-file search for `fmt` cannot see it.
        const lookup = fakeLookup({
            grep: () =>
                'cmd/main.go:3:import f "fmt"\ninternal/log.go:5:\tfmt.Println(msg)',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'cmd/main.go',
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                    claimKind: 'unused',
                    claimSymbol: 'fmt',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('internal/log.go:5');
    });

    it('does not publish an unused React import in a JSX file, which the classic runtime uses without its name', async () => {
        const lookup = fakeLookup({
            grep: () =>
                "src/Card.tsx:1:import React from 'react';\nsrc/List.tsx:1:import React from 'react';",
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'src/Card.tsx',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    claimKind: 'unused',
                    claimSymbol: 'React',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('unverifiable');
    });

    it('does not publish an unused React import in a .js file, which may hold JSX', async () => {
        const lookup = fakeLookup({
            grep: () =>
                "src/Card.js:1:import React from 'react';\nsrc/List.js:1:import React from 'react';",
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: 'src/Card.js',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    claimKind: 'unused',
                    claimSymbol: 'React',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('unverifiable');
    });

    it('reads a multi-line import past a block comment that spans lines and holds a brace', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/report.js:4:  debounce,\nhelpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [
                importLine({
                    relevantLinesStart: 4,
                    relevantLinesEnd: 4,
                    existingCode:
                        'import { /* formerly:\n  } */\n  formatDate,\n  debounce,\n} from "./timing.js";',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('reads a string continued across lines as a string, not as the binding', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'helpers/timing.js:1:export function debounce(fn, ms) {',
        });
        const res = await checkClaims({
            violations: [
                importLine({
                    existingCode:
                        'import { debounce } from "./a{\\\ndebounce as w.js";',
                }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
    });

    it('still drops a non-import unused claim when another file uses the symbol', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'src/orders/order-mapper.ts:3:export function formatDate(d) {\nsrc/invoices/print.ts:8:  formatDate(d)',
        });
        const res = await checkClaims({
            violations: [
                violation({ claimKind: 'unused', claimSymbol: 'formatDate' }),
            ],
            changedFiles: [],
            lookup,
        });
        expect(res.kept).toEqual([]);
    });
});

describe('checkClaims — an unused import, in every language the rules review', () => {
    // Each case: the import line the finding is on, the symbol it claims is
    // unused, and what the repository answers. `uses` is the file's own text
    // of every name the search asks for; `elsewhere` is a definition or use in
    // another file, which never makes this import used.
    type Case = {
        lang: string;
        file: string;
        line: string;
        symbol: string;
        uses?: string[];
        elsewhere?: string;
        verdict: 'publish' | 'drop' | 'unverifiable';
        reason?: string;
    };
    const CASES: Case[] = [
        {
            lang: 'TypeScript',
            file: 'src/a.ts',
            line: 'import { formatDate } from "./dates";',
            symbol: 'formatDate',
            elsewhere: 'src/dates.ts:3:export function formatDate(d) {',
            verdict: 'publish',
        },
        {
            lang: 'TypeScript, used',
            file: 'src/a.ts',
            line: 'import { formatDate } from "./dates";',
            symbol: 'formatDate',
            uses: ['src/a.ts:9:  formatDate(now)'],
            verdict: 'drop',
            reason: 'src/a.ts:9',
        },
        {
            lang: 'TypeScript type-only',
            file: 'src/a.ts',
            line: 'import type { Money } from "./money";',
            symbol: 'Money',
            uses: ['src/a.ts:7:let total: Money;'],
            verdict: 'drop',
            reason: 'src/a.ts:7',
        },
        {
            lang: 'CommonJS',
            file: 'src/a.js',
            line: "const { slugify } = require('./text');",
            symbol: 'slugify',
            elsewhere: 'src/text.js:1:function slugify(s) {',
            verdict: 'publish',
        },
        {
            lang: 'Python',
            file: 'app/a.py',
            line: 'from app.dates import format_date',
            symbol: 'format_date',
            elsewhere: 'app/dates.py:4:def format_date(d):',
            verdict: 'publish',
        },
        {
            lang: 'Python, module path is not a use',
            file: 'app/a.py',
            line: 'from app.dates import format_date',
            symbol: 'format_date',
            uses: ['app/a.py:12:    app.run()'],
            verdict: 'publish',
        },
        {
            lang: 'Python alias, used',
            file: 'app/a.py',
            line: 'import numpy as np',
            symbol: 'numpy',
            uses: ['app/a.py:8:x = np.zeros(3)'],
            verdict: 'drop',
            reason: 'app/a.py:8',
        },
        {
            lang: 'Python alias, unused',
            file: 'app/a.py',
            line: 'import numpy as np',
            symbol: 'numpy',
            elsewhere: 'app/b.py:1:import numpy',
            verdict: 'publish',
        },
        {
            lang: 'Python wildcard',
            file: 'app/a.py',
            line: 'from os.path import *',
            symbol: 'os',
            verdict: 'unverifiable',
        },
        {
            lang: 'Java',
            file: 'src/A.java',
            line: 'import com.acme.Money;',
            symbol: 'Money',
            elsewhere: 'src/Money.java:3:public class Money {',
            verdict: 'publish',
        },
        {
            lang: 'Java, the package line is not a use',
            file: 'src/A.java',
            line: 'import com.acme.Money;',
            symbol: 'Money',
            uses: ['src/A.java:0:package com.acme.app;'],
            verdict: 'publish',
        },
        {
            lang: 'Java static, another path through the same package',
            file: 'src/A.java',
            line: 'import static com.acme.Util.round;',
            symbol: 'round',
            uses: ['src/A.java:9:    com.acme.Util.log(x);'],
            verdict: 'publish',
        },
        {
            lang: 'Java, used',
            file: 'src/A.java',
            line: 'import com.acme.Money;',
            symbol: 'Money',
            uses: ['src/A.java:11:    Money total;'],
            verdict: 'drop',
            reason: 'src/A.java:11',
        },
        {
            lang: 'Java wildcard',
            file: 'src/A.java',
            line: 'import java.util.*;',
            symbol: 'util',
            verdict: 'unverifiable',
        },
        {
            lang: 'Kotlin alias, used',
            file: 'src/A.kt',
            line: 'import com.acme.Money as Cash',
            symbol: 'Money',
            uses: ['src/A.kt:6:val c: Cash = Cash()'],
            verdict: 'drop',
            reason: 'src/A.kt:6',
        },
        {
            lang: 'Scala rename, used',
            file: 'src/A.scala',
            line: 'import com.acme.{Money => Cash}',
            symbol: 'Money',
            uses: ['src/A.scala:5:  val c = Cash(1)'],
            verdict: 'drop',
            reason: 'src/A.scala:5',
        },
        {
            lang: 'Scala rename, unused',
            file: 'src/A.scala',
            line: 'import com.acme.{Money => Cash}',
            symbol: 'Money',
            elsewhere: 'src/Money.scala:1:case class Money(v: Int)',
            verdict: 'publish',
        },
        {
            lang: 'Rust, one name of a group',
            file: 'src/a.rs',
            line: 'use crate::money::{Money, Rate};',
            symbol: 'Rate',
            uses: ['src/a.rs:9:    let m = Money::new();'],
            verdict: 'publish',
        },
        {
            lang: 'Rust alias, used',
            file: 'src/a.rs',
            line: 'use crate::money::Money as Cash;',
            symbol: 'Money',
            uses: ['src/a.rs:7:    let c = Cash::new();'],
            verdict: 'drop',
            reason: 'src/a.rs:7',
        },
        {
            lang: 'Rust, another path through the same crate',
            file: 'src/a.rs',
            line: 'use std::fmt::Display;',
            symbol: 'Display',
            uses: ['src/a.rs:9:    let s = std::mem::take(&mut x);'],
            verdict: 'publish',
        },
        {
            lang: 'Python, a dotted import binds its first name',
            file: 'app/a.py',
            line: 'import os.path',
            symbol: 'os',
            uses: ['app/a.py:8:cwd = os.getcwd()'],
            verdict: 'drop',
            reason: 'app/a.py:8',
        },
        {
            lang: 'Rust glob',
            file: 'src/a.rs',
            line: 'use std::io::*;',
            symbol: 'io',
            verdict: 'unverifiable',
        },
        {
            lang: 'PHP',
            file: 'src/A.php',
            line: 'use App\\Models\\User;',
            symbol: 'User',
            elsewhere: 'src/Models/User.php:5:class User {',
            verdict: 'publish',
        },
        {
            lang: 'PHP, used',
            file: 'src/A.php',
            line: 'use App\\Models\\User;',
            symbol: 'User',
            uses: ['src/A.php:10:User::find(1);'],
            verdict: 'drop',
            reason: 'src/A.php:10',
        },
        {
            lang: 'Go named import, unused',
            file: 'cmd/a.go',
            line: 'import str "strings"',
            symbol: 'str',
            elsewhere: 'cmd/b.go:3:import str "strings"',
            verdict: 'publish',
        },
        {
            lang: 'Go path import keeps main rule',
            file: 'cmd/a.go',
            line: 'import "strings"',
            symbol: 'strings',
            elsewhere: 'cmd/b.go:9:\tstrings.TrimSpace(s)',
            verdict: 'drop',
            reason: 'cmd/b.go:9',
        },
        {
            lang: 'Go dot import',
            file: 'cmd/a.go',
            line: 'import . "strings"',
            symbol: 'strings',
            verdict: 'unverifiable',
        },
        {
            lang: 'Lua',
            file: 'lib/a.lua',
            line: 'local json = require("json")',
            symbol: 'json',
            elsewhere: 'lib/b.lua:1:local json = require("json")',
            verdict: 'publish',
        },
        {
            lang: 'Elixir alias with as:, used',
            file: 'lib/a.ex',
            line: 'alias MyApp.Money, as: Cash',
            symbol: 'Money',
            uses: ['lib/a.ex:6:    Cash.new(1)'],
            verdict: 'drop',
            reason: 'lib/a.ex:6',
        },
        {
            lang: 'Elixir import',
            file: 'lib/a.ex',
            line: 'import Ecto.Query',
            symbol: 'Query',
            verdict: 'unverifiable',
        },
        {
            lang: 'Haskell explicit list',
            file: 'src/A.hs',
            line: 'import Data.Map (fromList)',
            symbol: 'fromList',
            elsewhere: 'src/B.hs:2:import Data.Map (fromList)',
            verdict: 'publish',
        },
        {
            lang: 'Haskell whole module',
            file: 'src/A.hs',
            line: 'import Data.List',
            symbol: 'List',
            verdict: 'unverifiable',
        },
        {
            lang: 'Swift module',
            file: 'App/A.swift',
            line: 'import Foundation',
            symbol: 'Foundation',
            verdict: 'unverifiable',
        },
        {
            lang: 'C#',
            file: 'src/A.cs',
            line: 'using System.Linq;',
            symbol: 'Linq',
            verdict: 'unverifiable',
        },
        {
            lang: 'C# static',
            file: 'src/A.cs',
            line: 'using static System.Math;',
            symbol: 'Math',
            verdict: 'unverifiable',
        },
        {
            lang: 'C++ using-declaration, unused',
            file: 'src/a.cpp',
            line: 'using std::cout;',
            symbol: 'cout',
            uses: ['src/a.cpp:9:  std::cerr << x;'],
            verdict: 'publish',
        },
        {
            lang: 'C++ using-declaration, used',
            file: 'src/a.cpp',
            line: 'using std::cout;',
            symbol: 'cout',
            uses: ['src/a.cpp:9:  cout << x;'],
            verdict: 'drop',
            reason: 'src/a.cpp:9',
        },
        {
            lang: 'C++',
            file: 'src/a.cpp',
            line: 'using namespace std;',
            symbol: 'std',
            verdict: 'unverifiable',
        },
        {
            lang: 'OCaml',
            file: 'src/a.ml',
            line: 'open Printf',
            symbol: 'Printf',
            verdict: 'unverifiable',
        },
        {
            lang: 'SCSS',
            file: 'src/a.scss',
            line: '@use "sass:math" as m;',
            symbol: 'math',
            verdict: 'unverifiable',
        },
        {
            lang: 'Python, claim about the from-path keeps main rule',
            file: 'app/a.py',
            line: 'from app.dates import format_date',
            symbol: 'app',
            uses: ['app/a.py:12:    app.run()'],
            verdict: 'drop',
            reason: 'app/a.py:12',
        },
        {
            lang: 'Java, claim about a path segment keeps main rule',
            file: 'src/A.java',
            line: 'import com.acme.Money;',
            symbol: 'acme',
            elsewhere: 'src/B.java:1:package com.acme.billing;',
            verdict: 'drop',
            reason: 'src/B.java:1',
        },
        {
            lang: 'Python, one name of several',
            file: 'app/a.py',
            line: 'from app.dates import parse_date, format_date',
            symbol: 'format_date',
            uses: ['app/a.py:9:    parse_date(s)'],
            verdict: 'publish',
        },
        {
            lang: 'Java static wildcard',
            file: 'src/A.java',
            line: 'import static com.acme.Util.*;',
            symbol: 'Util',
            verdict: 'unverifiable',
        },
        {
            lang: 'Rust trait imported as _',
            file: 'src/a.rs',
            line: 'use std::io::Write as _;',
            symbol: 'Write',
            uses: ['src/a.rs:6:    out.flush()?;'],
            verdict: 'unverifiable',
        },
        {
            lang: 'Python, claim about the from-path, file uses the bound name',
            file: 'app/a.py',
            line: 'from app.dates import format_date',
            symbol: 'dates',
            uses: ['app/a.py:9:    format_date(x)'],
            verdict: 'drop',
            reason: 'app/a.py:9',
        },
    ];

    it.each(CASES)('$lang: $verdict', async (c: Case) => {
        const own = `${c.file}:1:${c.line}`;
        const lines = [own, ...(c.uses ?? []), c.elsewhere].filter(
            (l): l is string => Boolean(l),
        );
        // As rg answers: only the lines whose text matches the pattern.
        const lookup = fakeLookup({
            grep: (pattern) =>
                lines
                    .filter((l) =>
                        new RegExp(pattern).test(
                            l.split(':').slice(2).join(':'),
                        ),
                    )
                    .join('\n'),
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: c.file,
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    claimKind: 'unused',
                    claimSymbol: c.symbol,
                }),
            ],
            changedFiles: [],
            lookup,
        });
        if (c.verdict === 'publish') {
            expect(res.kept).toHaveLength(1);
            return;
        }
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain(
            c.verdict === 'unverifiable' ? 'unverifiable' : c.reason!,
        );
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
            grep: () => 'src/orders/order-mapper.ts:3:function formatDate(d) {',
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
            violation({
                ruleUuid: `r${i}`,
                claimKind: 'unused',
                claimSymbol: 's',
            }),
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
            violation({
                ruleUuid: `r${i}`,
                claimKind: 'unused',
                claimSymbol: 's',
            }),
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

    // The fixture above gives every sibling the SAME text, which is the one
    // shape that cannot exercise a text-keyed grouping. The model does not
    // behave that way: asked for "one entry per violating line", it phrases
    // each entry around its own line. This is that run, reproduced from a real
    // E2B result where eight per-line findings split into eight groups and the
    // seven undeclared ones published an assertion the repository had already
    // refuted.
    it('drops undeclared siblings even when each phrases it differently', async () => {
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

        const differentlyWorded = [2, 3, 4, 5, 6, 7, 8].map((line) =>
            violation({
                ruleUuid: 'rule-no-reimplemented-helper',
                relevantFile: 'src/blog/slug.ts',
                relevantLinesStart: line,
                relevantLinesEnd: line,
                // Each sibling says the same thing in its own words, and none
                // of them declares a claim.
                suggestionContent: `Line ${line} belongs to a reimplemented slugify helper that already exists in src/shared.`,
                oneSentenceSummary: `Line ${line} duplicates an existing shared helper.`,
            }),
        );

        const lookup = fakeLookup({ grep: () => 'No matches found.' });

        const res = await checkClaims({
            violations: [declared, ...differentlyWorded],
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

    it("does not let one file's refutation drop another file's finding", async () => {
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
                    grep: () =>
                        'src/shared/strings.ts:9:export function slugify',
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
                    grep: () =>
                        'src/shared/strings.ts:9:export function slugify',
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
                    grep: () =>
                        'src/shared/strings.ts:9:export function slugify',
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
                    grep: () =>
                        'src/shared/new-helper.ts:1:export function slugify',
                    exists: () => false,
                }),
            });

            expect(res.kept).toHaveLength(1);
        });
    });
});

// Azure Repos names changed files with a leading "/" ("/src/a.ts") while grep
// answers repo-relative ("src/a.ts"). Both forms name the same file.
describe('checkClaims — a file named with a leading slash', () => {
    it('checks a claim once when siblings name its path with and without the slash', async () => {
        const exists = jest.fn().mockReturnValue(true);
        const lookup = fakeLookup({ exists });
        const sibling = (
            relevantFile: string,
            claimPath: string,
            line: number,
        ) =>
            violation({
                relevantFile,
                relevantLinesStart: line,
                relevantLinesEnd: line,
                claimKind: 'missing',
                claimPath,
            });

        const res = await checkClaims({
            violations: [
                sibling(
                    '/src/orders/order-mapper.ts',
                    '/src/orders/order-mapper.spec.ts',
                    3,
                ),
                sibling(
                    'src/orders/order-mapper.ts',
                    'src/orders/order-mapper.spec.ts',
                    7,
                ),
            ],
            changedFiles: [{ filename: '/src/orders/order-mapper.ts' }],
            lookup,
        });

        expect(exists).toHaveBeenCalledTimes(1);
        expect(res.dropped).toHaveLength(2);
    });

    it('keeps an unused finding whose only matches are its own lines', async () => {
        const lookup = fakeLookup({
            grep: () =>
                'src/orders/order-mapper.ts:3:import { formatDate } from "../shared/date";',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: '/src/orders/order-mapper.ts',
                    claimKind: 'unused',
                    claimSymbol: 'formatDate',
                    relevantLinesStart: 3,
                    relevantLinesEnd: 3,
                }),
            ],
            changedFiles: [{ filename: '/src/orders/order-mapper.ts' }],
            lookup,
        });
        expect(res.kept).toHaveLength(1);
        expect(res.dropped).toEqual([]);
    });

    it('does not take the finding own lines as the pre-existing duplicate', async () => {
        const lookup = fakeLookup({
            grep: () => 'src/blog/slug.ts:2:export function slugify() {}',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: '/src/blog/slug.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 8,
                    claimKind: 'duplicate',
                    claimSymbol: 'slugify',
                }),
            ],
            changedFiles: [{ filename: '/src/blog/slug.ts' }],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('exists nowhere else');
    });

    it('sees that this PR changes the path a missing claim names', async () => {
        const lookup = fakeLookup({ exists: () => false });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: '/src/orders/order-mapper.ts',
                    claimKind: 'missing',
                    claimPath: 'src/orders/order-mapper.spec.ts',
                }),
            ],
            changedFiles: [
                { filename: '/src/orders/order-mapper.spec.ts' },
                { filename: '/src/orders/order-mapper.ts' },
            ],
            lookup,
        });
        expect(res.kept).toEqual([]);
        expect(res.dropped[0].reason).toContain('this PR changes it');
    });

    it('does not check the existence of an evidence path this PR changes', async () => {
        const exists = jest.fn().mockReturnValue(false);
        const lookup = fakeLookup({
            exists,
            grep: () => 'src/shared/slugify.ts:1:export function slugify() {}',
        });
        const res = await checkClaims({
            violations: [
                violation({
                    relevantFile: '/src/blog/slug.ts',
                    relevantLinesStart: 1,
                    relevantLinesEnd: 8,
                    claimKind: 'duplicate',
                    claimSymbol: 'slugify',
                    claimPath: 'src/shared/slugify.ts',
                }),
            ],
            changedFiles: [
                { filename: '/src/blog/slug.ts' },
                { filename: '/src/shared/slugify.ts' },
            ],
            lookup,
        });
        expect(exists).not.toHaveBeenCalled();
        expect(res.kept).toHaveLength(1);
    });
});
