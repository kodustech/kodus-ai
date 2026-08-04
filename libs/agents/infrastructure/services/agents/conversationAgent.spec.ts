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

// Captures the Langfuse TRACE-level attributes the run propagates. Real
// `propagateAttributes` only sets OTel context, so there is nothing to assert
// on without intercepting it here.
const propagated: { params: any[] } = { params: [] };
jest.mock('@langfuse/tracing', () => ({
    propagateAttributes: (params: any, fn: () => unknown) => {
        propagated.params.push(params);
        return fn();
    },
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
        // native: the agent asks the service for the conversation carrier;
        // null → the env/managed default. resolveAgentModel is mocked, so the
        // harness wiring runs regardless of the resolved slot.
        resolveTaskCarrier: jest.fn().mockResolvedValue(null),
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

    it('groups the run under a Langfuse session so a thread reads as one conversation', async () => {
        // Trace-level attributes are only emitted when tracing is on — the same
        // gate `buildLangfuseTelemetry` uses for the observation payload.
        process.env.LANGFUSE_TRACING = 'true';
        process.env.LANGFUSE_PUBLIC_KEY = 'pk-test';
        process.env.LANGFUSE_SECRET_KEY = 'sk-test';
        propagated.params = [];
        modelRef.model = makeModel('answer');
        const { provider } = build();

        await provider.execute('hi', ctx);

        expect(propagated.params).toHaveLength(1);
        expect(propagated.params[0]).toMatchObject({
            traceName: 'conversationAgent',
            // A thread IS the session: every turn of the same conversation
            // lands under one Langfuse session instead of N orphan traces.
            sessionId: 'th1',
            // Org-level filtering in the Langfuse UI (parity with code-review).
            userId: 'org1',
            metadata: { organizationId: 'org1', teamId: 't1', threadId: 'th1' },
        });
    });

    it('does not propagate trace attributes when tracing is disabled', async () => {
        delete process.env.LANGFUSE_TRACING;
        propagated.params = [];
        modelRef.model = makeModel('answer');
        const { provider } = build();

        await provider.execute('hi', ctx);

        expect(propagated.params).toHaveLength(0);
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
