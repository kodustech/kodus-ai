/**
 * conversationAgent wiring — proves the harness migration end-to-end with a
 * mocked model (zero real LLM): resolveAgentModel -> AiSdkAgentRunner ->
 * finalText extraction -> recordAgentRunUsage. Guards the migration from silent
 * regressions (spec building, output extraction, cost emission, fallback).
 */
import { mockTextModel } from '../__test-utils__/mock-model';

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
import { MockLanguageModelV3 } from 'ai/test';

import { ConversationAgentProvider } from './conversationAgent';
import {
    CONVERSATION_FALLBACK_MESSAGE,
    CONVERSATION_PROVIDER_ERROR_MESSAGE,
} from './conversation-response.util';

const makeModel = (text: string) => mockTextModel(text);

/**
 * A model whose generation always throws — stands in for a network/timeout
 * error or a fired abort signal. The harness runner CATCHES this and returns a
 * RunState{status:'error'}, so `execute` must degrade to the provider-error
 * message and NEVER let the exception cross its boundary.
 */
function mockThrowingModel(
    err: Error = new Error('provider down'),
): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        doGenerate: async () => {
            throw err;
        },
    });
}

/**
 * A model that answers a different text per successive call. Lets one spec
 * exercise the main run (call 0) and the never-empty `forceAnswer` retry
 * (call 1) with distinct outputs, since both share the one resolved model.
 */
function mockSequenceModel(texts: string[]): MockLanguageModelV3 {
    let call = 0;
    return new MockLanguageModelV3({
        doGenerate: async () => {
            const text = texts[Math.min(call, texts.length - 1)] ?? '';
            call++;
            return {
                content: text ? [{ type: 'text', text }] : [],
                finishReason: { unified: 'stop', raw: 'stop' },
                usage: {
                    inputTokens: {
                        total: 10,
                        noCache: 10,
                        cacheRead: 0,
                        cacheWrite: 0,
                    },
                    outputTokens: { total: 5, text: 5, reasoning: 0 },
                },
                warnings: [],
            } as any;
        },
    });
}

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

    it('replays only the tail of a long thread', async () => {
        const { provider } = build();
        const load = jest.fn().mockResolvedValue(
            Array.from({ length: 30 }, (_, i) => ({
                role: i % 2 === 0 ? 'user' : 'assistant',
                content: `turn-${i}`,
            })),
        );
        (provider as any).conversationStore = {
            load,
            append: jest.fn().mockResolvedValue(undefined),
        };

        const history = await (provider as any).loadThreadHistory({
            id: 'th1',
        });

        expect(load).toHaveBeenCalledWith('th1');
        expect(history).toHaveLength(10);
        expect(history.at(0).content).toBe('turn-20');
        expect(history.at(-1).content).toBe('turn-29');
    });

    it('answers without history when the store fails', async () => {
        const { provider } = build();
        modelRef.model = makeModel('answer');
        (provider as any).conversationStore = {
            load: jest.fn().mockRejectedValue(new Error('mongo down')),
            append: jest.fn().mockResolvedValue(undefined),
        };

        await expect(provider.execute('hi', ctx)).resolves.toBe('answer');
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

/**
 * LLM.run I/O contract matrix — the DETERMINISTIC parse + fail-safe layer of
 * this boundary. This agent emits FREE TEXT (no structured `resultToolName`,
 * no json_schema call): the LLM answer flows
 *   runner.run -> finalText(state) [string] -> normalizeConversationResponse
 *   -> withVerifiedOutcome / fallback -> ALWAYS a string.
 *
 * The declared payload `D` is therefore "the plain-text reply to post", and the
 * parse boundary is `normalizeConversationResponse`, whose documented contract
 * is: the ONLY recognized wrapper is a `{ content }` envelope (object or
 * JSON-string, up to 4 levels deep); every other value is either returned as
 * literal prose (a legitimate answer) or nulls out so the caller surfaces an
 * OBSERVABLE fallback message — never a silent wrong answer.
 *
 * Rows 21-25 (typed value coercion: boolean/enum/index) are N/A — the payload
 * has no typed value fields, it is prose. Row 41 (off-by-one batch) is N/A —
 * the conversation is a single-turn ReAct loop with no input batching. Row 42
 * (permutation -> equivalent decision) is N/A — decision equivalence is
 * conversation QUALITY (the eval track), out of scope here; the parse and
 * return-shape are trivially order-independent. Dimension E (N-model
 * strict/json_object gate) does not apply: there is no structured-output-gate
 * at this boundary, so the same envelope parse runs provider-agnostically. The
 * parse layer itself is covered in conversation-response.util.spec.ts.
 */
describe('ConversationAgentProvider — fail-safe & return-shape contract (execute boundary)', () => {
    // ── C. Transport / fail-safe at the run boundary ───────────────────────

    it('[C30] a model/provider throw never crosses the boundary — it degrades to the provider-error message', async () => {
        modelRef.model = mockThrowingModel(new Error('ECONNRESET'));
        const { provider } = build();

        await expect(provider.execute('hi', ctx)).resolves.toBe(
            CONVERSATION_PROVIDER_ERROR_MESSAGE,
        );
    });

    it('never-empty guard: an empty main run recovers via the single forceAnswer retry', async () => {
        // call 0 (main) -> empty; call 1 (forceAnswer) -> real text.
        modelRef.model = mockSequenceModel(['', 'recovered on retry']);
        const { provider } = build();

        await expect(provider.execute('hi', ctx)).resolves.toBe(
            'recovered on retry',
        );
    });

    it('return-shape invariant: every path returns a non-empty string', async () => {
        const cases = ['plain answer', '', '{"content":""}'];
        for (const text of cases) {
            modelRef.model = makeModel(text);
            const { provider } = build();
            const res = await provider.execute('hi', ctx);
            expect(typeof res).toBe('string');
            expect(res.length).toBeGreaterThan(0);
        }
    });

    // ── D. Input variants ──────────────────────────────────────────────────

    it('[D39] null/undefined optional fields (no thread id, no prepareContext) still return a string', async () => {
        modelRef.model = makeModel('answer without ids');
        const { provider } = build();

        const res = await provider.execute('hi', {
            organizationAndTeamData: { organizationId: 'org1' },
            // thread present (required) but with no id; no prepareContext.
            thread: {},
        } as any);

        expect(res).toBe('answer without ids');
    });
});
