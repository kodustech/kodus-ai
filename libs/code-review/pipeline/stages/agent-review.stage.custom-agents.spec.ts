import { frozenContext } from '../../../../test/fixtures/frozen-pipeline-context';
import { AgentReviewStage } from './agent-review.stage';
import { CodeReviewPipelineContext } from '../context/code-review-pipeline.context';
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
 * they found: the beta gate, shadow mode, per-agent severity floor, comment
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
    presentation: { mode: 'post', tag: { color: '#7B1FA2' } },
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
            mode: 'post',
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
    it('dispatches no custom agent while the org lacks the beta', async () => {
        const { stage, reviewOrchestrator } = makeStage(output([]), false);

        await run(stage, makeContext([agent()]));

        expect(
            reviewOrchestrator.execute.mock.calls[0][0].customAgents,
        ).toEqual([]);
    });

    it('dispatches the enabled agents when the org has the beta', async () => {
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

        expect(featureGate.isEnabled).toHaveBeenCalledWith(
            'custom-agents',
            expect.objectContaining({ identifier: 'org-1' }),
        );
        expect(
            reviewOrchestrator.execute.mock.calls[0][0].customAgents.map(
                (a: any) => a.id,
            ),
        ).toEqual(['agent-ledger']);
    });

    it('never posts a shadow agent finding and keeps it as not sent', async () => {
        const { stage } = makeStage(output([finding()]));

        const result = await run(
            stage,
            makeContext([agent({ presentation: { mode: 'shadow' } })]),
        );

        expect(contents(result.validSuggestions)).toEqual([]);
        expect(result.validSuggestionsByPR ?? []).toEqual([]);
        const stored = result.discardedSuggestions.find(
            (s: any) => s.customAgent?.id === 'agent-ledger',
        );
        expect(stored).toMatchObject({
            deliveryStatus: 'not_sent',
            notSentReason: 'custom-agent-shadow',
        });
        expect(result.customAgentRuns[0]).toMatchObject({
            posted: 0,
            shadowKept: 1,
        });
    });

    it('posts a post-mode finding inline and counts it in the summary', async () => {
        const { stage } = makeStage(output([finding()]));

        const result = await run(stage, makeContext([agent()]));

        expect(contents(result.validSuggestions)).toEqual([
            'The entry is booked on one side only.',
        ]);
        expect(result.customAgentRuns[0]).toMatchObject({
            posted: 1,
            shadowKept: 0,
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
            makeContext([
                agent({ presentation: { mode: 'post', minSeverity: 'high' } }),
            ]),
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
            makeContext([
                agent({ presentation: { mode: 'post', maxComments: 1 } }),
            ]),
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
                    presentation: { mode: 'post', suggestedFix: 'never' },
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
                    presentation: { mode: 'post', format: 'single-comment' },
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

    it('holds approval for a cut-short post agent but not for a shadow one', async () => {
        const incomplete = (mode: string) => ({
            agentName: 'custom-agent:ledger-rules',
            category: 'custom_agent',
            finishReason: 'max-steps',
            suggestionsFound: 0,
            durationMs: 1,
            customAgent: { id: 'agent-ledger', mode },
        });

        const shadow = makeStage(
            output([], { incomplete: [incomplete('shadow')] }),
        );
        const shadowResult = await run(
            shadow.stage,
            makeContext([agent({ presentation: { mode: 'shadow' } })]),
        );
        expect(
            (shadowResult.errors ?? []).filter((e: any) =>
                e.substage?.startsWith('agent:custom-agent'),
            ),
        ).toEqual([]);

        const post = makeStage(
            output([], { incomplete: [incomplete('post')] }),
        );
        const postResult = await run(post.stage, makeContext([agent()]));
        expect(
            (postResult.errors ?? []).find(
                (e: any) => e.substage === 'agent:custom-agent:ledger-rules',
            )?.severity,
        ).toBe('partial');
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
                        presentation: { mode: 'post', minSeverity: 'high' },
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
                makeContext([
                    agent({ presentation: { mode: 'post', maxComments: 1 } }),
                ]),
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

        it('reads nothing while the org lacks the beta', async () => {
            const { stage, reviewOrchestrator, codeManagement } = makeStage(
                output([]),
                false,
            );

            await run(stage, withKnowledge());

            expect(
                reviewOrchestrator.execute.mock.calls[0][0].knowledgeByTarget,
            ).toBeUndefined();
            expect(
                codeManagement.getRepositoryContentFile,
            ).not.toHaveBeenCalled();
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
