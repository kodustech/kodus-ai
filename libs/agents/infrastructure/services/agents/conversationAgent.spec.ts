/**
 * conversationAgent wiring — proves the harness migration end-to-end with a
 * mocked model (zero real LLM): resolveAgentModel -> AiSdkAgentRunner ->
 * finalText extraction -> recordAgentRunUsage. Guards the migration from silent
 * regressions (spec building, output extraction, cost emission, fallback).
 */
import { MockLanguageModelV3 } from 'ai/test';

// resolveAgentModel is mocked to return our mock model, so the agent's real
// loop runs without touching BYOK / a provider.
const modelRef: { model: any } = { model: null };
jest.mock('@libs/llm/agent-model', () => ({
    resolveAgentModel: () => modelRef.model,
}));

import { ConversationAgentProvider } from './conversationAgent';
import { CONVERSATION_FALLBACK_MESSAGE } from './conversation-response.util';

function makeModel(text: string) {
    return new MockLanguageModelV3({
        doGenerate: async () => ({
            content: text ? [{ type: 'text', text }] : [],
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5 },
            warnings: [],
        }),
    });
}

function build() {
    const recordAgentRunUsage = jest.fn().mockResolvedValue(undefined);
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
    };
    const permissionValidationService = {
        getBYOKConfig: jest
            .fn()
            .mockResolvedValue({ main: { provider: 'openai', model: 'gpt' } }),
    };
    const observabilityService = { recordAgentRunUsage };
    const mcpManagerService = {
        getConnections: jest.fn().mockResolvedValue([]),
    };
    const provider = new ConversationAgentProvider(
        parametersService as any,
        permissionValidationService as any,
        observabilityService as any,
        mcpManagerService as any,
    );
    return { provider, recordAgentRunUsage };
}

const ctx = {
    organizationAndTeamData: { organizationId: 'org1', teamId: 't1' },
    thread: { id: 'th1' },
} as any;

describe('ConversationAgentProvider (harness wiring)', () => {
    it('runs on the harness and returns the model answer', async () => {
        modelRef.model = makeModel('here is your answer');
        const { provider, recordAgentRunUsage } = build();

        const res = await provider.execute('hi', ctx);

        expect(res).toContain('here is your answer');
        // cost emitted via the canonical emitter, tagged as the conversation phase
        expect(recordAgentRunUsage).toHaveBeenCalledTimes(1);
        expect(recordAgentRunUsage).toHaveBeenCalledWith(
            expect.objectContaining({
                agentName: 'ConversationalAgent',
                phase: 'conversation',
            }),
        );
    });

    it('falls back when the model produces no usable text', async () => {
        modelRef.model = makeModel('');
        const { provider } = build();

        const res = await provider.execute('hi', ctx);

        expect(res).toBe(CONVERSATION_FALLBACK_MESSAGE);
    });

    it('requires organization data and a thread', async () => {
        modelRef.model = makeModel('x');
        const { provider } = build();

        await expect(provider.execute('hi', {} as any)).rejects.toThrow();
        await expect(
            provider.execute('hi', {
                organizationAndTeamData: { organizationId: 'o' },
            } as any),
        ).rejects.toThrow();
    });
});
