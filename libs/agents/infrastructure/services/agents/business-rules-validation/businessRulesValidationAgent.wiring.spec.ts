/**
 * businessRulesValidationAgent.callLLM wiring — proves the analysis runs on the
 * harness with a mocked model (zero real LLM): resolveAgentModel ->
 * AiSdkAgentRunner (single-shot, no tools) -> finalText -> recordAgentRunUsage.
 * Symmetric to conversationAgent.spec; the existing agent spec mocks above
 * callLLM, so this is what covers the runner wiring.
 */
import { MockLanguageModelV3 } from 'ai/test';

const modelRef: { model: any } = { model: null };
jest.mock('@libs/llm/agent-model', () => ({
    resolveAgentModel: () => modelRef.model,
}));

// Trace-level attributes only exist in OTel context; intercept to assert them.
const propagated: { params: any[] } = { params: [] };
jest.mock('@langfuse/tracing', () => ({
    propagateAttributes: (params: any, fn: () => unknown) => {
        propagated.params.push(params);
        return fn();
    },
}));

import { BusinessRulesValidationAgentProvider } from './businessRulesValidationAgent';

function makeModel(text: string) {
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: text ? [{ type: 'text', text }] : [],
            finishReason: 'stop',
            usage: { inputTokens: 12, outputTokens: 6 },
            warnings: [],
        }),
    });
}

function build() {
    const recordAgentRunUsage = jest.fn().mockResolvedValue(undefined);
    const provider = new BusinessRulesValidationAgentProvider(
        {} as any,
        {} as any,
        { recordAgentRunUsage } as any,
        {
            getExecutionPolicy: jest.fn(),
            getAnalyzerInstructions: jest.fn(),
        } as any,
    );
    // callLLM reads this.observabilityService — set explicitly so the test does
    // not depend on where the base class stores it.
    (provider as any).observabilityService = { recordAgentRunUsage };
    return { provider, recordAgentRunUsage };
}

describe('BusinessRulesValidationAgentProvider.callLLM (harness wiring)', () => {
    it('runs the analysis on the harness and returns the model text', async () => {
        modelRef.model = makeModel('## Business Rules Validation\nOK');
        const { provider, recordAgentRunUsage } = build();

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
        expect(recordAgentRunUsage).toHaveBeenCalledWith(
            expect.objectContaining({
                agentName: 'BusinessRulesValidation',
                phase: 'businessRulesAnalyzer',
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
