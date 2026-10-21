import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { generateCallGraphFromJSON } from './call-graph.helper';

/**
 * Mutation-killing coverage for the deterministic logic in call-graph.helper.
 *
 * The target functions under test — isTestLikePath, extractContentWindow,
 * isInModifiedRange, extractModifiedFunctionNames and generateCallGraphFromAST
 * — are module-private. They are exercised through the three exported entry
 * points that call them: generateCallGraphFromJSON (no cache, reads fresh),
 * generateCallGraph (drives generateCallGraphFromAST → extractModifiedFunctionNames
 * → isInModifiedRange) and generateAssembledReviewContext (drives isTestLikePath,
 * extractContentWindow and extractModifiedFunctionNames).
 *
 * The private module-level `astCache` is keyed by repoKey and would leak state
 * across tests, so every test that touches the AST/assembled paths requires a
 * FRESH module instance via jest.isolateModules (see freshHelper).
 * generateCallGraphFromJSON has no cache, so it is imported once at the top.
 */

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
    prevEnv = process.env.CALLGRAPH_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-helper-'));
    process.env.CALLGRAPH_DIR = tmpDir;
});

afterEach(() => {
    if (prevEnv === undefined) delete process.env.CALLGRAPH_DIR;
    else process.env.CALLGRAPH_DIR = prevEnv;
    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
});

function writeGraph(repoKey: string, data: unknown): void {
    const dir = path.join(tmpDir, repoKey);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
        path.join(dir, 'call-graph.json'),
        typeof data === 'string' ? data : JSON.stringify(data),
        'utf8',
    );
}

// Fresh module instance → pristine astCache. Reads process.env.CALLGRAPH_DIR
// lazily at call time, so setting the env in beforeEach is enough.
function freshHelper(): {
    generateCallGraph: (
        remoteCommands: unknown,
        changedFiles: unknown,
        repositoryFullName?: string,
    ) => Promise<string>;
    generateAssembledReviewContext: (
        remoteCommands: unknown,
        changedFiles: unknown,
        repositoryFullName?: string,
    ) => Promise<string>;
} {
    let mod: any;
    jest.isolateModules(() => {
        mod = require('./call-graph.helper');
    });
    return mod;
}

const AST_HEADER = 'Changed functions and their production callers (AST):\n\n';

// A patch that defines `processPayment` on line 10 of the +side.
// @@ -1,3 +10,4 @@ → new-side hunk starts at line 10.
const processPaymentPatch = [
    '@@ -1,3 +10,4 @@',
    '+export function processPayment(amount) {',
    '   const x = 1;',
    '   return x;',
].join('\n');

// ===========================================================================
// generateCallGraph → generateCallGraphFromAST (+ extractModifiedFunctionNames,
// isInModifiedRange)
// ===========================================================================

describe('generateCallGraph (AST path)', () => {
    const inertRemote = {} as any; // AST path never touches remoteCommands

    it('formats an entry with callers and callees exactly', async () => {
        writeGraph('sentry', {
            k1: {
                name: 'processPaymentFull', // deliberately != func.name
                short_name: 'processPayment',
                parent: '',
                file: 'src/service/foo.ts',
                line: 10,
                language: 'ts',
                callers: [
                    { file: 'src/api/checkout.ts', line: 5, name: 'checkout' },
                    { file: 'src/api/order.ts', line: 7 }, // no name → else branch
                ],
                callees: [
                    { name: 'chargeCard', file: 'src/lib/card.ts', line: 99 },
                ],
            },
        });

        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            inertRemote,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        const expected =
            AST_HEADER +
            [
                'processPaymentFull (service/foo.ts:10)',
                '  ← api/checkout.ts:5 (checkout)',
                '  ← api/order.ts:7',
                '  → calls: chargeCard (lib/card.ts:99)',
            ].join('\n');

        // Pins: header literal, entry.name (not func.name) used in caller
        // branch, shortFile slice(-2), '  ← ' / '  → calls: ' markers, the
        // caller-name ternary (both branches), ordering and calleeSection.
        expect(result).toBe(expected);
    });

    it('caps callers at MAX_CALLERS_PER_FUNCTION (4)', async () => {
        writeGraph('sentry', {
            k1: {
                name: 'processPayment',
                short_name: 'processPayment',
                parent: '',
                file: 'src/service/foo.ts',
                line: 10,
                language: 'ts',
                callers: [
                    { file: 'p/c1.ts', line: 1 },
                    { file: 'p/c2.ts', line: 2 },
                    { file: 'p/c3.ts', line: 3 },
                    { file: 'p/c4.ts', line: 4 },
                    { file: 'p/c5.ts', line: 5 },
                ],
                callees: [],
            },
        });

        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            inertRemote,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        expect(result).toContain('c4.ts:4'); // 4th kept
        expect(result).not.toContain('c5.ts:5'); // 5th dropped
    });

    it('caps callees at 5', async () => {
        writeGraph('sentry', {
            k1: {
                name: 'processPayment',
                short_name: 'processPayment',
                parent: '',
                file: 'src/service/foo.ts',
                line: 10,
                language: 'ts',
                callers: [{ file: 'x/x.ts', line: 1 }],
                callees: [
                    { name: 'd1', file: 'p/d1.ts', line: 1 },
                    { name: 'd2', file: 'p/d2.ts', line: 2 },
                    { name: 'd3', file: 'p/d3.ts', line: 3 },
                    { name: 'd4', file: 'p/d4.ts', line: 4 },
                    { name: 'd5', file: 'p/d5.ts', line: 5 },
                    { name: 'd6', file: 'p/d6.ts', line: 6 },
                ],
            },
        });

        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            inertRemote,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        expect(result).toContain('d5.ts:5'); // 5th kept
        expect(result).not.toContain('d6.ts:6'); // 6th dropped
    });

    it('emits the no-callers line and still appends callees when callers is empty', async () => {
        writeGraph('sentry', {
            k1: {
                name: 'processPaymentFull',
                short_name: 'processPayment',
                parent: '',
                file: 'src/service/foo.ts',
                line: 10,
                language: 'ts',
                callers: [],
                callees: [{ name: 'onlyCallee', file: 'src/z/z.ts', line: 3 }],
            },
        });

        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            inertRemote,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        const expected =
            AST_HEADER +
            [
                'processPaymentFull (service/foo.ts:10)',
                '  (no callers — interface impl or new function)',
                '  → calls: onlyCallee (z/z.ts:3)',
            ].join('\n');

        expect(result).toBe(expected);
    });

    it('falls back to the modified-function name when no AST entry matches', async () => {
        writeGraph('sentry', {
            k1: {
                name: 'unrelated',
                short_name: 'unrelated',
                parent: '',
                file: 'src/other/bar.ts',
                line: 1,
                language: 'ts',
                callers: [{ file: 'a/a.ts', line: 1 }],
                callees: [],
            },
        });

        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            inertRemote,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        // No candidate for 'processPayment' → entry undefined → func.name used.
        const expected =
            AST_HEADER +
            'processPayment (service/foo.ts:10)\n' +
            '  (no callers — interface impl or new function)';
        expect(result).toBe(expected);
    });

    it('uses candidates[0] when exactly 5 candidates and none path-match (<= 5 boundary)', async () => {
        const entries: Record<string, unknown> = {};
        for (let i = 0; i < 5; i++) {
            entries[`k${i}`] = {
                name: `CAND${i}`,
                short_name: 'processPayment',
                parent: '',
                file: `zzz/a${i}.ts`, // func.file does NOT endWith any of these
                line: 1,
                language: 'ts',
                callers: i === 0 ? [{ file: 'q/q.ts', line: 1 }] : [],
                callees: [],
            };
        }
        writeGraph('sentry', entries);

        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            inertRemote,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        expect(result).toContain('CAND0 (service/foo.ts:10)');
        expect(result).toContain('  ← q/q.ts:1');
    });

    it('does NOT use candidates[0] when 6 candidates (> 5 boundary)', async () => {
        const entries: Record<string, unknown> = {};
        for (let i = 0; i < 6; i++) {
            entries[`k${i}`] = {
                name: `CAND${i}`,
                short_name: 'processPayment',
                parent: '',
                file: `zzz/a${i}.ts`,
                line: 1,
                language: 'ts',
                callers: i === 0 ? [{ file: 'q/q.ts', line: 1 }] : [],
                callees: [],
            };
        }
        writeGraph('sentry', entries);

        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            inertRemote,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        // 6 > 5 → entry stays undefined → func.name + no-callers line.
        expect(result).toContain(
            'processPayment (service/foo.ts:10)\n  (no callers — interface impl or new function)',
        );
        expect(result).not.toContain('CAND0');
    });

    it('returns "" when the repository does not map to a known key', async () => {
        writeGraph('sentry', { k1: {} });
        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            {} as any, // no exec → grep fallback yields ''
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/unknown-repo-xyz',
        );
        expect(result).toBe('');
    });

    it('returns "" when the AST json file is absent', async () => {
        // grafana maps, but we never write its file
        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            {} as any,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/grafana',
        );
        expect(result).toBe('');
    });

    it('returns "" when the diff contains no extractable function definitions', async () => {
        writeGraph('sentry', { k1: {} });
        const { generateCallGraph } = freshHelper();
        const result = await generateCallGraph(
            {} as any,
            [
                {
                    filename: 'src/service/foo.ts',
                    patch: '@@ -1,1 +1,1 @@\n+just some code line',
                },
            ],
            'owner/sentry',
        );
        expect(result).toBe('');
    });
});

// ===========================================================================
// generateAssembledReviewContext → isTestLikePath, extractContentWindow,
// extractModifiedFunctionNames, isInModifiedRange
// ===========================================================================

describe('generateAssembledReviewContext (isTestLikePath filtering)', () => {
    it('drops every test-like caller and keeps the real production caller', async () => {
        const testLikeCallers = [
            { file: 'a/test/one.ts', line: 1 }, // /test
            { file: 'a/tests/two.ts', line: 2 }, // /tests
            { file: 'a/spec/three.ts', line: 3 }, // /spec
            { file: 'a/__tests__/four.ts', line: 4 }, // __tests__
            { file: 'a/five_test.go', line: 5 }, // _test.go
            { file: 'a/six_test.py', line: 6 }, // _test.py
            { file: 'a/seven.spec.ts', line: 7 }, // .spec.ts
            { file: 'a/eight.spec.tsx', line: 8 }, // .spec.tsx
            { file: 'a/nine.test.ts', line: 9 }, // .test.ts
            { file: 'a/ten.test.tsx', line: 10 }, // .test.tsx
            { file: 'a/eleven.spec.js', line: 11 }, // .spec.js
            { file: 'a/twelve.test.js', line: 12 }, // .test.js
            { file: 'a/SPEC/THIRTEEN.TS', line: 13 }, // toLowerCase → /spec
        ];

        writeGraph('sentry', {
            k1: {
                name: 'processPayment',
                short_name: 'processPayment',
                parent: '',
                file: 'src/service/foo.ts',
                line: 10,
                language: 'ts',
                callers: [
                    ...testLikeCallers,
                    {
                        file: 'src/service/realCaller.ts',
                        line: 42,
                        name: 'checkout',
                    },
                ],
                callees: [],
            },
        });

        const { generateAssembledReviewContext } = freshHelper();
        const remoteCommands = { read: jest.fn(async () => '') } as any;
        const result = await generateAssembledReviewContext(
            remoteCommands,
            [{ filename: 'src/service/foo.ts', patch: processPaymentPatch }],
            'owner/sentry',
        );

        // The one non-test caller survives...
        expect(result).toContain('src/service/realCaller.ts:42');
        // ...and every test-like variant is filtered out. A mutant that
        // breaks any single isTestLikePath clause lets exactly one of these
        // leak into the output.
        for (const marker of [
            'one.ts',
            'two.ts',
            'three.ts',
            'four.ts',
            'five_test.go',
            'six_test.py',
            'seven.spec.ts',
            'eight.spec.tsx',
            'nine.test.ts',
            'ten.test.tsx',
            'eleven.spec.js',
            'twelve.test.js',
            'THIRTEEN',
        ]) {
            expect(result).not.toContain(marker);
        }
    });
});

describe('generateAssembledReviewContext (extractContentWindow fallback)', () => {
    it('returns N/A when the file content is empty', async () => {
        writeGraph('sentry', {});
        const { generateAssembledReviewContext } = freshHelper();
        const remoteCommands = { read: jest.fn(async () => '') } as any;
        const result = await generateAssembledReviewContext(
            remoteCommands,
            [
                {
                    filename: 'src/win.ts',
                    patch: '@@ -1,1 +5,1 @@\n+export function windowFunc(z) {',
                    fileContent: '',
                },
            ],
            'owner/sentry',
        );

        expect(result).toContain('### windowFunc (src/win.ts:5)');
        expect(result).toContain('Changed snippet:\n```\nN/A\n```');
    });

    it('extracts a centered window with 1-based line numbers (interior boundaries)', async () => {
        // 30-line file; center = line 12, radius = CHANGED_SNIPPET_RADIUS (10).
        // start = max(1, 12-10) = 2, end = min(30, 12+10) = 22.
        const content30 = Array.from(
            { length: 30 },
            (_, i) => `C${i + 1}`,
        ).join('\n');
        const expectedWindow = Array.from(
            { length: 21 },
            (_, i) => `${i + 2}: C${i + 2}`,
        ).join('\n');

        writeGraph('sentry', {});
        const { generateAssembledReviewContext } = freshHelper();
        const remoteCommands = { read: jest.fn(async () => '') } as any;
        const result = await generateAssembledReviewContext(
            remoteCommands,
            [
                {
                    filename: 'src/win.ts',
                    patch: '@@ -1,1 +12,1 @@\n+export function windowFunc(z) {',
                    fileContent: content30,
                },
            ],
            'owner/sentry',
        );

        expect(result).toContain(
            'Changed snippet:\n```\n' + expectedWindow + '\n```',
        );
        // Below-start line clamped away and above-end line (Math.min picks
        // center+radius=22, not lines.length=30) never appears.
        expect(result).not.toContain('23: C23');
    });

    it('clamps the window start to line 1 when center - radius < 1 (Math.max)', async () => {
        writeGraph('sentry', {});
        const { generateAssembledReviewContext } = freshHelper();
        const remoteCommands = { read: jest.fn(async () => '') } as any;
        const result = await generateAssembledReviewContext(
            remoteCommands,
            [
                {
                    filename: 'src/win.ts',
                    patch: '@@ -1,1 +1,1 @@\n+export function edgeWindow(z) {',
                    fileContent: 'A\nB\nC',
                },
            ],
            'owner/sentry',
        );

        // center=1, radius=10 → start=max(1,-9)=1, end=min(3,11)=3.
        expect(result).toContain(
            'Changed snippet:\n```\n1: A\n2: B\n3: C\n```',
        );
    });
});

describe('generateAssembledReviewContext (extractModifiedFunctionNames)', () => {
    const rcRead = { read: jest.fn(async () => '') } as any;

    it('honours the isInModifiedRange +/-5 margin boundary', async () => {
        writeGraph('sentry', {});
        const { generateAssembledReviewContext } = freshHelper();

        // Hunk declares range [1,1]. Five context lines push the first
        // definition to line 6 (in range: 6 <= 1+5) and the second to line 7
        // (out of range: 7 > 1+5).
        const patch = [
            '@@ -1,1 +1,1 @@',
            '+ctx line one aaaa',
            '+ctx line two aaaa',
            '+ctx line three aa',
            '+ctx line four aaa',
            '+ctx line five aaa',
            '+export function inRangeFunc(x) {',
            '+export function outRangeFunc(y) {',
        ].join('\n');

        const result = await generateAssembledReviewContext(
            rcRead,
            [{ filename: 'src/rng.ts', patch }],
            'owner/sentry',
        );

        expect(result).toContain('### inRangeFunc (src/rng.ts:6)');
        expect(result).not.toContain('outRangeFunc');
    });

    it('applies the name filters (length >= 5, noise set), skips - lines, dedups first-wins', async () => {
        writeGraph('sentry', {});
        const { generateAssembledReviewContext } = freshHelper();

        const patch = [
            '@@ -1,20 +1,20 @@',
            '+export function goodFunctionName(a) {',
            '+export function abcd(b) {', // len 4 < 5 → dropped
            '+export function validate(c) {', // NOISE_NAMES → dropped
            '-export function removedFunction(d) {', // '-' line → ignored
            '+export function goodFunctionName(e) {', // duplicate → dropped
        ].join('\n');

        const result = await generateAssembledReviewContext(
            rcRead,
            [{ filename: 'src/b.ts', patch }],
            'owner/sentry',
        );

        // First occurrence wins → line 1, not the line-4 duplicate.
        expect(result).toContain('### goodFunctionName (src/b.ts:1)');
        expect(result).not.toContain('(src/b.ts:4)');
        expect((result.match(/goodFunctionName/g) || []).length).toBe(1);
        expect(result).not.toContain('abcd');
        expect(result).not.toContain('validate');
        expect(result).not.toContain('removedFunction');
    });

    it('extracts the function name from the hunk header context (line = start)', async () => {
        writeGraph('sentry', {});
        const { generateAssembledReviewContext } = freshHelper();

        const patch = [
            '@@ -1,1 +5,3 @@ function contextFunc() {',
            '+   const y = 2;',
        ].join('\n');

        const result = await generateAssembledReviewContext(
            rcRead,
            [{ filename: 'src/c.ts', patch }],
            'owner/sentry',
        );

        // hunk starts at 5 → currentLine=4 → line = currentLine + 1 = 5.
        expect(result).toContain('### contextFunc (src/c.ts:5)');
    });

    it('returns "" when the patch has no valid hunk header', async () => {
        writeGraph('sentry', {});
        const { generateAssembledReviewContext } = freshHelper();

        const result = await generateAssembledReviewContext(
            rcRead,
            [
                {
                    filename: 'src/d.ts',
                    patch: 'no hunk header here\n+export function shouldNotAppear(x) {',
                },
            ],
            'owner/sentry',
        );

        expect(result).toBe('');
    });
});

// ===========================================================================
// generateCallGraphFromJSON — exported, no cache
// ===========================================================================

describe('generateCallGraphFromJSON', () => {
    it('returns "" without a repository name', () => {
        expect(
            generateCallGraphFromJSON([{ filename: 'a.ts' }], undefined),
        ).toBe('');
    });

    it('returns "" with no changed files', () => {
        expect(generateCallGraphFromJSON([], 'owner/sentry')).toBe('');
    });

    it('returns "" when the repo does not map to a known key', () => {
        expect(
            generateCallGraphFromJSON([{ filename: 'a.ts' }], 'owner/nope'),
        ).toBe('');
    });

    it('returns "" when the json file is missing', () => {
        expect(
            generateCallGraphFromJSON([{ filename: 'a.ts' }], 'owner/keycloak'),
        ).toBe('');
    });

    it('returns "" when the json file is invalid (catch fallback)', () => {
        writeGraph('grafana', 'not json{');
        expect(
            generateCallGraphFromJSON([{ filename: 'a.ts' }], 'owner/grafana'),
        ).toBe('');
    });

    it('resolves the repo key case-insensitively (toLowerCase fallback)', () => {
        writeGraph('sentry', {
            a: {
                kind: 'Function',
                name: 'anyFn',
                file: 'src/mod/a.ts',
                line: 1,
                callers: [],
                callees: [],
            },
        });
        const result = generateCallGraphFromJSON(
            [{ filename: 'src/mod/a.ts' }],
            'owner/SENTRY',
        );
        expect(result.startsWith('Changed functions')).toBe(true);
    });

    it('formats matched functions with sig/return/callers/callees exactly', () => {
        writeGraph('sentry', {
            a: {
                kind: 'Function',
                name: 'longNameA',
                short_name: 'shortA', // short_name preferred over name
                file: 'src/mod/a.ts',
                line: 12,
                params: '(x: number)',
                returnType: 'string',
                callers: [
                    { name: 'c1', file: 'src/x/one.ts', line: 1 },
                    { name: 'c2', file: 'src/x/two.ts', line: 2 },
                    { name: 'c3', file: 'src/x/three.ts', line: 3 },
                    { name: 'c4', file: 'src/x/four.ts', line: 4 },
                    { name: 'c5', file: 'src/x/five.ts', line: 5 },
                    { name: 'c6', file: 'src/x/six.ts', line: 6 }, // > MAX_CALLERS(5)
                ],
                callees: [
                    {
                        name: 'd1',
                        file: 'src/y/one.ts',
                        line: 1,
                        params: '(a)',
                        returnType: 'void',
                    },
                    { name: 'd2', file: 'src/y/two.ts', line: 2 },
                    { name: 'd3', file: 'src/y/three.ts', line: 3 },
                    { name: 'd4', file: 'src/y/four.ts', line: 4 }, // > MAX_CALLEES(3)
                ],
            },
            skip: {
                kind: 'Class', // not a Function → excluded even though file matches
                name: 'ClassThing',
                file: 'src/mod/a.ts',
                line: 1,
                callers: [],
                callees: [],
            },
            nomatch: {
                kind: 'Function',
                name: 'noMatchFn',
                file: 'totally/other.ts', // neither endsWith direction matches
                line: 1,
                callers: [],
                callees: [],
            },
            nocaller: {
                kind: 'Function',
                name: 'noCallerFn',
                short_name: 'noCallerFn',
                file: 'src/mod/a.ts',
                line: 50,
                // no params, no returnType → bare name, no ' -> '
                callers: [], // → '(no production callers found)'
                callees: [
                    {
                        name: 'e1',
                        file_path: 'src/w/one.ts', // file_path fallback
                        line_start: 9, // line_start fallback
                        return_type: 'int', // return_type fallback
                    },
                ],
            },
        });

        const result = generateCallGraphFromJSON(
            [{ filename: 'src/mod/a.ts' }],
            'owner/sentry',
        );

        const sectionA = [
            'shortA(x: number) -> string  (mod/a.ts:12)',
            '  ← called by c1 (x/one.ts:1)',
            '  ← called by c2 (x/two.ts:2)',
            '  ← called by c3 (x/three.ts:3)',
            '  ← called by c4 (x/four.ts:4)',
            '  ← called by c5 (x/five.ts:5)',
            '  → calls d1(a) -> void  (y/one.ts:1)',
            '  → calls d2  (y/two.ts:2)',
            '  → calls d3  (y/three.ts:3)',
        ].join('\n');

        const sectionNoCaller = [
            'noCallerFn  (mod/a.ts:50)',
            '  (no production callers found)',
            '  → calls e1 -> int  (w/one.ts:9)',
        ].join('\n');

        const expected =
            'Changed functions and their production callers (AST):\n\n' +
            sectionA +
            '\n\n' +
            sectionNoCaller;

        expect(result).toBe(expected);
    });

    it('falls back to "?" when a callee has neither line nor line_start', () => {
        writeGraph('sentry', {
            q: {
                kind: 'Function',
                name: 'qFn',
                file: 'src/mod/a.ts',
                line: 3,
                callers: [],
                callees: [{ name: 'noLine', file: 'src/z/z.ts' }],
            },
        });

        const result = generateCallGraphFromJSON(
            [{ filename: 'src/mod/a.ts' }],
            'owner/sentry',
        );

        expect(result).toContain('  → calls noLine  (z/z.ts:?)');
    });

    it('matches via the reverse endsWith direction (entryFile endsWith changed path)', () => {
        writeGraph('sentry', {
            e: {
                kind: 'Function',
                name: 'reverseMatch',
                file: 'src/services/ecom.ts', // endsWith the changed 'ecom.ts'
                line: 4,
                callers: [],
                callees: [],
            },
        });

        const result = generateCallGraphFromJSON(
            [{ filename: 'ecom.ts' }],
            'owner/sentry',
        );

        expect(result).toContain('reverseMatch  (services/ecom.ts:4)');
    });

    it('dedups identical name:file:line entries (first wins)', () => {
        writeGraph('sentry', {
            d1: {
                kind: 'Function',
                name: 'dupFn',
                file: 'src/mod/a.ts',
                line: 7,
                callers: [],
                callees: [],
            },
            d2: {
                kind: 'Function',
                name: 'dupFn',
                file: 'src/mod/a.ts',
                line: 7,
                callers: [],
                callees: [],
            },
        });

        const result = generateCallGraphFromJSON(
            [{ filename: 'src/mod/a.ts' }],
            'owner/sentry',
        );

        expect((result.match(/dupFn/g) || []).length).toBe(1);
    });

    it('truncates output above MAX_CALLGRAPH_CHARS (6000)', () => {
        const entries: Record<string, unknown> = {};
        for (let i = 0; i < 60; i++) {
            entries[`k${i}`] = {
                kind: 'Function',
                name: 'F' + 'x'.repeat(200) + i,
                file: 'src/mod/a.ts',
                line: i + 1,
                callers: [],
                callees: [],
            };
        }
        writeGraph('sentry', entries);

        const result = generateCallGraphFromJSON(
            [{ filename: 'src/mod/a.ts' }],
            'owner/sentry',
        );

        expect(result.endsWith('\n... (truncated)')).toBe(true);
        // 6000 chars + '\n... (truncated)' (16 chars)
        expect(result.length).toBe(6016);
    });
});
