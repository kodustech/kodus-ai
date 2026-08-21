/**
 * conversationAgent wiring — proves the harness migration end-to-end with a
 * mocked model (zero real LLM): resolveAgentModel -> AiSdkAgentRunner ->
 * finalText extraction -> recordAgentRunUsage. Guards the migration from silent
 * regressions (spec building, output extraction, cost emission, fallback).
 */
import { mockTextModel } from './__test-utils__/mock-model';

// The runner resolves the model via LLM.run -> resolveModelConfig; mock it to
// return our mock model so the agent's real loop runs without touching BYOK.
const modelRef: { model: any } = { model: null };
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: () => ({
        model: modelRef.model,
        callOptions: {},
        providerOptions: {},
        modelName: 'mock',
        usageIdentity: {},
    }),
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

import { setLlmObservability } from '@libs/llm/llm-observability';

import { ConversationAgentProvider } from './conversationAgent';
import { CONVERSATION_FALLBACK_MESSAGE } from './conversation-response.util';

const makeModel = (text: string) => mockTextModel(text);

afterEach(() => setLlmObservability(undefined));

function build() {
    // Cost is recorded by LLM.run's observability span (the port), not by the
    // agent. Register a spy port to assert the span carries the conversation attrs.
    const runAiSdkLLMInSpan = jest.fn((p: any) => p.exec());
    setLlmObservability({ runAiSdkLLMInSpan } as any);
    const parametersService = {
        findByKey: jest.fn().mockResolvedValue({ configValue: 'en-US' }),
    };
    const permissionValidationService = {
        // native: the agent asks the service for the conversation slot;
        // null → the env/managed default. resolveAgentModel is mocked, so the
        // harness wiring runs regardless of the resolved slot.
        resolveTaskSlot: jest.fn().mockResolvedValue(null),
    };
    const mcpManagerService = {
        getConnections: jest.fn().mockResolvedValue([]),
    };
    const provider = new ConversationAgentProvider(
        parametersService as any,
        permissionValidationService as any,
        mcpManagerService as any,
    );
    return { provider, runAiSdkLLMInSpan };
}

const ctx = {
    organizationAndTeamData: { organizationId: 'org1', teamId: 't1' },
    thread: { id: 'th1' },
} as any;

describe('ConversationAgentProvider (harness wiring)', () => {
    it('runs on the harness and returns the model answer', async () => {
        modelRef.model = makeModel('here is your answer');
        const { provider, runAiSdkLLMInSpan } = build();

        const res = await provider.execute('hi', ctx);

        expect(res).toContain('here is your answer');
        // cost recorded by LLM.run's span, tagged with the conversation attrs.
        expect(runAiSdkLLMInSpan).toHaveBeenCalledWith(
            expect.objectContaining({
                attrs: expect.objectContaining({
                    agentName: 'ConversationalAgent',
                    phase: 'conversation',
                }),
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
