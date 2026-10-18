import * as severityClassifier from '@libs/code-review/infrastructure/agents/engine/classify-severity';
import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
import { formatSuggestionContent } from '@libs/code-review/infrastructure/agents/engine/format-suggestion-content';
import { LLM } from '@libs/llm/llm';
import { hasManagedModelKey } from '@libs/llm/managed-slot';

jest.mock(
    '@libs/code-review/infrastructure/agents/engine/classify-severity',
    () => ({ classifySeverity: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock(
    '@libs/code-review/infrastructure/agents/engine/format-suggestion-content',
    () => ({ formatSuggestionContent: jest.fn().mockResolvedValue(new Map()) }),
);
jest.mock('@libs/llm/managed-slot', () => {
    const actual = jest.requireActual('@libs/llm/managed-slot');
    return { ...actual, hasManagedModelKey: jest.fn(() => false) };
});

/**
 * #2172 — how the review stage dispatches custom agents and presents what
 * they found: the beta gate, per-agent severity floor, comment
 * limit, fix policy, single PR-level comment and the per-agent summary.
 */

const PATCH = [
    '@@ -1,2 +1,30 @@',
    ...Array.from({ length: 30 }, (_, i) => `+line ${i + 1}`),
].join('\n');

const makeStage = (
    orchestratorOutput: Record<string, unknown>,
    gateEnabled = true,
) => {
    const reviewOrchestrator = {
        execute: jest.fn().mockResolvedValue(orchestratorOutput),
    };
    const featureGate = { isEnabled: jest.fn().mockResolvedValue(gateEnabled) };
    // Target-branch files the knowledge reader can see through the provider.
    const codeManagement = {
        getRepositories: jest.fn().mockResolvedValue([]),
        getCloneParams: jest.fn().mockResolvedValue(null),
        getRepositoryContentFile: jest.fn(async ({ file }: any) =>
            file.filename === 'docs/ledger.md'
                ? { data: { content: 'Debits equal credits.' } }
                : null,
        ),
        getRepositoryAllFiles: jest.fn().mockResolvedValue([]),
    };
    const stage = new AgentReviewStage(
        {
            findLatestStageLog: jest.fn(),
            updateCodeReview: jest.fn(),
            updateStageLog: jest.fn(),
        } as any,
        { findByExternalId: jest.fn().mockResolvedValue(null) } as any,
        reviewOrchestrator as any,
        {
            runLLMInSpan: jest.fn(async ({ runFn }: any) => runFn?.()),
        } as any,
        {
            generateContext: jest.fn(),
            generateContextLegacy: jest.fn().mockResolvedValue(''),
        } as any,
        featureGate as any,
        { getReleaseTrack: jest.fn().mockResolvedValue('stable') } as any,
        codeManagement as any,
    );
    return { stage, reviewOrchestrator, featureGate, codeManagement };
};

const agent = (over: Record<string, any> = {}) => ({
    id: 'agent-ledger',
    name: 'Ledger Rules',
    enabled: true,
    instructions: 'Every ledger entry must balance.',
    presentation: { tag: { color: '#7B1FA2' } },
    ...over,
});

const makeContext = (customAgents: any[], over: Record<string, unknown> = {}) =>
    frozenContext({
        organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
        repository: { id: 'repo-1', name: 'repo-1' },
        pullRequest: { number: 7 },
        platformType: 'GITHUB',
        changedFiles: [{ filename: 'src/ledger.ts', patch: PATCH }],
        codeReviewConfig: {
            reviewOptions: {},
            heavy: false,
            resolvedModelSlot: { provider: 'openai', model: 'gpt-4o-mini' },
            customAgents,
        },
        heavy: false,
        validSuggestions: [],
        discardedSuggestions: [],
        errors: [],
        ...over,
    }) as any as CodeReviewPipelineContext;

const finding = (over: Record<string, any> = {}) => ({
    relevantFile: 'src/ledger.ts',
    relevantLinesStart: 3,
    relevantLinesEnd: 3,
    language: 'typescript',
    suggestionContent: 'The entry is booked on one side only.',
    oneSentenceSummary: 'Unbalanced ledger entry',
    existingCode: 'line 3',
    improvedCode: 'line 3 balanced',
    severity: 'high',
    label: 'custom_agent',
    customAgent: { id: 'agent-ledger', name: 'Ledger Rules', color: '#7B1FA2' },
    ...over,
});

const output = (suggestions: any[], over: Record<string, unknown> = {}) => ({
    suggestions,
    agentResults: [],
    failures: [],
    incomplete: [],
    unverified: [],
    warnings: [],
    customAgentRuns: [
        {
            id: 'agent-ledger',
            name: 'Ledger Rules',
            slug: 'ledger-rules',
            status: 'ran',
            droppedByVerify: 2,
        },
    ],
    ...over,
});

const run = (stage: AgentReviewStage, ctx: CodeReviewPipelineContext) =>
    (stage as any).executeStage(ctx) as Promise<any>;

const contents = (list: any[] | undefined) =>
    (list ?? []).map((s: any) => s.suggestionContent);

let runSpy: jest.SpyInstance;
beforeEach(() => {
    runSpy = jest
        .spyOn(LLM, 'run')
        .mockResolvedValue({ groups: [], unique: [] } as any);
});
afterEach(() => {
    runSpy?.mockRestore();
    jest.clearAllMocks();
    (hasManagedModelKey as jest.Mock).mockReturnValue(false);
});

describe('AgentReviewStage — custom agents (#2172)', () => {
    it('dispatches the enabled agents for every organization', async () => {
        const { stage, reviewOrchestrator, featureGate } = makeStage(
            output([]),
        );

        await run(
            stage,
            makeContext([
                agent(),
                agent({ id: 'off', name: 'Off', enabled: false }),
            ]),
        );
        expect(
            reviewOrchestrator.execute.mock.calls[0][0].customAgents.map(
                (a: any) => a.id,
            ),
        ).toEqual(['agent-ledger']);
    });

    it('posts the finding of an agent stored with the retired shadow mode', async () => {
        const { stage } = makeStage(output([finding()]));

        const result = await run(
            stage,
            makeContext([agent({ presentation: { mode: 'shadow' } as any })]),
        );

        expect(contents(result.validSuggestions)).toEqual([
            'The entry is booked on one side only.',
        ]);
        expect(
            result.discardedSuggestions.filter(
                (s: any) => s.customAgent?.id === 'agent-ledger',
            ),
        ).toEqual([]);
    });

    it('posts a finding inline and counts it in the summary', async () => {
        const { stage } = makeStage(output([finding()]));

        const result = await run(stage, makeContext([agent()]));

        expect(contents(result.validSuggestions)).toEqual([
            'The entry is booked on one side only.',
        ]);
        expect(result.customAgentRuns[0]).toMatchObject({
            posted: 1,
            droppedByVerify: 2,
        });
    });

    it('applies the agent severity floor even without a team filter', async () => {
        const { stage } = makeStage(
            output([
                finding(),
                finding({
                    relevantLinesStart: 9,
                    relevantLinesEnd: 9,
                    severity: 'low',
                    suggestionContent: 'Rounding note.',
                }),
            ]),
        );

        const result = await run(
            stage,
            makeContext([agent({ presentation: { minSeverity: 'high' } })]),
        );

        expect(contents(result.validSuggestions)).toEqual([
            'The entry is booked on one side only.',
        ]);
        expect(
            result.discardedSuggestions.find(
                (s: any) => s.suggestionContent === 'Rounding note.',
            ),
        ).toMatchObject({ priorityStatus: 'discarded-by-severity' });
    });

    it('keeps the most severe findings up to maxComments', async () => {
        const { stage } = makeStage(
            output([
                finding({
                    relevantLinesStart: 9,
                    relevantLinesEnd: 9,
                    severity: 'medium',
                    suggestionContent: 'Medium one.',
                }),
                finding({
                    severity: 'critical',
                    suggestionContent: 'Critical one.',
                }),
            ]),
        );

        const result = await run(
            stage,
            makeContext([agent({ presentation: { maxComments: 1 } })]),
        );

        expect(contents(result.validSuggestions)).toEqual(['Critical one.']);
        expect(
            result.discardedSuggestions.find(
                (s: any) => s.suggestionContent === 'Medium one.',
            ),
        ).toMatchObject({ notSentReason: 'custom-agent-max-comments' });
    });

    it("strips the fix when the agent's policy is never", async () => {
        const { stage } = makeStage(output([finding()]));

        const result = await run(
            stage,
            makeContext([
                agent({
                    presentation: { suggestedFix: 'never' },
                }),
            ]),
        );

        expect(result.validSuggestions[0].improvedCode || '').toBe('');
    });

    it('gathers a single-comment agent findings in one PR-level comment', async () => {
        const { stage } = makeStage(
            output([
                finding(),
                finding({
                    relevantLinesStart: 9,
                    relevantLinesEnd: 9,
                    suggestionContent: 'Second entry also unbalanced.',
                }),
            ]),
        );

        const result = await run(
            stage,
            makeContext([
                agent({
                    presentation: { format: 'single-comment' },
                }),
            ]),
        );

        expect(contents(result.validSuggestions)).toEqual([]);
        expect(result.validSuggestionsByPR).toHaveLength(1);
        expect(result.validSuggestionsByPR[0]).toMatchObject({
            label: 'custom_agent',
            customAgent: { id: 'agent-ledger', name: 'Ledger Rules' },
        });
        expect(result.validSuggestionsByPR[0].suggestionContent).toContain(
            'Second entry also unbalanced.',
        );
        expect(result.customAgentRuns[0].posted).toBe(2);
    });

    it("writes a single-comment agent's comment in the agent's voice", async () => {
        (formatSuggestionContent as jest.Mock).mockResolvedValueOnce(
            new Map([
                [
                    0,
                    {
                        suggestionContent: 'O débito fica sem crédito.',
                        title: 'Lançamento sem contrapartida',
                    },
                ],
            ]),
        );
        const { stage } = makeStage(output([finding()]));
        const writing = 'Escreva em português do Brasil.';

        const result = await run(
            stage,
            makeContext([
                agent({
                    presentation: { format: 'single-comment', writing },
                }),
            ]),
        );

        expect(formatSuggestionContent).toHaveBeenCalledWith(
            [expect.objectContaining({ title: 'Unbalanced ledger entry' })],
            expect.objectContaining({
                customWritingGuidelines: writing,
                rewriteTitle: true,
            }),
        );
        const [comment] = result.validSuggestionsByPR;
        expect(comment.oneSentenceSummary).toBe('Ledger Rules (1)');
        expect(comment.suggestionContent).toBe(
            '1. **Lançamento sem contrapartida** — `src/ledger.ts:3`\n\n   O débito fica sem crédito.',
        );
    });

    it('posts the most severe finding of a single-comment agent capped at one', async () => {
        const { stage } = makeStage(
            output([
                finding({
                    severity: 'medium',
                    suggestionContent: 'The new route has no e2e test.',
                }),
                finding({
                    relevantLinesStart: 9,
                    relevantLinesEnd: 9,
                    severity: 'medium',
                    suggestionContent: 'The route skips the service layer.',
                }),
            ]),
        );

        const result = await run(
            stage,
            makeContext([
                agent({
                    presentation: {
                        format: 'single-comment',
                        maxComments: 1,
                        minSeverity: 'medium',
                        suggestedFix: 'never',
                        tag: { color: '#0ea5e9' },
                    },
                }),
            ]),
        );

        expect(result.validSuggestionsByPR).toHaveLength(1);
        expect(result.validSuggestionsByPR[0].suggestionContent).toContain(
            'The new route has no e2e test.',
        );
        expect(result.customAgentRuns[0].posted).toBe(1);
    });

    it("keeps the agent's own severity: Kody's bug-centric reclassification never pushes it under the agent floor", async () => {
        const classify = jest
            .spyOn(severityClassifier, 'classifySeverity')
            .mockResolvedValue(new Map([[0, 'low']]) as any);
        const { stage } = makeStage(
            output([
                finding({
                    severity: 'medium',
                    suggestionContent: 'The new route has no e2e test.',
                }),
            ]),
        );

        const result = await run(
            stage,
            makeContext([
                agent({
                    presentation: { minSeverity: 'medium' },
                }),
            ]),
        );

        expect(contents(result.validSuggestions)).toEqual([
            'The new route has no e2e test.',
        ]);
        expect(result.validSuggestions[0].severity).toBe('medium');
        classify.mockRestore();
    });

    it('holds approval for a failed, cut-short or unverified custom agent', async () => {
        const ref = { id: 'agent-ledger' };
        const name = 'custom-agent:ledger-rules';
        const { stage } = makeStage(
            output([], {
                failures: [
                    {
                        agentName: name,
                        category: 'custom_agent',
                        error: new Error('boom'),
                        durationMs: 1,
                        customAgent: ref,
                    },
                ],
                incomplete: [
                    {
                        agentName: name,
                        category: 'custom_agent',
                        finishReason: 'max-steps',
                        suggestionsFound: 0,
                        durationMs: 1,
                        customAgent: ref,
                    },
                ],
                unverified: [
                    {
                        agentName: name,
                        category: 'custom_agent',
                        unverifiedCount: 2,
                        customAgent: ref,
                    },
                ],
            }),
        );

        const result = await run(stage, makeContext([agent()]));

        const severities = (result.errors ?? [])
            .filter((e: any) => e.substage === `agent:${name}`)
            .map((e: any) => e.severity);
        expect(severities).toEqual(['partial', 'partial', 'partial']);
    });

    describe('dedup against native findings and Kody Rules', () => {
        const native = (over: Record<string, any> = {}) => ({
            ...finding({
                label: 'potential_issues',
                severity: 'medium',
                suggestionContent: 'Native: the entry is one-sided.',
                ...over,
            }),
            customAgent: undefined,
        });
        const honorEveryMerge = (stage: AgentReviewStage) =>
            jest
                .spyOn(stage as any, 'resolveDedupMerge')
                .mockResolvedValue({ honor: true, reason: 'same', score: 1 });

        it('keeps the custom agent finding over a Kody Rule on the same problem', async () => {
            const { stage } = makeStage(
                output([
                    finding(),
                    native({
                        label: 'kody_rules',
                        brokenKodyRulesIds: ['rule-ledger'],
                        suggestionContent: 'Rule: entries must balance.',
                    }),
                ]),
            );
            honorEveryMerge(stage);

            const result = await run(stage, makeContext([agent()]));

            expect(contents(result.validSuggestions)).toEqual([
                'The entry is booked on one side only.',
            ]);
        });

        it('credits the agent with a group only for a finding in its lane', async () => {
            (hasManagedModelKey as jest.Mock).mockReturnValue(true);
            runSpy.mockImplementation(async (args: any) =>
                args?.runName === 'code-review-dedup'
                    ? {
                          groups: [
                              { keep: 1, duplicates: [0] },
                              { keep: 2, duplicates: [3] },
                          ],
                          unique: [],
                      }
                    : { groups: [], unique: [] },
            );
            const { stage } = makeStage(
                output([
                    native(),
                    // A bug outside the agent's instructions.
                    finding({ kind: 'bug' }),
                    native({
                        relevantLinesStart: 9,
                        relevantLinesEnd: 9,
                        suggestionContent: 'Native: credit missing.',
                    }),
                    // The team rule the agent was asked for.
                    finding({
                        relevantLinesStart: 9,
                        relevantLinesEnd: 9,
                        kind: 'convention',
                        source: {
                            file: 'docs/ledger.md',
                            quote: 'Debits equal credits.',
                        },
                        suggestionContent: 'Rule: debit needs a credit.',
                    }),
                ]),
            );
            honorEveryMerge(stage);

            const result = await run(stage, makeContext([agent()]));

            // The convention finding also cites the rule it applies.
            expect(contents(result.validSuggestions).sort()).toEqual(
                [
                    'Native: the entry is one-sided.',
                    'Rule: debit needs a credit.\n\n**Rule** (`docs/ledger.md`):\n> Debits equal credits.',
                ].sort(),
            );
        });

        it('a finding its own agent filters out never takes a native one with it', async () => {
            (hasManagedModelKey as jest.Mock).mockReturnValue(true);
            runSpy.mockImplementation(async (args: any) =>
                args?.runName === 'code-review-dedup'
                    ? { groups: [{ keep: 0, duplicates: [1] }], unique: [] }
                    : { groups: [], unique: [] },
            );
            const { stage } = makeStage(
                output([native(), finding({ severity: 'medium' })]),
            );
            honorEveryMerge(stage);

            const result = await run(
                stage,
                makeContext([
                    agent({
                        presentation: { minSeverity: 'high' },
                    }),
                ]),
            );

            expect(contents(result.validSuggestions)).toEqual([
                'Native: the entry is one-sided.',
            ]);
        });

        it('a finding over its agent comment limit never takes a native one with it', async () => {
            (hasManagedModelKey as jest.Mock).mockReturnValue(true);
            runSpy.mockImplementation(async (args: any) =>
                args?.runName === 'code-review-dedup'
                    ? { groups: [{ keep: 0, duplicates: [2] }], unique: [1] }
                    : { groups: [], unique: [] },
            );
            const { stage } = makeStage(
                output([
                    native(),
                    finding({
                        relevantLinesStart: 9,
                        relevantLinesEnd: 9,
                        severity: 'critical',
                        suggestionContent: 'Critical one.',
                    }),
                    finding({ severity: 'medium' }),
                ]),
            );
            honorEveryMerge(stage);

            const result = await run(
                stage,
                makeContext([agent({ presentation: { maxComments: 1 } })]),
            );

            expect(contents(result.validSuggestions).sort()).toEqual(
                ['Critical one.', 'Native: the entry is one-sided.'].sort(),
            );
        });
    });

    describe('skills and docs', () => {
        const knowledge = [
            {
                path: 'docs/ledger.md',
                kind: 'doc',
                linkedTo: ['main-review', { agentId: 'agent-ledger' }],
            },
            {
                path: 'docs/missing.md',
                kind: 'doc',
                linkedTo: [{ agentId: 'agent-ledger' }],
            },
        ];
        const withKnowledge = (over: Record<string, unknown> = {}) =>
            makeContext([agent()], {
                pullRequest: { number: 7, base: { ref: 'main' } },
                codeReviewConfig: {
                    reviewOptions: {},
                    heavy: false,
                    resolvedModelSlot: {
                        provider: 'openai',
                        model: 'gpt-4o-mini',
                    },
                    customAgents: [agent()],
                    knowledge,
                },
                ...over,
            });

        it('reads linked docs from the target branch for the main review and each agent', async () => {
            const { stage, reviewOrchestrator } = makeStage(output([]));

            await run(stage, withKnowledge());

            const call = reviewOrchestrator.execute.mock.calls[0][0];
            const byTarget = call.knowledgeByTarget as Map<string, any>;
            expect(byTarget.get('main-review').docs[0].content).toContain(
                'Debits equal credits.',
            );
            expect(
                byTarget.get('agent-ledger').docs.map((d: any) => d.path),
            ).toEqual(['docs/ledger.md']);
            expect(call.knowledgeReader?.ref).toBe('main');
        });

        it('reports a linked doc missing on the target branch as a review warning', async () => {
            const { stage } = makeStage(output([]));

            const result = await run(stage, withKnowledge());

            expect(result.reviewWarnings).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        kind: 'DOC_NOT_FOUND',
                        reason: 'knowledge',
                    }),
                ]),
            );
        });

        it('hands the agents the sandbox and the CLIs installed for them', async () => {
            const { stage, reviewOrchestrator } = makeStage(output([]));
            const installed = {
                'agent-ledger': [{ cli: { name: 'ledgerctl' } }],
            };

            await run(
                stage,
                makeContext([agent()], {
                    customAgentClis: { byAgentId: installed, warnings: [] },
                }),
            );

            const call = reviewOrchestrator.execute.mock.calls[0][0];
            expect(call.customAgentTooling.installedClis).toBe(installed);
        });
    });
});
