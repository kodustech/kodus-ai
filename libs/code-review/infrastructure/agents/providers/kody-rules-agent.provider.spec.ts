import { KodyRulesAgentProvider } from '@libs/code-review/infrastructure/agents/providers/kody-rules-agent.provider';
import {
    KodyRulesScope,
    KodyRulesType,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { runStructuredReviewCall } from '@libs/llm/structured-review-call';
import {
    judgeKodyRulesSharded,
    shardViolationsWireSchema,
} from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge';

// The sharded judge now runs on the LOCAL (Vercel) stack via
// runStructuredReviewCall; mock it at that boundary (one canned response per
// shard call) instead of the old LangChain builder.
//
// LLM.run({ schema }) delegates to runStructuredReviewCall (see libs/llm/llm.ts:
// the structured branch calls `runStructuredReviewCall({ ...params, schema })`),
// so mocking this module IS mocking the real LLM.run boundary this provider hits
// inside its `runJudge` closure. Every field the provider threads
// (schema/system/user/runName/organizationId/attrs/byokConfig) is asserted off
// `mockRunStructuredReviewCall.mock.calls`.
jest.mock('@libs/llm/structured-review-call', () => ({
    runStructuredReviewCall: jest.fn(),
}));
const mockRunStructuredReviewCall = runStructuredReviewCall as jest.Mock;

// The provider's `runJudge` closure is a private, un-exported inner function.
// To reach the LLM.run boundary in isolation (request assembly + envelope
// extraction) we mock the sharded judge with a jest.fn that DEFAULTS to the
// REAL implementation (so the existing end-to-end tests keep running the real
// file×rule sweep), and in the boundary tests we capture the `runJudge`
// argument the provider builds and invoke it directly with a controlled
// LLM.run mock. `shardViolationsWireSchema` (and the other named exports) stay
// real via the spread, so schema-identity assertions hold.
jest.mock(
    '@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge',
    () => {
        const actual = jest.requireActual(
            '@libs/code-review/infrastructure/agents/collaborators/kody-rules-sharded.judge',
        );
        return {
            ...actual,
            judgeKodyRulesSharded: jest.fn(actual.judgeKodyRulesSharded),
        };
    },
);
const mockJudge = judgeKodyRulesSharded as jest.Mock;

describe('KodyRulesAgentProvider — rule formatting and applicability', () => {
    let provider: KodyRulesAgentProvider;

    const formatRules = (rules: any[], changedFiles: any[]): string =>
        (provider as any).formatKodyRules(rules, changedFiles);

    const matches = (filePath: string, pattern: string): boolean =>
        (provider as any).matchesPathPattern(filePath, pattern);

    beforeEach(() => {
        provider = new KodyRulesAgentProvider(
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
            {
                // model-factory routes the run's model through the per-task slot
                // entry point; no BYOK → undefined slot → LLM.run's managed default.
                resolveTaskSlot: jest.fn(async () => undefined),
            } as any, // permission (system model)
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
        // 5-arg constructor (promptRunnerService was removed with the LangChain
        // exit): permission, observability, documentationSearch, byokErrorCounter,
        // externalReferenceLoaderService.
        const p = new KodyRulesAgentProvider(
            {} as any, // permissionValidationService
            {} as any, // observabilityService
            undefined, // documentationSearchService
            undefined, // byokErrorCounter
            loader, // externalReferenceLoaderService
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

// ─────────────────────────────────────────────────────────────────────────────
// LLM.run I/O CONTRACT MATRIX — kody-rules-agent.provider.ts
//
// The single LLM.run site in this file is the `runJudge` closure (execute(),
// lines ~201-222): it calls
//     LLM.run({ byokConfig, schema: shardViolationsWireSchema, system, user,
//               runName, organizationId, attrs })
// and extracts the payload with the ONE line of parse logic in this file:
//     return ((parsed as any)?.violations ?? []) as RawShardViolation[];   // L220
//
// Declared schema D = `{ violations: RawShardViolation[] }`. The deep parse /
// repair / strict-vs-fallback json gate all live DOWNSTREAM in
// runStructuredReviewCall + structured-output-repair + structured-output-gate
// (mocked here). So at THIS boundary the contract is:
//   - request assembly: exact args/schema/system/user/byokConfig/attrs threading
//   - envelope extraction: `parsed?.violations ?? []` — recover the array, or
//     silently return [] (the #1786-class drop we pin with it.failing)
//   - fail-safe + guaranteed return shape via execute()'s per-shard degrade.
//
// The model/provider matrix (dimension E) is covered at the parse layer this
// boundary uses: the boundary sends the SAME wire schema for every provider and
// does NOT itself widen parsing for json_object-fallback models — the strict vs
// fallback gate is a separately-tested downstream module.
// ─────────────────────────────────────────────────────────────────────────────

const RULE_UUID = 'rule-1';

function makeSlot(provider: string) {
    // Minimal NormalizedModel-shaped slot: getModelName only reads
    // provider+model; `fallback: undefined` makes runWithModelFailover a single
    // pass-through so exactly one runStructuredReviewCall lands.
    return { provider, model: 'test-model', fallback: undefined } as any;
}

function makeBoundaryProvider(slotProvider?: string) {
    const resolveTaskSlot = jest.fn(async () =>
        slotProvider ? makeSlot(slotProvider) : undefined,
    );
    return new KodyRulesAgentProvider(
        { resolveTaskSlot } as any, // permissionValidationService
        {} as any, // observabilityService
    );
}

function boundaryInput(over: any = {}) {
    return {
        prNumber: 42,
        organizationAndTeamData: {
            organizationId: 'org-xyz',
            teamId: 'team-1',
        },
        changedFiles: [
            { filename: 'src/a.ts', patch: '11 +const x: any = 2' },
        ],
        prTitle: 'boundary',
        prBody: '',
        remoteCommands: undefined,
        kodyRules: [
            {
                uuid: RULE_UUID,
                title: 'no any',
                rule: 'do not use any',
                status: 'active',
                severity: 'high',
                path: '**/*.ts',
            },
        ],
        ...over,
    };
}

type CapturedRunJudge = (args: {
    system: string;
    user: string;
    filename: string | null;
    ruleUuids: string[];
}) => Promise<any[]>;

// Drive the real execute() far enough to build the `runJudge` closure, capture
// it via the (mocked) judge, and hand it back WITHOUT running the real sweep —
// so runStructuredReviewCall is untouched until we invoke runJudge ourselves.
async function captureRunJudge(slotProvider?: string): Promise<CapturedRunJudge> {
    const provider = makeBoundaryProvider(slotProvider);
    let captured: CapturedRunJudge | undefined;
    mockJudge.mockImplementationOnce(async (args: any) => {
        captured = args.runJudge;
        return { violations: [], shardsRun: 1, shardsErrored: 0 };
    });
    await provider.execute(boundaryInput() as any);
    if (!captured) throw new Error('runJudge was not captured');
    return captured;
}

const invoke = (runJudge: CapturedRunJudge, over: any = {}) =>
    runJudge({
        system: 'SYS',
        user: 'USR',
        filename: 'src/a.ts',
        ruleUuids: [RULE_UUID],
        ...over,
    });

describe('KodyRulesAgentProvider — LLM.run request assembly (runJudge)', () => {
    beforeEach(() => {
        mockRunStructuredReviewCall.mockReset();
        mockJudge.mockClear();
    });

    it('sends the WIRE schema object (not the zod object) as `schema`', async () => {
        const runJudge = await captureRunJudge();
        mockRunStructuredReviewCall.mockResolvedValueOnce({ violations: [] });
        await invoke(runJudge);
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        // Same reference — the provider must pass shardViolationsWireSchema, not
        // re-derive a zod schema (which would reintroduce the OpenAI-strict 400).
        expect(call.schema).toBe(shardViolationsWireSchema);
    });

    it('threads system, user, runName, organizationId, and per-shard attrs verbatim', async () => {
        const runJudge = await captureRunJudge();
        mockRunStructuredReviewCall.mockResolvedValueOnce({ violations: [] });
        await invoke(runJudge, { system: 'THE-SYS', user: 'THE-USR' });
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.system).toBe('THE-SYS');
        expect(call.user).toBe('THE-USR');
        expect(call.runName).toBe('kodus-rules-review-agent.shard');
        expect(call.organizationId).toBe('org-xyz');
        expect(call.attrs).toMatchObject({
            prNumber: 42,
            agentName: 'kodus-rules-review-agent',
            file: 'src/a.ts',
        });
    });

    it('omits the `file` attr for the PR-level shard (filename === null)', async () => {
        const runJudge = await captureRunJudge();
        mockRunStructuredReviewCall.mockResolvedValueOnce({ violations: [] });
        await invoke(runJudge, { filename: null });
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.attrs).toMatchObject({
            prNumber: 42,
            agentName: 'kodus-rules-review-agent',
        });
        expect('file' in call.attrs).toBe(false);
    });

    it('passes NO byokConfig (undefined) when the org has no BYOK slot', async () => {
        const runJudge = await captureRunJudge(/* no slot */);
        mockRunStructuredReviewCall.mockResolvedValueOnce({ violations: [] });
        await invoke(runJudge);
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.byokConfig).toBeUndefined();
    });

    it('threads the resolved BYOK slot into the call unchanged', async () => {
        const runJudge = await captureRunJudge('openai');
        mockRunStructuredReviewCall.mockResolvedValueOnce({ violations: [] });
        await invoke(runJudge);
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.byokConfig).toEqual(makeSlot('openai'));
    });
});

describe('KodyRulesAgentProvider — LLM.run envelope extraction (matrix A/B/C)', () => {
    beforeEach(() => {
        mockRunStructuredReviewCall.mockReset();
        mockJudge.mockClear();
    });

    const runWith = async (parsed: any) => {
        const runJudge = await captureRunJudge();
        mockRunStructuredReviewCall.mockResolvedValueOnce(parsed);
        return invoke(runJudge);
    };

    const oneViolation = { ruleId: 1, suggestionContent: 'avoid any' };

    // ── A. output-shape zoo ──────────────────────────────────────────────────

    it('row 1 — exact D {violations:[...]} recovers the array (happy path)', async () => {
        const out = await runWith({ violations: [oneViolation] });
        expect(out).toEqual([oneViolation]);
    });

    // Row 2: a bare array of inner items is the real payload minus the wrapper.
    // `parsed?.violations` is undefined on an array → [] → every violation is
    // silently dropped (the #1786 class). L220 has no array-unwrap fallback.
    it.failing(
        'row 2 — bare array [...] must be recovered, not silently dropped',
        async () => {
            const out = await runWith([oneViolation]);
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 3: a bare single violation object (no `violations` wrapper) → [].
    it.failing(
        'row 3 — bare single object must be recovered, not silently dropped',
        async () => {
            const out = await runWith(oneViolation);
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 4: wrapper key {result:D}.
    it.failing(
        'row 4 — {result:{violations:[...]}} wrapper must be unwrapped',
        async () => {
            const out = await runWith({ result: { violations: [oneViolation] } });
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 5: double wrapper.
    it.failing(
        'row 5 — {result:{result:{violations:[...]}}} double wrapper must be unwrapped',
        async () => {
            const out = await runWith({
                result: { result: { violations: [oneViolation] } },
            });
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 6: opaque single-key wrap ({content:D} / {"0":D}).
    it.failing(
        'row 6 — {content:{violations:[...]}} opaque wrap must be unwrapped',
        async () => {
            const out = await runWith({ content: { violations: [oneViolation] } });
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 7: the whole D as a JSON string.
    it.failing(
        'row 7 — stringified JSON must be parsed, not dropped',
        async () => {
            const out = await runWith(
                JSON.stringify({ violations: [oneViolation] }),
            );
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 8: markdown-fenced JSON.
    it.failing(
        'row 8 — ```json fenced``` output must be de-fenced and parsed',
        async () => {
            const out = await runWith(
                '```json\n' +
                    JSON.stringify({ violations: [oneViolation] }) +
                    '\n```',
            );
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 9: prose-wrapped JSON.
    it.failing(
        'row 9 — prose-wrapped JSON must be extracted, not dropped',
        async () => {
            const out = await runWith(
                'Here is the result: ' +
                    JSON.stringify({ violations: [oneViolation] }) +
                    '\n\nLet me know if you need more.',
            );
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 10: right data under renamed keys.
    it.failing(
        'row 10 — renamed key {issues:[...]} must be aliased to violations',
        async () => {
            const out = await runWith({ issues: [oneViolation] });
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    // Row 11: case/convention mismatch on the wrapper key.
    it.failing(
        'row 11 — case mismatch {Violations:[...]} must be recovered',
        async () => {
            const out = await runWith({ Violations: [oneViolation] });
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    it('row 12 — partial violation objects pass through (missing optional keys tolerated)', async () => {
        const partial = { ruleId: 1, suggestionContent: 'x' };
        const out = await runWith({ violations: [partial] });
        expect(out).toEqual([partial]);
    });

    it('row 13 — extra unknown keys alongside violations are tolerated', async () => {
        const out = await runWith({
            violations: [oneViolation],
            reasoning: 'checked all rules',
            extra: 123,
        });
        expect(out).toEqual([oneViolation]);
    });

    it('row 14 — {} empty object → [] (correct: no violations)', async () => {
        expect(await runWith({})).toEqual([]);
    });

    it('row 15 — bare [] empty array → [] (correct outcome)', async () => {
        expect(await runWith([])).toEqual([]);
    });

    it('row 16 — empty / whitespace string → [] (safe default, no crash)', async () => {
        expect(await runWith('')).toEqual([]);
        expect(await runWith('   \n\t ')).toEqual([]);
    });

    it('row 17 — null / undefined return → [] (safe default, no crash)', async () => {
        expect(await runWith(null)).toEqual([]);
        expect(await runWith(undefined)).toEqual([]);
    });

    it('row 18 — primitive (true / 0 / "ok") → [] (safe default, no crash)', async () => {
        expect(await runWith(true)).toEqual([]);
        expect(await runWith(0)).toEqual([]);
        expect(await runWith('ok')).toEqual([]);
    });

    // Row 19: a raw provider envelope leaking through carries the real payload
    // inside choices[0].message.content — dropped silently at L220.
    it.failing(
        'row 19 — provider envelope leak {choices:[{message:{content}}]} must be recovered',
        async () => {
            const out = await runWith({
                choices: [
                    {
                        message: {
                            content: JSON.stringify({
                                violations: [oneViolation],
                            }),
                        },
                    },
                ],
            });
            expect(out).toEqual([oneViolation]); // today: []
        },
    );

    it('row 20 — reasoning/thinking field alongside violations is tolerated (recovers violations)', async () => {
        const out = await runWith({
            reasoning: '<thinking>weighing rule 1…</thinking>',
            violations: [oneViolation],
        });
        expect(out).toEqual([oneViolation]);
    });

    // ── C. unparseable / transport (fail-safe) ───────────────────────────────

    // Rows 28 (truncated JSON, max_tokens mid-object) and 29 (malformed JSON —
    // trailing comma / single quotes / unquoted keys) are decoded + repaired in
    // runStructuredReviewCall DOWNSTREAM (mocked at this boundary). At THIS
    // boundary the raw string never reaches L220 — either the downstream repair
    // succeeds and hands back a JS object (already covered by rows 1-20), or it
    // exhausts the repair path and REJECTS. The contract this boundary owns for
    // both is identical: runJudge must NOT swallow that rejection — it propagates
    // so execute()'s per-shard try/catch counts the shard as errored (and
    // escalates on a total failure) rather than silently reading 0 violations.
    it('row 28 — truncated JSON that downstream cannot repair rejects (propagated, never read as 0 violations)', async () => {
        const runJudge = await captureRunJudge();
        mockRunStructuredReviewCall.mockRejectedValueOnce(
            new Error('structured output parse failed: Unexpected end of JSON input'),
        );
        await expect(invoke(runJudge)).rejects.toThrow(/JSON/i);
    });

    it('row 29 — malformed JSON (trailing comma / single quotes) that downstream cannot repair rejects (propagated)', async () => {
        const runJudge = await captureRunJudge();
        mockRunStructuredReviewCall.mockRejectedValueOnce(
            new Error("structured output parse failed: Unexpected token ' in JSON"),
        );
        await expect(invoke(runJudge)).rejects.toThrow(/parse failed/i);
    });

    it('row 30 — runJudge does NOT swallow an LLM.run throw (the per-shard catch owns fail-safe)', async () => {
        const runJudge = await captureRunJudge();
        mockRunStructuredReviewCall.mockRejectedValueOnce(
            new Error('network down'),
        );
        await expect(invoke(runJudge)).rejects.toThrow('network down');
    });

    // Row 31: an {error} envelope returned INSTEAD of throwing → `.violations`
    // undefined → [] → the shard records as a clean 0-finding SUCCESS, so a
    // provider error masquerades as a healthy review (the #1786 class). The
    // correct behavior is to signal (throw) so the shard is counted as errored.
    // Written via `expect(...).rejects` so a throw-fix flips it.failing red.
    it.failing(
        'row 31 — {error:...} envelope must be signalled (throw), not read as 0 violations',
        async () => {
            const runJudge = await captureRunJudge();
            mockRunStructuredReviewCall.mockResolvedValueOnce({
                error: 'provider rate limited',
            });
            await expect(invoke(runJudge)).rejects.toThrow(); // today: resolves to []
        },
    );

    it('row 32 — empty success ({violations:[]} via schema default) → [] (no crash)', async () => {
        expect(await runWith({ violations: [] })).toEqual([]);
    });

    it('row 33 — refusal prose ("I cannot help…") → [] (fail-safe, no crash)', async () => {
        expect(
            await runWith('I cannot help with that request.'),
        ).toEqual([]);
    });

    it('row 34 — an abort/timeout rejection propagates so the shard fail-safe can count it', async () => {
        const runJudge = await captureRunJudge();
        const abortErr = Object.assign(new Error('The operation was aborted'), {
            name: 'AbortError',
        });
        mockRunStructuredReviewCall.mockRejectedValueOnce(abortErr);
        await expect(invoke(runJudge)).rejects.toMatchObject({
            name: 'AbortError',
        });
    });
});

describe('KodyRulesAgentProvider — model-policy is downstream (matrix E)', () => {
    beforeEach(() => {
        mockRunStructuredReviewCall.mockReset();
        mockJudge.mockClear();
    });

    // The boundary sends ONE wire schema for every provider — strict-json_schema
    // models (openai/anthropic/google/moonshotai) AND json_object-fallback ones
    // (kimi/glm/deepseek/z-ai). The provider does not branch on model here; the
    // strict-vs-fallback gate lives in structured-output-gate.ts downstream.
    it.each([
        ['openai', 'strict-gate'],
        ['anthropic', 'strict-gate'],
        ['google', 'strict-gate'],
        ['moonshotai', 'strict-gate'],
        ['kimi', 'fallback-gate'],
        ['glm', 'fallback-gate'],
        ['deepseek', 'fallback-gate'],
        ['z-ai', 'fallback-gate'],
    ])(
        'sends the same wire schema regardless of provider (%s, %s)',
        async (provider) => {
            const runJudge = await captureRunJudge(provider);
            mockRunStructuredReviewCall.mockResolvedValueOnce({ violations: [] });
            await invoke(runJudge);
            expect(mockRunStructuredReviewCall.mock.calls[0][0].schema).toBe(
                shardViolationsWireSchema,
            );
        },
    );

    it('strict-gate provider: a clean D is trusted and recovered', async () => {
        const runJudge = await captureRunJudge('moonshotai');
        mockRunStructuredReviewCall.mockResolvedValueOnce({
            violations: [{ ruleId: 1, suggestionContent: 'x' }],
        });
        const out = await invoke(runJudge);
        expect(out).toEqual([{ ruleId: 1, suggestionContent: 'x' }]);
    });

    // Under a json_object-fallback provider the full off-schema zoo is IN scope,
    // yet the boundary does NOT widen its own parsing — a bare array is still
    // lost. Pinned so a future recover-fallback at L220 turns this red.
    it.failing(
        'fallback-gate provider: bare array is still dropped (boundary does not self-widen)',
        async () => {
            const runJudge = await captureRunJudge('z-ai');
            mockRunStructuredReviewCall.mockResolvedValueOnce([
                { ruleId: 1, suggestionContent: 'x' },
            ]);
            const out = await invoke(runJudge);
            expect(out).toHaveLength(1); // today: []
        },
    );
});

describe('KodyRulesAgentProvider — input variants + return shape (matrix D)', () => {
    beforeEach(() => {
        mockRunStructuredReviewCall.mockReset();
        mockJudge.mockClear();
    });

    // Real judge sweep + LLM mocked at runStructuredReviewCall.
    function makeExecProvider(runImpl?: (params: any) => Promise<any>) {
        mockRunStructuredReviewCall.mockImplementation(
            runImpl ?? (async () => ({ violations: [] })),
        );
        return makeBoundaryProvider(/* no BYOK */);
    }

    const execInput = (over: any = {}) => ({
        prNumber: 7,
        organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        changedFiles: [{ filename: 'src/a.ts', patch: '11 +const x: any = 2' }],
        prTitle: 'p',
        prBody: '',
        remoteCommands: undefined,
        ...over,
    });

    const fileRule = {
        uuid: RULE_UUID,
        title: 'no any',
        rule: 'do not use any',
        status: 'active',
        severity: 'high',
        path: '**/*.ts',
    };
    const prRule = { ...fileRule, scope: KodyRulesScope.PULL_REQUEST };

    it('row 35 — file-scope rule but ZERO changed files → no shard, empty result, no LLM call', async () => {
        const provider = makeExecProvider();
        const out = await provider.execute(
            execInput({
                changedFiles: [],
                kodyRules: [{ ...fileRule, scope: KodyRulesScope.FILE }],
            }) as any,
        );
        expect(out.suggestions).toEqual([]);
        expect(mockRunStructuredReviewCall).not.toHaveBeenCalled();
    });

    it('row 36 — single file + single rule → one shard → one suggestion', async () => {
        const provider = makeExecProvider(async () => ({
            violations: [
                {
                    ruleId: 1,
                    relevantLinesStart: 11,
                    relevantLinesEnd: 11,
                    existingCode: 'const x: any = 2',
                    suggestionContent: 'avoid any',
                    oneSentenceSummary: 'no any',
                },
            ],
        }));
        const out = await provider.execute(
            execInput({ kodyRules: [fileRule] }) as any,
        );
        expect(mockRunStructuredReviewCall).toHaveBeenCalledTimes(1);
        expect(out.suggestions).toHaveLength(1);
        expect((out.suggestions[0] as any).brokenKodyRulesIds).toEqual([
            RULE_UUID,
        ]);
    });

    it('row 37 — large PR diff crossing the 150k budget degrades to a name-only marker (never silent)', async () => {
        const provider = makeExecProvider();
        const big = '10 +' + 'a'.repeat(150_001);
        await provider.execute(
            execInput({
                changedFiles: [{ filename: 'big.ts', patch: big }],
                kodyRules: [prRule],
            }) as any,
        );
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.user).toContain('diff omitted — PR diff budget exceeded');
    });

    it('row 38 — duplicate changed files → one shard per entry, no crash', async () => {
        const provider = makeExecProvider(async () => ({ violations: [] }));
        await provider.execute(
            execInput({
                changedFiles: [
                    { filename: 'dup.ts', patch: '11 +const x: any = 2' },
                    { filename: 'dup.ts', patch: '11 +const x: any = 2' },
                ],
                kodyRules: [fileRule],
            }) as any,
        );
        expect(mockRunStructuredReviewCall).toHaveBeenCalledTimes(2);
    });

    it('row 39 — changed file with undefined patch + rule with null fields → no crash, empty result', async () => {
        const provider = makeExecProvider(async () => ({ violations: [] }));
        const out = await provider.execute(
            execInput({
                changedFiles: [
                    {
                        filename: 'a.ts',
                        patch: undefined,
                        patchWithLinesStr: undefined,
                    },
                ],
                kodyRules: [
                    {
                        uuid: RULE_UUID,
                        title: null,
                        rule: null,
                        status: 'active',
                        path: '**/*.ts',
                    },
                ],
            }) as any,
        );
        expect(out.suggestions).toEqual([]);
        expect(mockRunStructuredReviewCall).toHaveBeenCalledTimes(1);
    });

    it('row 40 — whitespace-only + special-char diff is preserved in the shard prompt, no crash', async () => {
        const provider = makeExecProvider(async () => ({ violations: [] }));
        const weird = '10 +  \t 😀 <script>"quote"\\n';
        await provider.execute(
            execInput({
                changedFiles: [{ filename: 'a.ts', patch: weird }],
                kodyRules: [fileRule],
            }) as any,
        );
        const call = mockRunStructuredReviewCall.mock.calls[0][0];
        expect(call.user).toContain('😀');
        expect(call.user).toContain('<script>"quote"');
    });

    it('row 41 — PR diff budget boundary is off-by-one exact (== included, +1 omitted)', async () => {
        // Exactly at budget → included (no marker).
        let provider = makeExecProvider();
        await provider.execute(
            execInput({
                changedFiles: [{ filename: 'x.ts', patch: 'a'.repeat(150_000) }],
                kodyRules: [prRule],
            }) as any,
        );
        expect(mockRunStructuredReviewCall.mock.calls[0][0].user).not.toContain(
            'diff omitted — PR diff budget exceeded',
        );

        // One char over → omitted (marker present).
        mockRunStructuredReviewCall.mockReset();
        provider = makeExecProvider();
        await provider.execute(
            execInput({
                changedFiles: [{ filename: 'x.ts', patch: 'a'.repeat(150_001) }],
                kodyRules: [prRule],
            }) as any,
        );
        expect(mockRunStructuredReviewCall.mock.calls[0][0].user).toContain(
            'diff omitted — PR diff budget exceeded',
        );
    });

    it('row 42 — permuting changed-file order yields the same set of suggestions (metamorphic)', async () => {
        // The judge routes each file to its own shard; runJudge stamps attrs.file
        // with the filename, so the mock returns a finding only for a.ts.
        const runImpl = async (params: any) =>
            params.attrs?.file === 'a.ts'
                ? {
                      violations: [
                          {
                              ruleId: 1,
                              relevantLinesStart: 11,
                              relevantLinesEnd: 11,
                              existingCode: 'const x: any = 2',
                              suggestionContent: 'avoid any',
                              oneSentenceSummary: 'no any',
                          },
                      ],
                  }
                : { violations: [] };

        const filesAB = [
            { filename: 'a.ts', patch: '11 +const x: any = 2' },
            { filename: 'b.ts', patch: '11 +const y = 3' },
        ];
        const filesBA = [...filesAB].reverse();

        const out1 = await makeExecProvider(runImpl).execute(
            execInput({ changedFiles: filesAB, kodyRules: [fileRule] }) as any,
        );
        mockRunStructuredReviewCall.mockReset();
        const out2 = await makeExecProvider(runImpl).execute(
            execInput({ changedFiles: filesBA, kodyRules: [fileRule] }) as any,
        );

        const files1 = out1.suggestions.map((s: any) => s.relevantFile).sort();
        const files2 = out2.suggestions.map((s: any) => s.relevantFile).sort();
        expect(files1).toEqual(files2);
        expect(files1).toEqual(['a.ts']);
    });

    // ── B. semantic-but-wrong (the fields this boundary actually carries) ─────
    //
    // Rows 21 (boolean-as-string), 22 (boolean-as-yes/no) and 24 (enum out of
    // allowed set) are NOT applicable to this boundary: RawShardViolation (the D
    // it carries) has NO model-emitted boolean or enum field — the only decision
    // field is `ruleId` (a rule index) and the rest are free-text/line numbers;
    // severity is sourced from the RULE, not the model output. See rowsNA.
    // Row 26 (duplicate JSON keys) is a raw-JSON-parse concern resolved
    // last-wins DOWNSTREAM before `parsed` reaches L220 as a JS object — NA here.
    //
    // Row 23's dimension — "valid JSON, wrong VALUE ENCODING of a field" — DOES
    // apply: the one numeric decision field, `ruleId`, is routinely emitted as a
    // stringified number. resolveRuleId coerces "1" → index 1, so the violation
    // still resolves to its rule (recover, not drop).
    it('row 23 — ruleId emitted as a stringified number ("1") still resolves to its rule (encoding tolerance)', async () => {
        const provider = makeExecProvider(async () => ({
            violations: [
                {
                    ruleId: '1', // stringified index, not the number 1
                    relevantLinesStart: 11,
                    relevantLinesEnd: 11,
                    existingCode: 'const x: any = 2',
                    suggestionContent: 'avoid any',
                    oneSentenceSummary: 'no any',
                },
            ],
        }));
        const out = await provider.execute(
            execInput({ kodyRules: [fileRule] }) as any,
        );
        expect(out.suggestions).toHaveLength(1);
        expect((out.suggestions[0] as any).brokenKodyRulesIds).toEqual([
            RULE_UUID,
        ]);
    });

    it('row 23 (guard) — a non-scalar ruleId (boolean) is dropped, never mapped to a rule', async () => {
        const provider = makeExecProvider(async () => ({
            violations: [
                {
                    ruleId: true as any, // wrong-type encoding → resolveRuleId returns null
                    relevantLinesStart: 11,
                    suggestionContent: 'avoid any',
                    oneSentenceSummary: 'no any',
                },
            ],
        }));
        const out = await provider.execute(
            execInput({ kodyRules: [fileRule] }) as any,
        );
        expect(out.suggestions).toEqual([]);
    });

    it('row 25 — a ruleId index beyond the shard rule list is dropped (hallucinated index, not shipped)', async () => {
        const provider = makeExecProvider(async () => ({
            violations: [
                {
                    ruleId: 99, // only 1 rule in this shard
                    relevantLinesStart: 11,
                    suggestionContent: 'avoid any',
                    oneSentenceSummary: 'no any',
                },
            ],
        }));
        const out = await provider.execute(
            execInput({ kodyRules: [fileRule] }) as any,
        );
        expect(out.suggestions).toEqual([]);
    });

    it('row 27 — unicode / emoji / escaped newline in suggestionContent survives to the suggestion', async () => {
        const content = 'Violação 😀\nsegunda linha';
        const provider = makeExecProvider(async () => ({
            violations: [
                {
                    ruleId: 1,
                    relevantLinesStart: 11,
                    relevantLinesEnd: 11,
                    existingCode: 'const x: any = 2',
                    suggestionContent: content,
                    oneSentenceSummary: 'ok',
                },
            ],
        }));
        const out = await provider.execute(
            execInput({ kodyRules: [fileRule] }) as any,
        );
        expect(out.suggestions).toHaveLength(1);
        expect(out.suggestions[0].suggestionContent).toContain('😀');
        expect(out.suggestions[0].suggestionContent).toContain('segunda linha');
    });

    // ── guaranteed return shape across layers ────────────────────────────────

    it('always returns the declared ReviewAgentOutput shape (happy, empty, and short-circuit)', async () => {
        const shape = (o: any) => {
            expect(o).toEqual(
                expect.objectContaining({
                    suggestions: expect.any(Array),
                    agentName: 'kodus-rules-review-agent',
                    turnsUsed: expect.any(Number),
                    durationMs: expect.any(Number),
                }),
            );
        };

        // happy
        shape(
            await makeExecProvider(async () => ({
                violations: [
                    {
                        ruleId: 1,
                        relevantLinesStart: 11,
                        suggestionContent: 'avoid any',
                        oneSentenceSummary: 'no any',
                    },
                ],
            })).execute(execInput({ kodyRules: [fileRule] }) as any),
        );
        // empty judge return
        mockRunStructuredReviewCall.mockReset();
        shape(
            await makeExecProvider(async () => ({ violations: [] })).execute(
                execInput({ kodyRules: [fileRule] }) as any,
            ),
        );
        // short-circuit (no rules)
        shape(
            await makeBoundaryProvider().execute(
                execInput({ kodyRules: [] }) as any,
            ),
        );
    });
});
