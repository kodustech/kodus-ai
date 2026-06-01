import { KodyRulesAgentProvider } from './kody-rules-agent.provider';
import {
    KodyRulesScope,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

describe('KodyRulesAgentProvider — rule formatting and applicability', () => {
    let provider: KodyRulesAgentProvider;

    const formatRules = (rules: any[], changedFiles: any[]): string =>
        (provider as any).formatKodyRules(rules, changedFiles);

    const matches = (filePath: string, pattern: string): boolean =>
        (provider as any).matchesPathPattern(filePath, pattern);

    beforeEach(() => {
        provider = new KodyRulesAgentProvider(
            {} as any, // promptRunnerService
            {} as any, // permissionValidationService
            {} as any, // observabilityService
        );
    });

    describe('formatKodyRules — simple rules', () => {
        it('emits a single rule with title, UUID, and description', () => {
            const rules = [
                {
                    uuid: 'aaaa-1111',
                    title: 'No console.log',
                    rule: 'Avoid console.log in production code.',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                },
            ];
            const changedFiles = [{ filename: 'src/foo.ts' }];

            const out = formatRules(rules, changedFiles);

            expect(out).toContain('Team Rules to Validate (1 rules)');
            expect(out).toContain('### Rule 1: No console.log');
            expect(out).toContain('**UUID**: `aaaa-1111`');
            expect(out).toContain(
                '**Description**: Avoid console.log in production code.',
            );
        });

        it('numbers multiple rules sequentially', () => {
            const rules = [
                {
                    uuid: 'r1',
                    title: 'Rule One',
                    rule: 'one',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                },
                {
                    uuid: 'r2',
                    title: 'Rule Two',
                    rule: 'two',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                },
                {
                    uuid: 'r3',
                    title: 'Rule Three',
                    rule: 'three',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                },
            ];

            const out = formatRules(rules, [{ filename: 'a.ts' }]);

            expect(out).toContain('### Rule 1: Rule One');
            expect(out).toContain('### Rule 2: Rule Two');
            expect(out).toContain('### Rule 3: Rule Three');
            expect(out).toContain('Team Rules to Validate (3 rules)');
        });

        it('returns empty string when no rules match changed files (path filter)', () => {
            const rules = [
                {
                    uuid: 'r-py',
                    title: 'Python only',
                    rule: 'x',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                    path: '**/*.py',
                },
            ];
            const changedFiles = [{ filename: 'src/foo.ts' }];

            const out = formatRules(rules, changedFiles);
            expect(out).toBe('');
        });

        it('includes the file scope marker for per-file rules', () => {
            const rules = [
                {
                    uuid: 'r-file',
                    title: 'File scope',
                    rule: 'x',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                    scope: KodyRulesScope.FILE,
                },
            ];
            const out = formatRules(rules, [{ filename: 'a.ts' }]);
            expect(out).toContain('**Scope**: Per-file');
        });

        it('includes the PR-level scope marker for pull-request rules', () => {
            const rules = [
                {
                    uuid: 'r-pr',
                    title: 'PR scope',
                    rule: 'every PR must have tests',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                    scope: KodyRulesScope.PULL_REQUEST,
                },
            ];
            const out = formatRules(rules, [{ filename: 'a.ts' }]);
            expect(out).toContain('**Scope**: Pull request level');
        });
    });

    describe('formatKodyRules — examples', () => {
        it('renders correct and incorrect examples as fenced code blocks', () => {
            const rules = [
                {
                    uuid: 'r-ex',
                    title: 'Naming',
                    rule: 'use camelCase',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                    examples: [
                        { isCorrect: true, snippet: 'const fooBar = 1;' },
                        { isCorrect: false, snippet: 'const foo_bar = 1;' },
                    ],
                },
            ];
            const out = formatRules(rules, [{ filename: 'a.ts' }]);

            expect(out).toContain('**Examples**:');
            expect(out).toContain('- Correct:');
            expect(out).toContain('const fooBar = 1;');
            expect(out).toContain('- Incorrect:');
            expect(out).toContain('const foo_bar = 1;');
        });
    });

    describe('formatKodyRules — external file reference', () => {
        it('hints at readFile for an in-repo path and surfaces readReference as the cross-repo fallback', () => {
            const rules = [
                {
                    uuid: 'r-ext',
                    title: 'External convention',
                    rule: 'follow the company guide',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                    sourcePath: 'docs/conventions.md',
                },
            ];
            const out = formatRules(rules, [{ filename: 'a.ts' }]);

            expect(out).toContain('**Reference**: `docs/conventions.md`');
            expect(out).toContain('use readFile');
            expect(out).toContain('readReference');
        });

        it('mentions both readFile and readReference for cross-repo-shaped source paths so the LLM can choose', () => {
            const rules = [
                {
                    uuid: 'r-ext-cross',
                    title: 'Cross-repo convention',
                    rule: 'follow the company guide',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                    sourcePath: 'kodustech/design-system/docs/conventions.md',
                },
            ];
            const out = formatRules(rules, [{ filename: 'a.ts' }]);

            expect(out).toContain(
                '**Reference**: `kodustech/design-system/docs/conventions.md`',
            );
            expect(out).toContain('use readFile');
            expect(out).toContain('readReference');
        });

        it('appends the section anchor to the Reference line when sourceAnchor is set', () => {
            const rules = [
                {
                    uuid: 'r-ext-anchor',
                    title: 'External anchored convention',
                    rule: 'follow the company guide',
                    type: KodyRulesType.STANDARD,
                    status: 'active',
                    sourcePath: 'docs/conventions.md',
                    sourceAnchor: 'Naming',
                },
            ];
            const out = formatRules(rules, [{ filename: 'a.ts' }]);

            expect(out).toContain(
                '**Reference**: `docs/conventions.md` (section: Naming)',
            );
        });
    });

    describe('matchesPathPattern', () => {
        it.each([
            // Exact match
            { path: 'src/foo.ts', pattern: 'src/foo.ts', expected: true },
            // Directory prefix
            {
                path: 'src/controllers/x.ts',
                pattern: 'src/controllers/',
                expected: true,
            },
            // Single * — does not cross /
            { path: 'foo.ts', pattern: '*.ts', expected: true },
            { path: 'src/foo.ts', pattern: 'src/*.ts', expected: true },
            { path: 'src/sub/foo.ts', pattern: 'src/*.ts', expected: false },
            // Double ** — crosses /
            { path: 'src/foo.ts', pattern: '**/*.ts', expected: true },
            { path: 'src/sub/foo.ts', pattern: '**/*.ts', expected: true },
            { path: 'src/foo.py', pattern: '**/*.ts', expected: false },
            { path: 'src/sub/foo.ts', pattern: 'src/**/*.ts', expected: true },
            // Dots in the path stay literal (not regex any-char)
            {
                path: 'src.with.dots/x.ts',
                pattern: '**/x.ts',
                expected: true,
            },
            {
                path: 'srcXwithXdots/x.ts',
                pattern: 'src.with.dots/x.ts',
                expected: false, // literal dots in pattern, not regex .
            },
        ])(
            '$path matches $pattern → $expected',
            ({ path, pattern, expected }) => {
                expect(matches(path, pattern)).toBe(expected);
            },
        );
    });

    describe('getCategoryPrompt — composition with per-request rules', () => {
        it('includes the base rules-checking instructions when no rules are passed', () => {
            const out = (provider as any).getCategoryPrompt({
                kodyRules: [],
                changedFiles: [],
            });
            expect(out).toContain('Focus: Team Rules & Conventions');
            expect(out).not.toContain('Team Rules to Validate');
        });

        it('appends the formatted rules block when rules are passed via input', () => {
            const out = (provider as any).getCategoryPrompt({
                kodyRules: [
                    {
                        uuid: 'r1',
                        title: 'Test',
                        rule: 'x',
                        type: KodyRulesType.STANDARD,
                        status: 'active',
                    },
                ],
                changedFiles: [{ filename: 'a.ts' }],
            });
            expect(out).toContain('Focus: Team Rules & Conventions');
            expect(out).toContain('Team Rules to Validate (1 rules)');
            expect(out).toContain('### Rule 1: Test');
        });

        it('does not leak rules across calls (no shared state)', () => {
            // First call: rules present.
            (provider as any).getCategoryPrompt({
                kodyRules: [
                    {
                        uuid: 'r1',
                        title: 'LeakCheck',
                        rule: 'x',
                        type: KodyRulesType.STANDARD,
                        status: 'active',
                    },
                ],
                changedFiles: [{ filename: 'a.ts' }],
            });
            // Second call with no rules: must NOT mention the previous rule.
            const out = (provider as any).getCategoryPrompt({
                kodyRules: [],
                changedFiles: [{ filename: 'b.ts' }],
            });
            expect(out).not.toContain('LeakCheck');
            expect(out).not.toContain('Team Rules to Validate');
        });
    });

    describe('execute — short-circuits before calling LLM', () => {
        it('returns empty suggestions when no rules are provided', async () => {
            const result = await provider.execute({
                kodyRules: [],
                changedFiles: [],
            } as any);

            expect(result.suggestions).toEqual([]);
            expect(result.agentName).toBe('kodus-rules-review-agent');
            expect(result.turnsUsed).toBe(0);
        });

        it('filters out MEMORY-type rules (those are handled by other agents)', async () => {
            const result = await provider.execute({
                kodyRules: [
                    {
                        uuid: 'mem-1',
                        title: 'memory only',
                        rule: 'x',
                        type: KodyRulesType.MEMORY,
                        status: 'active',
                    },
                ],
                changedFiles: [{ filename: 'a.ts' }],
            } as any);

            // Only MEMORY rule → after filter, nothing applicable → empty result
            expect(result.suggestions).toEqual([]);
            expect(result.turnsUsed).toBe(0);
        });

        it('filters out inactive rules', async () => {
            const result = await provider.execute({
                kodyRules: [
                    {
                        uuid: 'inactive-1',
                        title: 'disabled',
                        rule: 'x',
                        type: KodyRulesType.STANDARD,
                        status: 'inactive',
                    },
                ],
                changedFiles: [{ filename: 'a.ts' }],
            } as any);

            expect(result.suggestions).toEqual([]);
        });
    });
});
