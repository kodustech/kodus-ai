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
    normalizeConversationResponse,
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
 * at this boundary, so the same envelope parse runs provider-agnostically (one
 * test below pins that).
 */
describe('normalizeConversationResponse — I/O contract matrix (parse layer)', () => {
    // ── A. Output-shape zoo ────────────────────────────────────────────────

    it('[A1] returns the exact D (plain string) unchanged', () => {
        expect(normalizeConversationResponse('the real answer')).toBe(
            'the real answer',
        );
    });

    it('[A2] a bare array (object expected) yields no usable content -> null', () => {
        expect(normalizeConversationResponse(['a', 'b'])).toBeNull();
    });

    it('[A3] a single object where a string is expected is unwrapped via content; a non-envelope object nulls', () => {
        expect(normalizeConversationResponse({ content: 'x' })).toBe('x');
        expect(normalizeConversationResponse({ notContent: 'x' })).toBeNull();
    });

    it('[A4] a non-content wrapper key is NOT invented as an envelope', () => {
        // Only `content` is a recognized envelope. A `{result:...}` OBJECT has
        // no usable content -> null -> observable fallback (never a wrong ship).
        expect(normalizeConversationResponse({ result: 'x' })).toBeNull();
        expect(normalizeConversationResponse({ data: 'x' })).toBeNull();
        expect(normalizeConversationResponse({ output: 'x' })).toBeNull();
        // A `{"result":...}` JSON STRING is preserved verbatim as a legitimate
        // JSON answer (parity with the existing "{foo:1} preserved" contract);
        // the agent may have been asked to reply with JSON.
        expect(normalizeConversationResponse('{"result":"x"}')).toBe(
            '{"result":"x"}',
        );
    });

    it('[A5] a double wrapper {result:{result:D}} has no content key -> null', () => {
        expect(
            normalizeConversationResponse({ result: { result: 'x' } }),
        ).toBeNull();
    });

    it('[A6] numeric/opaque single-key wrap nulls; the {content} wrap unwraps', () => {
        expect(normalizeConversationResponse({ '0': 'x' })).toBeNull();
        expect(normalizeConversationResponse({ content: 'x' })).toBe('x');
    });

    it('[A7] a stringified {content} JSON is unwrapped; other stringified JSON is kept literal', () => {
        expect(normalizeConversationResponse('{"content":"answer"}')).toBe(
            'answer',
        );
        expect(normalizeConversationResponse('{"foo":1}')).toBe('{"foo":1}');
    });

    it('[A8] a markdown-fenced block is kept as prose (a fenced code block is a valid reply)', () => {
        const fenced = '```json\n{"content":"x"}\n```';
        // Does not start with `{` -> not treated as an envelope -> returned
        // as-is. For a chat reply, a fenced block is legitimate content.
        expect(normalizeConversationResponse(fenced)).toBe(fenced);
    });

    it('[A9] prose that merely contains braces is returned unchanged', () => {
        expect(
            normalizeConversationResponse('Here is the result: {"content":"x"}'),
        ).toBe('Here is the result: {"content":"x"}');
    });

    it('[A10] right data under the wrong key is not recovered (object nulls; JSON string kept literal)', () => {
        expect(normalizeConversationResponse({ answer: 'x' })).toBeNull();
        expect(normalizeConversationResponse('{"answer":"x"}')).toBe(
            '{"answer":"x"}',
        );
    });

    it('[A11] the envelope key is case-sensitive: {Content} is not unwrapped', () => {
        expect(normalizeConversationResponse({ Content: 'x' })).toBeNull();
    });

    it('[A12] a partial object with content unwraps; without content it nulls', () => {
        expect(normalizeConversationResponse({ content: 'x', foo: 1 })).toBe(
            'x',
        );
        expect(normalizeConversationResponse({ foo: 1 })).toBeNull();
    });

    it('[A13] extra unknown keys alongside content are tolerated (no crash)', () => {
        expect(
            normalizeConversationResponse({
                content: 'x',
                extra: true,
                meta: { a: 1 },
            }),
        ).toBe('x');
    });

    it('[A14] an empty object -> null', () => {
        expect(normalizeConversationResponse({})).toBeNull();
    });

    it('[A15] an empty array -> null', () => {
        expect(normalizeConversationResponse([])).toBeNull();
    });

    it('[A16] an empty / whitespace-only string -> null', () => {
        expect(normalizeConversationResponse('')).toBeNull();
        expect(normalizeConversationResponse('   \n\t ')).toBeNull();
    });

    it('[A17] null / undefined -> null', () => {
        expect(normalizeConversationResponse(null)).toBeNull();
        expect(normalizeConversationResponse(undefined)).toBeNull();
    });

    it('[A18] a primitive where an object is expected nulls; a bare string survives', () => {
        expect(normalizeConversationResponse(true as any)).toBeNull();
        expect(normalizeConversationResponse(0 as any)).toBeNull();
        expect(normalizeConversationResponse('ok')).toBe('ok');
    });

    it('[A19] a raw provider-envelope leak has no content key at the top -> null (fail-safe)', () => {
        expect(
            normalizeConversationResponse({
                choices: [{ message: { content: 'buried' } }],
            }),
        ).toBeNull();
    });

    it('[A20] a reasoning/thinking leak in the text is passed through uncorrupted (signature repair is upstream)', () => {
        const withThinking =
            '<thinking>let me reason</thinking> the actual answer';
        expect(normalizeConversationResponse(withThinking)).toBe(withThinking);
    });

    // ── B. Semantic-but-wrong ──────────────────────────────────────────────

    it('[B26] duplicate JSON keys in the envelope resolve last-wins (JSON.parse contract)', () => {
        expect(
            normalizeConversationResponse('{"content":"a","content":"b"}'),
        ).toBe('b');
    });

    it('[B27] unicode / emoji / escaped newlines inside the text are preserved', () => {
        expect(normalizeConversationResponse('café 🚀\n\nsecond line')).toBe(
            'café 🚀\n\nsecond line',
        );
        // ...also when they arrive inside a {content} envelope.
        expect(
            normalizeConversationResponse('{"content":"olá 🙂\\nlinha 2"}'),
        ).toBe('olá 🙂\nlinha 2');
    });

    // ── C. Unparseable / transport (parse-side rows) ───────────────────────

    it('[C28] truncated JSON is not parseable as an envelope -> returned as literal text (no throw)', () => {
        expect(normalizeConversationResponse('{"content":"ans')).toBe(
            '{"content":"ans',
        );
    });

    it('[C29] malformed JSON (unquoted keys) is returned as literal text (no throw)', () => {
        expect(normalizeConversationResponse('{content: "x"}')).toBe(
            '{content: "x"}',
        );
    });

    it('[C31] an {error} object has no content -> null (caller surfaces a fallback, not the raw error)', () => {
        expect(normalizeConversationResponse({ error: 'boom' })).toBeNull();
    });

    // ── E. Provider-agnostic parse (no structured-output-gate here) ─────────

    it('[E] the same schema-echo is normalized identically regardless of provider', () => {
        // There is no strict-json_schema vs json_object branch at this boundary;
        // the envelope parse is uniform, so a `{"content":""}` echo from ANY
        // model degrades to null -> fallback the same way.
        expect(normalizeConversationResponse('{"content":""}')).toBeNull();
        expect(normalizeConversationResponse({ content: '' })).toBeNull();
    });
});

describe('ConversationAgentProvider — fail-safe & return-shape contract (execute boundary)', () => {
    // ── C. Transport / fail-safe at the run boundary ───────────────────────

    it('[C30] a model/provider throw never crosses the boundary — it degrades to the provider-error message', async () => {
        modelRef.model = mockThrowingModel(new Error('ECONNRESET'));
        const { provider } = build();

        await expect(provider.execute('hi', ctx)).resolves.toBe(
            CONVERSATION_PROVIDER_ERROR_MESSAGE,
        );
    });

    it('[C31] a run that ENDS in error (zero tokens) yields the technical message, not the add-context nudge', async () => {
        // The runner maps a provider throw to RunState{stopReason:"error"};
        // execute must read that and pick the provider-error copy.
        modelRef.model = mockThrowingModel();
        const { provider } = build();

        const res = await provider.execute('hi', ctx);

        expect(res).toBe(CONVERSATION_PROVIDER_ERROR_MESSAGE);
        expect(res).not.toBe(CONVERSATION_FALLBACK_MESSAGE);
    });

    it('[C32] an empty-success run (no usable text) degrades to the fallback message', async () => {
        modelRef.model = makeModel('');
        const { provider } = build();

        await expect(provider.execute('hi', ctx)).resolves.toBe(
            CONVERSATION_FALLBACK_MESSAGE,
        );
    });

    it('[C33] a refusal reply is a legitimate answer and is returned verbatim (not dropped)', async () => {
        modelRef.model = makeModel('I cannot help with that request.');
        const { provider } = build();

        await expect(provider.execute('hi', ctx)).resolves.toBe(
            'I cannot help with that request.',
        );
    });

    it('[C34] a fired abort surfaces as the provider-error message, never a thrown AbortError', async () => {
        const abortErr = new Error('The operation was aborted');
        abortErr.name = 'AbortError';
        modelRef.model = mockThrowingModel(abortErr);
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

    it('[D35] an empty prompt still yields a string reply', async () => {
        modelRef.model = makeModel('ok');
        const { provider } = build();

        const res = await provider.execute('', ctx);
        expect(typeof res).toBe('string');
        expect(res.length).toBeGreaterThan(0);
    });

    it('[D36] a single normal prompt returns the model answer', async () => {
        modelRef.model = makeModel('single answer');
        const { provider } = build();

        await expect(provider.execute('one question', ctx)).resolves.toContain(
            'single answer',
        );
    });

    it('[D37] a very large prompt is handled and still returns a string', async () => {
        modelRef.model = makeModel('handled');
        const { provider } = build();

        const huge = 'x'.repeat(200_000);
        await expect(provider.execute(huge, ctx)).resolves.toBe('handled');
    });

    it('[D38] duplicate prior turns in the thread history do not break the reply', async () => {
        modelRef.model = makeModel('answer with dup history');
        const { provider } = build();
        (provider as any).conversationStore = {
            load: jest.fn().mockResolvedValue([
                { role: 'user', content: 'same' },
                { role: 'user', content: 'same' },
                { role: 'assistant', content: 'same' },
                { role: 'assistant', content: 'same' },
            ]),
            append: jest.fn().mockResolvedValue(undefined),
        };

        await expect(provider.execute('hi', ctx)).resolves.toBe(
            'answer with dup history',
        );
    });

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

    it('[D40] special chars / whitespace-only prompts are handled', async () => {
        modelRef.model = makeModel('handled special');
        const { provider } = build();

        await expect(
            provider.execute('🚀 café   <script> \n\t', ctx),
        ).resolves.toBe('handled special');

        modelRef.model = makeModel('handled blank');
        const { provider: p2 } = build();
        await expect(p2.execute('     ', ctx)).resolves.toBe('handled blank');
    });
});
