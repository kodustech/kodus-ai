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
