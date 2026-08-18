import { KodyRulesAgentProvider } from '@libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider';
import {
    KodyRulesScope,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';

// The sharded judge now runs on the LOCAL (Vercel) stack via
// runStructuredReviewCall; mock it at that boundary (one canned response per
// shard call) instead of the old kodus-common builder.
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: jest.fn(),
}));
const mockRunStructuredReviewCall = runStructuredReviewCall as jest.Mock;

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

// ── end-to-end wiring of the sharded execute() (#1449) ───────────────────────
// Drives the REAL execute() — model resolution, BYOK runner construction, the
// mechanical/semantic split, the sharded judge, and the merge through
// mapAgentFindings — with the LLM mocked at the builder boundary. Catches
// provider wiring bugs without a live model or a Nest bootstrap.
describe('KodyRulesAgentProvider.execute — sharded end-to-end (#1449)', () => {
    // Chainable builder mock: config methods return `this`; execute() returns
    // the next canned response (one per shard call).
    function makeProvider(responses: any[]) {
        let i = 0;
        mockRunStructuredReviewCall.mockReset();
        mockRunStructuredReviewCall.mockImplementation(
            async () => responses[i++] ?? { violations: [] },
        );
        const provider = new KodyRulesAgentProvider(
            {} as any, // promptRunnerService (unused — local stack)
            { getBYOKConfig: jest.fn(async () => null) } as any, // permission (system model)
            {} as any, // observability (unused — runStructuredReviewCall mocked)
        );
        return { provider, judge: mockRunStructuredReviewCall };
    }

    const input = (over: any = {}) => ({
        prNumber: 1,
        organizationAndTeamData: {
            organizationId: '11111111-1111-1111-1111-111111111111',
            teamId: '22222222-2222-2222-2222-222222222222',
        },
        changedFiles: [
            {
                filename: 'src/a.ts',
                patchWithLinesStr:
                    '10 +console.log(1)\n11 +const x: any = 2',
                patch: '10 +console.log(1)\n11 +const x: any = 2',
            },
        ],
        remoteCommands: undefined,
        prTitle: 'test',
        prBody: '',
        ...over,
    });

    it('semantic path: judge violations become tagged CodeSuggestions', async () => {
        const { provider } = makeProvider([
            {
                violations: [
                    {
                        ruleId: 1, // → the shard's only rule: no-any
                        relevantLinesStart: 11,
                        relevantLinesEnd: 11,
                        existingCode: 'const x: any = 2',
                        suggestionContent: 'avoid any',
                        oneSentenceSummary: 'no any',
                    },
                ],
            },
        ]);
        const out = await provider.execute(
            input({
                kodyRules: [
                    {
                        uuid: 'no-any',
                        title: 'no any',
                        rule: 'do not use any',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                    },
                ],
            }) as any,
        );
        expect(out.suggestions).toHaveLength(1);
        expect((out.suggestions[0] as any).brokenKodyRulesIds).toEqual([
            'no-any',
        ]);
        expect(out.suggestions[0].relevantFile).toBe('src/a.ts');
    });

    // ── language resolution + forwarding (Starian GitLab MR !16111) ──────────
    // The sharded judge's system prompts have zero language templating on
    // their own; execute() must resolve `input.languageResultPrompt` via the
    // SAME `resolveLanguageLabel` helper the other review agents use
    // (prompt-builder.ts) and forward it into the shard user prompt that
    // `runStructuredReviewCall` receives as `user`.
    it('resolves languageResultPrompt and forwards a respond-in-language instruction to the shard prompt', async () => {
        const { provider } = makeProvider([{ violations: [] }]);
        await provider.execute(
            input({
                languageResultPrompt: 'pt-BR',
                kodyRules: [
                    {
                        uuid: 'no-any',
                        title: 'no any',
                        rule: 'do not use any',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                    },
                ],
            }) as any,
        );
        expect(mockRunStructuredReviewCall).toHaveBeenCalledTimes(1);
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.user).toContain('Respond in');
        expect(call.user.toLowerCase()).toContain('portuguese');
    });

    it('does NOT add a language instruction when languageResultPrompt is absent (no regression)', async () => {
        const { provider } = makeProvider([{ violations: [] }]);
        await provider.execute(
            input({
                kodyRules: [
                    {
                        uuid: 'no-any',
                        title: 'no any',
                        rule: 'do not use any',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                    },
                ],
            }) as any,
        );
        expect(mockRunStructuredReviewCall).toHaveBeenCalledTimes(1);
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.user).not.toContain('Respond in');
    });

    it('mechanical path: detector regex fires with ZERO LLM calls', async () => {
        const { provider, judge } = makeProvider([]);
        const out = await provider.execute(
            input({
                kodyRules: [
                    {
                        uuid: 'no-console',
                        title: 'no console',
                        rule: 'no console.log',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                        detector: {
                            type: 'regex',
                            pattern: 'console\\.(log|warn|error)\\(',
                        },
                    },
                ],
            }) as any,
        );
        expect(judge).not.toHaveBeenCalled();
        expect(out.suggestions).toHaveLength(1);
        expect((out.suggestions[0] as any).brokenKodyRulesIds).toEqual([
            'no-console',
        ]);
        expect(out.suggestions[0].relevantLinesStart).toBe(10);
    });

    it('mixed: detector + judge merge into one output (one LLM call)', async () => {
        const { provider, judge } = makeProvider([
            {
                violations: [
                    {
                        ruleId: 1, // semantic shard's only rule: no-any (detector rule is not sharded)
                        relevantLinesStart: 11,
                        suggestionContent: 'avoid any',
                        oneSentenceSummary: 'no any',
                    },
                ],
            },
        ]);
        const out = await provider.execute(
            input({
                kodyRules: [
                    {
                        uuid: 'no-console',
                        title: 'no console',
                        rule: 'no console.log',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                        detector: {
                            type: 'regex',
                            pattern: 'console\\.(log|warn|error)\\(',
                        },
                    },
                    {
                        uuid: 'no-any',
                        title: 'no any',
                        rule: 'do not use any',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                    },
                ],
            }) as any,
        );
        expect(judge).toHaveBeenCalledTimes(1); // only the semantic rule
        const ids = out.suggestions
            .map((s: any) => s.brokenKodyRulesIds?.[0])
            .sort();
        expect(ids).toEqual(['no-any', 'no-console']);
    });

    // ── total shard failure escalates (matrix-gaps item 10) ──────────────────
    // When EVERY judge shard errors (e.g. an OpenAI-strict wire-schema 400 that
    // 400s every shard identically), the review used to complete "successfully"
    // with 0 findings and only warn logs — a green review that evaluated none
    // of its semantic rules (§2.1 of the retro). The provider now throws so the
    // orchestrator's allSettled marks it PARTIAL_ERROR.
    it('throws when ALL judge shards fail (no silent 0-finding review)', async () => {
        const { provider } = makeProvider([]);
        // Every shard call rejects → shardsErrored === shardsRun.
        mockRunStructuredReviewCall.mockReset();
        mockRunStructuredReviewCall.mockRejectedValue(
            new Error('HTTP 400 structured outputs: required mismatch'),
        );

        await expect(
            provider.execute(
                input({
                    kodyRules: [
                        {
                            uuid: 'no-any',
                            title: 'no any',
                            rule: 'do not use any',
                            status: 'active',
                            severity: 'high',
                            path: '**/*.ts',
                        },
                    ],
                }) as any,
            ),
            // The message reaches the PR logs UI and the check text, so it
            // reads as user-facing copy — the internal rationale for failing
            // loudly lives in a comment at the throw site, not in the string.
        ).rejects.toThrow(/Kody Rules could not be evaluated: all 1 rule/i);
    });

    // A PARTIAL shard failure must NOT escalate — the surviving shard's finding
    // still ships. Guards against over-aggressively failing a mostly-fine review.
    // It must ALSO be observable: a silent partial degrade is the exact "one
    // shard dead while the other posts" shape of the wire-schema regression
    // (matrix-gaps item 8), so the provider emits a structured WARN with the
    // shard counts — assert both the survival AND the alert here.
    it('does NOT throw but WARNS with shard counts when only some shards fail (degrades to survivors, observably)', async () => {
        const { provider } = makeProvider([]);
        // Spy the shard logger so we can assert the partial degrade is surfaced,
        // not swallowed into an info line.
        const warnSpy = jest
            .spyOn((provider as any).shardLogger, 'warn')
            .mockImplementation(() => undefined);

        let call = 0;
        mockRunStructuredReviewCall.mockReset();
        // Two files → two file shards. First rejects, second returns a finding.
        mockRunStructuredReviewCall.mockImplementation(async () => {
            call++;
            if (call === 1) throw new Error('one shard down');
            return {
                violations: [
                    {
                        ruleId: 1,
                        relevantLinesStart: 11,
                        suggestionContent: 'avoid any',
                        oneSentenceSummary: 'no any',
                    },
                ],
            };
        });

        const out = await provider.execute(
            input({
                changedFiles: [
                    { filename: 'src/a.ts', patch: '11 +const x: any = 2' },
                    { filename: 'src/b.ts', patch: '11 +const y: any = 3' },
                ],
                kodyRules: [
                    {
                        uuid: 'no-any',
                        title: 'no any',
                        rule: 'do not use any',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                    },
                ],
            }) as any,
        );

        // Survived: the second shard's finding shipped, no throw.
        expect(out.suggestions.length).toBeGreaterThanOrEqual(1);

        // Observable: exactly one PARTIAL-degrade warn carrying the shard
        // accounting so it's alertable per-execution (not buried in the info
        // done-line). The judge also warns per failed shard about the root
        // cause — filter to the provider's aggregate PARTIAL signal.
        const partialWarns = warnSpy.mock.calls.filter((c) =>
            /PARTIAL judge-shard failure/i.test((c[0] as any)?.message ?? ''),
        );
        expect(partialWarns).toHaveLength(1);
        const warnArg = partialWarns[0][0] as any;
        expect(warnArg.metadata).toMatchObject({
            shardsRun: 2,
            shardsErrored: 1,
            shardsSucceeded: 1,
        });
    });

    // The healthy path must stay quiet: no partial-degrade warn when every
    // shard succeeds (guards against a noisy false alert on green reviews).
    it('does NOT warn about partial failure when all shards succeed', async () => {
        const { provider } = makeProvider([
            {
                violations: [
                    {
                        ruleId: 1,
                        relevantLinesStart: 11,
                        suggestionContent: 'avoid any',
                        oneSentenceSummary: 'no any',
                    },
                ],
            },
        ]);
        const warnSpy = jest
            .spyOn((provider as any).shardLogger, 'warn')
            .mockImplementation(() => undefined);

        await provider.execute(
            input({
                kodyRules: [
                    {
                        uuid: 'no-any',
                        title: 'no any',
                        rule: 'do not use any',
                        status: 'active',
                        severity: 'high',
                        path: '**/*.ts',
                    },
                ],
            }) as any,
        );

        const partialWarns = warnSpy.mock.calls.filter((c) =>
            /PARTIAL judge-shard failure/i.test((c[0] as any)?.message ?? ''),
        );
        expect(partialWarns).toHaveLength(0);
    });
});

describe('KodyRulesAgentProvider — Context OS reference loading', () => {
    const makeInput = () => ({
        prNumber: 7,
        organizationAndTeamData: {
            organizationId: 'org-1',
            teamId: 'team-1',
        },
        repositoryId: 'repo-1',
        repositoryFullName: 'owner/repo',
        baseBranch: 'main',
    });

    const makeProvider = (loader?: any) => {
        const p = new KodyRulesAgentProvider(
            {} as any,
            {} as any,
            {} as any,
            undefined,
            undefined,
            loader,
        );
        // Swap the real structured logger for spies.
        (p as any).shardLogger = { warn: jest.fn(), log: jest.fn() };
        return p;
    };

    const call = (p: any, rules: any[], input: any) =>
        (p as any).inlineContextOsReferences(rules, input);

    it('inlines resolved content and does NOT warn', async () => {
        const loader = {
            loadReferencesForRules: jest.fn().mockResolvedValue({
                referencesMap: new Map([
                    ['r1', [{ filePath: 'CLAUDE.md', content: 'the convention' }]],
                ]),
                mcpResultsMap: new Map(),
            }),
        };
        const p = makeProvider(loader);
        const rules = [
            { uuid: 'r1', contextReferenceId: 'ctx', title: 't', rule: 'base' },
        ];

        const out = await call(p, rules, makeInput());

        expect(out[0].rule).toContain('the convention');
        expect((p as any).shardLogger.warn).not.toHaveBeenCalled();
    });

    it('WARNS (with organizationId) when a contextReferenceId rule resolves ZERO references', async () => {
        const loader = {
            loadReferencesForRules: jest.fn().mockResolvedValue({
                referencesMap: new Map(),
                mcpResultsMap: new Map(),
            }),
        };
        const p = makeProvider(loader);
        const rules = [
            { uuid: 'r1', contextReferenceId: 'ctx', title: 't', rule: 'base' },
        ];

        const out = await call(p, rules, makeInput());

        expect(out).toEqual(rules); // judged blind, unchanged
        const warn = (p as any).shardLogger.warn as jest.Mock;
        expect(warn).toHaveBeenCalledTimes(1);
        const entry = warn.mock.calls[0][0];
        expect(entry.metadata.ruleUuids).toEqual(['r1']);
        expect(entry.metadata.organizationAndTeamData).toEqual(
            makeInput().organizationAndTeamData,
        );
    });

    it('sends ONLY rules with a contextReferenceId to the loader (pre-filter)', async () => {
        const loader = {
            loadReferencesForRules: jest.fn().mockResolvedValue({
                referencesMap: new Map(),
                mcpResultsMap: new Map(),
            }),
        };
        const p = makeProvider(loader);
        const rules = [
            { uuid: 'r1', contextReferenceId: 'ctx', title: 't', rule: 'a' },
            { uuid: 'r2', title: 't', rule: 'b' }, // no contextReferenceId
        ];

        await call(p, rules, makeInput());

        expect(loader.loadReferencesForRules).toHaveBeenCalledTimes(1);
        const passed = loader.loadReferencesForRules.mock.calls[0][0];
        expect(passed).toHaveLength(1);
        expect(passed[0].uuid).toBe('r1');
    });

    it('skips the loader entirely when no rule carries a contextReferenceId', async () => {
        const loader = { loadReferencesForRules: jest.fn() };
        const p = makeProvider(loader);
        const rules = [{ uuid: 'r1', title: 't', rule: 'a' }];

        const out = await call(p, rules, makeInput());

        expect(out).toBe(rules);
        expect(loader.loadReferencesForRules).not.toHaveBeenCalled();
    });

    it('degrades (warns with organizationId) when the loader throws', async () => {
        const loader = {
            loadReferencesForRules: jest
                .fn()
                .mockRejectedValue(new Error('boom')),
        };
        const p = makeProvider(loader);
        const rules = [
            { uuid: 'r1', contextReferenceId: 'ctx', title: 't', rule: 'base' },
        ];

        const out = await call(p, rules, makeInput());

        expect(out).toBe(rules);
        const warn = (p as any).shardLogger.warn as jest.Mock;
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0].metadata.organizationAndTeamData).toEqual(
            makeInput().organizationAndTeamData,
        );
    });

    it('is a no-op when the loader service is not wired', async () => {
        const p = makeProvider(undefined);
        const rules = [
            { uuid: 'r1', contextReferenceId: 'ctx', title: 't', rule: 'base' },
        ];

        const out = await call(p, rules, makeInput());

        expect(out).toBe(rules);
        expect((p as any).shardLogger.warn).not.toHaveBeenCalled();
    });
});
