/**
 * businessRulesValidationAgent.callLLM wiring — proves the analysis runs on the
 * harness with a mocked model (zero real LLM): resolveAgentModel ->
 * AiSdkAgentRunner (single-shot, no tools) -> finalText -> recordAgentRunUsage.
 * Symmetric to conversationAgent.spec; the existing agent spec mocks above
 * callLLM, so this is what covers the runner wiring.
 */
import { mockTextModel } from '../__test-utils__/mock-model';

const modelRef: { model: any } = { model: null };
// The runner resolves the model via LLM.run -> resolveModelConfig (and the
// analyzer reads its callOptions); mock it to return our mock model.
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: () => ({
        model: modelRef.model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    }),
}));

// Trace-level attributes only exist in OTel context; intercept to assert them.
const propagated: { params: any[] } = { params: [] };
jest.mock('@langfuse/tracing', () => ({
    propagateAttributes: (params: any, fn: () => unknown) => {
        propagated.params.push(params);
        return fn();
    },
}));

import { setLlmObservability } from '@libs/llm/llm-observability';

import { BusinessRulesValidationAgentProvider } from './businessRulesValidationAgent';

const makeModel = (text: string) =>
    mockTextModel(text, { inputTokens: 12, outputTokens: 6 });

afterEach(() => setLlmObservability(undefined));

function build() {
    // Cost is recorded by LLM.run's observability span (the port), not by the
    // agent. Register a spy port to assert the span carries the analyzer attrs.
    const runAiSdkLLMInSpan = jest.fn((p: any) => p.exec());
    setLlmObservability({ runAiSdkLLMInSpan } as any);
    const provider = new BusinessRulesValidationAgentProvider(
        {} as any,
        {} as any,
        { recordAgentRunUsage: jest.fn() } as any,
        {
            getExecutionPolicy: jest.fn(),
            getAnalyzerInstructions: jest.fn(),
        } as any,
    );
    return { provider, runAiSdkLLMInSpan };
}

describe('BusinessRulesValidationAgentProvider.callLLM (harness wiring)', () => {
    it('runs the analysis on the harness and returns the model text', async () => {
        modelRef.model = makeModel('## Business Rules Validation\nOK');
        const { provider, runAiSdkLLMInSpan } = build();

        const res = await (provider as any).callLLM(
            [
                { role: 'system', content: 'analyzer instructions' },
                { role: 'user', content: 'analyze this PR' },
            ],
            { temperature: 0, maxTokens: 100 },
            'businessRulesAnalyzer',
            { organizationId: 'org-1', teamId: 'team-1' },
        );

        expect(res.content).toContain('## Business Rules Validation');
        // usage shape is present (exact counts depend on AI SDK mock plumbing).
        expect(res.usage).toHaveProperty('totalTokens');
        expect(runAiSdkLLMInSpan).toHaveBeenCalledWith(
            expect.objectContaining({
                attrs: expect.objectContaining({
                    agentName: 'BusinessRulesValidation',
                    phase: 'businessRulesAnalyzer',
                }),
            }),
        );
    });

    it('returns empty content when the model produces no text (no throw)', async () => {
        modelRef.model = makeModel('');
        const { provider } = build();

        const res = await (provider as any).callLLM(
            [{ role: 'user', content: 'analyze' }],
            {},
            'businessRulesAnalyzer',
            {},
        );

        expect(res.content).toBe('');
    });
});

describe('BusinessRulesValidationAgentProvider trace attribution', () => {
    it('joins the PR session the code-review agents open', () => {
        const { provider } = build();

        const attrs = (provider as any).traceAttributes({
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            prepareContext: {
                pullRequestNumber: 42,
                repository: { id: 'repo-9' },
            },
        });

        expect(attrs).toMatchObject({
            // Same key `runAgentWithTrace` derives for the review agents —
            // that is what puts both in ONE Langfuse session. The base class
            // applies it around the whole run (fetcher included).
            sessionId: 'org-1:repo-9:42',
            userId: 'org-1',
            metadata: {
                organizationId: 'org-1',
                teamId: 'team-1',
                repositoryId: 'repo-9',
                pullRequestId: '42',
            },
        });
    });

    it('falls back to an org-scoped trace when there is no PR', () => {
        const { provider } = build();

        const attrs = (provider as any).traceAttributes({
            organizationAndTeamData: { organizationId: 'org-1' },
        });

        // No PR to group under -> no invented session, but the run is still
        // attributed to the org.
        expect(attrs.sessionId).toBeUndefined();
        expect(attrs.userId).toBe('org-1');
    });
});
