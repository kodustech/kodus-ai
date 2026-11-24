/**
 * Structured-output recovery matrix: provider × structured mode × reply shape.
 *
 * ─── THE QUESTION ──────────────────────────────────────────────────────────
 * `structured-output-repair.spec.ts` proves what `repairAndValidate` returns
 * for a raw string. Production never hands it a raw string: the model's text
 * arrives inside the provider's own response body, is parsed by the provider's
 * AI SDK package, and only then reaches the structured executor
 * (`structured-review-call.ts`), which decides between "the answer", "re-ask"
 * and "throw". This file asks the composed question — for a real stored slot,
 * what does the caller of `LLM.run({ schema })` get back, and how many
 * upstream requests did it cost?
 *
 * ─── THE THREE ROUTES TO `repairAndValidate` ───────────────────────────────
 *   text-parse   `Output.object` over a text answer (response_format
 *                json_schema / json_object, Responses `text.format`, Gemini
 *                `responseSchema`, Anthropic/Bedrock `output_config.format`).
 *                The SDK `JSON.parse`s the text; a parse failure throws
 *                NoObjectGeneratedError(JSONParseError) and the executor's
 *                `salvageStructuredError` runs `repairAndValidate` on it. No
 *                answer there → ONE re-ask in json_object mode with the schema
 *                in the prompt (`reissueDowngraded`), whose answer the caller
 *                gets. 2 requests.
 *   reroute-json Always-thinking / auto-only-tool_choice models: plain
 *                generateText, `repairAndValidate` IS the parser. No answer →
 *                the executor THROWS (no re-ask; a 429 is the only re-issue).
 *                1 request.
 *   json-tool    Output.object as a FORCED `json` tool. The SDK turns the tool
 *                input into the text, so it always parses; only a shape
 *                mismatch fails (→ re-ask). What a reply's TEXT block does
 *                depends on the SDK package: @ai-sdk/anthropic DROPS text
 *                blocks while it forces the json tool (so a model that answers
 *                in text instead of the tool is re-asked, whatever the text
 *                held), @ai-sdk/amazon-bedrock KEEPS them (so the text reaches
 *                `repairAndValidate` exactly like the text-parse route).
 *
 * ─── ADDING A ROW ──────────────────────────────────────────────────────────
 * One entry in `ROWS`: a slot picked from the production corpus
 * (`testing/__fixtures__/byok-prod-shapes.json`) and what the gate gives it.
 * The coverage tests at the bottom go red when the corpus holds a
 * provider × plan × wire channel no row exercises.
 *
 * Nothing about the providers is mocked; only `globalThis.fetch` is stubbed
 * (`structured-output-recovery-matrix.wire.ts`). No network.
 */

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { z } from 'zod';

import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';
import { LLM } from './llm';
import { REGISTRY } from './providers';
import {
    NON_REASONING_TRAITS,
    planStructuredCall,
    type StructuredCallPlan,
} from './providers/kernel/reasoning-traits';
import type { NormalizedModel } from './byok-config';
import {
    channelOf,
    cleanReplyFor,
    withStubbedModel,
    type CapturedRequest,
    type ModelReply,
    type StructuredChannel,
    type StubbedRun,
    type WireProtocol,
} from './structured-output-recovery-matrix.wire';

// ─── the contract every row is asked for ────────────────────────────────────

const SCHEMA = z.object({
    violations: z.array(z.object({ body: z.string(), line: z.number() })),
});
type Answer = z.infer<typeof SCHEMA>;

const FINDINGS: Answer = { violations: [{ body: 'bug', line: 12 }] };
const F = JSON.stringify(FINDINGS);
/** What the re-ask answers: distinct from FINDINGS, so a passing re-ask row
 *  proves the caller got the SECOND answer, not a guess from the first. */
const REASKED: Answer = { violations: [{ body: 're-asked', line: 7 }] };
const FENCED_BODY = 'Use this:\n```ts\nconst o = { a: 1 };\n```';

/** What `repairAndValidate` must make of a text: the answer, or nothing
 *  (→ the route's re-ask or failure). */
type Outcome = { kind: 'answer'; value: Answer } | { kind: 'reask' };

interface Shape {
    id: string;
    reply: ModelReply;
    /** What `repairAndValidate` must make of the text. */
    outcome: Outcome;
    /** The change this outcome needs, for the revert proof. */
    dependsOn: string;
    /** Wall-clock ceiling for the whole call (ms). */
    maxMs?: number;
}

const SHAPES: Shape[] = [
    {
        id: '1 clean JSON answer',
        reply: { text: F },
        outcome: { kind: 'answer', value: FINDINGS },
        dependsOn: '-',
    },
    {
        id: '2 a ```ruby block quoted before the answer (#2255)',
        reply: {
            text:
                'The header is built like this:\n' +
                '```ruby\nheader = [process.env.X || "y"]\n```\n' +
                'Findings:\n' +
                F,
        },
        outcome: { kind: 'answer', value: FINDINGS },
        dependsOn: '#2566',
    },
    {
        id: '3 answer, then "the expected format is" + a json fence holding a placeholder',
        reply: {
            text:
                '```ruby\n[x]\n```\n' +
                F +
                '\nthe expected format is\n' +
                '```json\n{"violations":[{"body":"...","line":0}]}\n```',
        },
        outcome: { kind: 'answer', value: FINDINGS },
        dependsOn: '#2566',
    },
    {
        id: '4 ```ts code, real findings, then `Empty would be {"violations":[]}`',
        reply: {
            text:
                '```ts\nconst a = 1;\n```\n' +
                F +
                '\nEmpty would be {"violations":[]}',
        },
        outcome: { kind: 'answer', value: FINDINGS },
        dependsOn: '#2566',
    },
    {
        id: '5 findings whose string value holds a ``` fence with braces',
        // Prose first, so the SDK's own JSON.parse fails and the text
        // reaches repairAndValidate on every route, not only reroute-json.
        reply: {
            text:
                'Here is the fix:\n' +
                JSON.stringify({
                    violations: [{ body: FENCED_BODY, line: 3 }],
                }),
        },
        outcome: {
            kind: 'answer',
            value: { violations: [{ body: FENCED_BODY, line: 3 }] },
        },
        dependsOn: '#2700 (6710fc5d4)',
    },
    {
        id: '6 prose empty example + ```ts code + findings',
        reply: {
            text:
                'If nothing is wrong I would return {"violations":[]}.\n' +
                '```ts\nconst a = 1;\n```\n' +
                F,
        },
        outcome: { kind: 'reask' },
        dependsOn: '#2700 (6710fc5d4)',
    },
    {
        id: '7 findings + ```ts code + `Empty would be {"violations":[]}`',
        reply: {
            text:
                F +
                '\n```ts\nconst a = 1;\n```\n' +
                'Empty would be {"violations":[]}',
        },
        outcome: { kind: 'reask' },
        dependsOn: '#2700 (6710fc5d4)',
    },
    {
        id: '8 reply cut off after a quoted code block, only the prose example present',
        reply: {
            text:
                'If nothing is wrong I would return {"violations":[]}.\n' +
                '```ts\nconst a = 1;\n```\n',
            cutOff: true,
        },
        outcome: { kind: 'reask' },
        dependsOn: '#2700 (0be848331)',
    },
    {
        id: '9 a reply of 1,000,000 `{`',
        reply: { text: '{'.repeat(1_000_000) },
        outcome: { kind: 'reask' },
        dependsOn: '#2700 (0be848331)',
        maxMs: 3_000,
    },
    {
        id: '10 a <think> block in the text before the answer',
        reply: {
            text:
                '<think>Rule [1] says no `any`. `const x = { a: 1 }` is typed; ' +
                '{"violations":[]} would mean clean.</think>\n' +
                F,
        },
        outcome: { kind: 'answer', value: FINDINGS },
        dependsOn: '-',
    },
];

// ─── the rows: real production slots, grouped by what the gate gives them ───

type Route =
    'text-parse' | 'reroute-json' | 'anthropic-json-tool' | 'bedrock-json-tool';

interface Row {
    id: string;
    slot: Record<string, unknown>;
    plan: StructuredCallPlan;
    protocol: WireProtocol;
    channel: StructuredChannel;
}

/** The first production shape whose stored fields include all of `want`. A
 *  row names a config that exists, never one written for the test. */
function pick(want: Record<string, unknown>): Record<string, unknown> {
    const hit = (PROD_SHAPES as Record<string, unknown>[]).find((s) =>
        Object.entries(want).every(([k, v]) => s[k] === v),
    );
    if (!hit) {
        throw new Error(`no production shape matches ${JSON.stringify(want)}`);
    }
    const { orgs: _orgs, ...slot } = hit;
    return slot;
}

const ROWS: Row[] = [
    // ── OpenAI-chat wire, response_format ──────────────────────────────────
    {
        id: 'openai_compatible / DeepSeek (api.deepseek.com) — json_object',
        slot: pick({
            provider: 'openai_compatible',
            model: 'deepseek-chat',
            baseURL: 'https://api.deepseek.com/v1',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_object',
    },
    {
        id: 'openai_compatible / MiniMax M2.5 (inline <think>) — json_object',
        slot: pick({
            provider: 'openai_compatible',
            model: 'MiniMax-M2.5',
            baseURL: 'https://api.minimaxi.com/v1',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_object',
    },
    {
        id: 'openai_compatible / GLM (api.z.ai coding) — json_object',
        slot: pick({
            provider: 'openai_compatible',
            model: 'glm-5.3',
            baseURL: 'https://api.z.ai/api/coding/paas/v4',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_object',
    },
    {
        id: 'openai_compatible / Kimi k2.6 (api.moonshot.ai) — json_schema',
        slot: pick({
            provider: 'openai_compatible',
            model: 'kimi-k2.6',
            baseURL: 'https://api.moonshot.ai/v1',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_schema',
    },
    {
        id: 'openai_compatible / DeepSeek on Fireworks — json_schema',
        slot: pick({
            provider: 'openai_compatible',
            model: 'accounts/fireworks/models/deepseek-v4p1-flash',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_schema',
    },
    {
        id: 'open_router / DeepSeek — json_object',
        slot: pick({
            provider: 'open_router',
            model: '~deepseek/deepseek-flash-latest',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_object',
    },
    {
        id: 'open_router / anthropic/claude-sonnet-4.6 — json_schema',
        slot: pick({
            provider: 'open_router',
            model: 'anthropic/claude-sonnet-4.6',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_schema',
    },
    {
        id: 'novita / DeepSeek — json_object',
        slot: pick({ provider: 'novita', model: 'deepseek/deepseek-v4-flash' }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_object',
    },
    {
        id: 'kodus / DeepSeek on Fireworks — json_schema',
        slot: pick({
            provider: 'kodus',
            model: 'fireworks/accounts/fireworks/models/deepseek-v4p1-flash',
        }),
        plan: 'as-is',
        protocol: 'openai-chat',
        channel: 'response_format:json_schema',
    },
    // ── OpenAI Responses wire ──────────────────────────────────────────────
    {
        id: 'openai / gpt-5 — Responses text.format json_schema',
        slot: pick({ provider: 'openai', model: 'gpt-5' }),
        plan: 'as-is',
        protocol: 'openai-responses',
        channel: 'text.format:json_schema',
    },
    {
        // No Azure slot is stored in production; this one is the smallest
        // config the module builds from.
        id: 'azure / gpt-5 (synthesized: no Azure slot in production) — Responses json_schema',
        slot: {
            provider: 'azure',
            model: 'gpt-5',
            baseURL: 'https://matrix.openai.azure.com',
        },
        plan: 'as-is',
        protocol: 'openai-responses',
        channel: 'text.format:json_schema',
    },
    // ── Gemini wire ────────────────────────────────────────────────────────
    {
        id: 'google_gemini / gemini-2.5-flash — responseSchema',
        slot: pick({ provider: 'google_gemini', model: 'gemini-2.5-flash' }),
        plan: 'as-is',
        protocol: 'gemini-generate',
        channel: 'responseSchema',
    },
    // ── Anthropic Messages wire ────────────────────────────────────────────
    {
        id: 'anthropic / claude-haiku-4-5 — output_config.format',
        slot: pick({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
        plan: 'suppress-thinking',
        protocol: 'anthropic-messages',
        channel: 'output_config.format',
    },
    {
        id: 'anthropic / "Claude Opus 4.8" — forced json tool',
        slot: pick({ provider: 'anthropic', model: 'Claude Opus 4.8' }),
        plan: 'suppress-thinking',
        protocol: 'anthropic-messages',
        channel: 'json-tool',
    },
    {
        id: 'anthropic / claude-sonnet-5-5 — reroute-json',
        slot: pick({ provider: 'anthropic', model: 'claude-sonnet-5-5' }),
        plan: 'reroute-json',
        protocol: 'anthropic-messages',
        channel: 'text',
    },
    {
        id: 'anthropic_compatible / MiniMax-M3 (api.minimax.io) — reroute-json',
        slot: pick({
            provider: 'anthropic_compatible',
            model: 'MiniMax-M3',
            baseURL: 'https://api.minimax.io/anthropic',
        }),
        plan: 'reroute-json',
        protocol: 'anthropic-messages',
        channel: 'text',
    },
    {
        id: 'anthropic_compatible / GLM-5.3 (api.z.ai) — reroute-json',
        slot: pick({
            provider: 'anthropic_compatible',
            model: 'glm-5.3',
            baseURL: 'https://api.z.ai/api/anthropic',
        }),
        plan: 'reroute-json',
        protocol: 'anthropic-messages',
        channel: 'text',
    },
    {
        id: 'anthropic_compatible / DeepSeek (api.deepseek.com) — forced json tool',
        slot: pick({
            provider: 'anthropic_compatible',
            model: 'deepseek-v4-pro',
        }),
        plan: 'as-is',
        protocol: 'anthropic-messages',
        channel: 'json-tool',
    },
    {
        id: 'anthropic_compatible / Kimi k2.6 (api.kimi.com) — forced json tool',
        slot: pick({ provider: 'anthropic_compatible', model: 'kimi-k2.6' }),
        plan: 'suppress-thinking',
        protocol: 'anthropic-messages',
        channel: 'json-tool',
    },
    {
        id: 'anthropic_compatible / claude-opus-5 (proxy) — output_config.format',
        slot: pick({
            provider: 'anthropic_compatible',
            model: 'claude-opus-5',
        }),
        plan: 'suppress-thinking',
        protocol: 'anthropic-messages',
        channel: 'output_config.format',
    },
    {
        id: 'moonshot / kimi-k2.6 — forced json tool',
        slot: pick({ provider: 'moonshot', model: 'kimi-k2.6' }),
        plan: 'suppress-thinking',
        protocol: 'anthropic-messages',
        channel: 'json-tool',
    },
    {
        id: 'moonshot / kimi-k3.1-pro — reroute-json',
        slot: pick({ provider: 'moonshot', model: 'kimi-k3.1-pro' }),
        plan: 'reroute-json',
        protocol: 'anthropic-messages',
        channel: 'text',
    },
    {
        id: 'zai / glm-5.3 — reroute-json',
        slot: pick({ provider: 'zai', model: 'glm-5.3' }),
        plan: 'reroute-json',
        protocol: 'anthropic-messages',
        channel: 'text',
    },
    // ── Bedrock Converse wire ──────────────────────────────────────────────
    {
        id: 'amazon_bedrock / minimax.minimax-m2.5 — forced json tool',
        slot: pick({
            provider: 'amazon_bedrock',
            model: 'minimax.minimax-m2.5',
        }),
        plan: 'as-is',
        protocol: 'bedrock-converse',
        channel: 'json-tool',
    },
    {
        id: 'amazon_bedrock / claude-haiku-4-5 — output_config.format',
        slot: pick({
            provider: 'amazon_bedrock',
            model: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        }),
        plan: 'suppress-thinking',
        protocol: 'bedrock-converse',
        channel: 'output_config.format',
    },
    {
        id: 'amazon_bedrock / claude-sonnet-5 — reroute-json',
        slot: pick({
            provider: 'amazon_bedrock',
            model: 'anthropic.claude-sonnet-5',
        }),
        plan: 'reroute-json',
        protocol: 'bedrock-converse',
        channel: 'text',
    },
];

/** Registered ids this file cannot drive, and why. */
const EXCLUDED_PROVIDERS: Record<string, string> = {
    // Its build needs a real service-account JSON; with a placeholder it
    // falls through to the Gemini API client, so a row would describe that
    // client, not Vertex (same exclusion as byok-config-matrix.spec.ts).
    google_vertex:
        'needs a real service account; the placeholder build is another client',
};

function routeOf(row: Pick<Row, 'plan' | 'protocol' | 'channel'>): Route {
    if (row.plan === 'reroute-json') return 'reroute-json';
    if (row.channel === 'json-tool') {
        return row.protocol === 'bedrock-converse'
            ? 'bedrock-json-tool'
            : 'anthropic-json-tool';
    }
    return 'text-parse';
}

// ─── the door ───────────────────────────────────────────────────────────────

/** `LLM.run` with a schema — the door every structured review call uses. */
function structuredCall(slot: Record<string, unknown>) {
    return LLM.run({
        byokConfig: { ...slot, apiKey: 'k' } as unknown as NormalizedModel,
        system: 'You review code against the rules.',
        user: 'Check the diff.',
        schema: SCHEMA,
        runName: 'structured-output-recovery-matrix',
    } as any) as unknown as Promise<Answer>;
}

/** First request answers with `first`; any later one (the re-ask) with a
 *  clean REASKED in whatever form that request asked for. */
function scripted(first: ModelReply | ((req: CapturedRequest) => ModelReply)) {
    return (req: CapturedRequest, i: number): ModelReply =>
        i > 0
            ? cleanReplyFor(req, REASKED)
            : typeof first === 'function'
              ? first(req)
              : first;
}

function gatePlan(slot: Record<string, unknown>): StructuredCallPlan {
    const mod = REGISTRY.get(slot.provider as string);
    return planStructuredCall(
        mod.capabilities(slot.model as string).structuredOutput,
        mod.reasoningTraits?.(slot as any) ?? NON_REASONING_TRAITS,
    );
}

/** What the caller of `LLM.run` sees, and what it cost upstream. */
type Seen =
    | { kind: 'answer'; value: Answer }
    | { kind: 'reask' }
    | { kind: 'throws'; error: RegExp };

const REROUTE_FAILED = /reroute-json produced no valid object/;
const NO_OUTPUT = /No output generated/;

/** The route turns what `repairAndValidate` makes of a text into what the
 *  caller sees. */
function seenFor(route: Route, shape: Pick<Shape, 'reply' | 'outcome'>): Seen {
    if (route === 'anthropic-json-tool') {
        // @ai-sdk/anthropic drops every text block while it forces the json
        // tool: the text never reaches the executor. An empty text fails to
        // parse (→ re-ask); an empty text cut off on the token limit is not
        // parsed at all (→ NoOutputGeneratedError, below).
        return shape.reply.cutOff
            ? { kind: 'throws', error: NO_OUTPUT }
            : { kind: 'reask' };
    }
    if (shape.outcome.kind === 'answer') return shape.outcome;
    // reroute-json re-asks through the reroute itself, except a reply the
    // token limit cut off: a re-ask would run into the same limit.
    return route === 'reroute-json' && shape.reply.cutOff
        ? { kind: 'throws', error: REROUTE_FAILED }
        : { kind: 'reask' };
}

function titleOf(seen: Seen): string {
    switch (seen.kind) {
        case 'answer':
            return 'the caller gets the answer from ONE request';
        case 'reask':
            return 'one re-ask: the caller gets the SECOND answer, TWO requests';
        case 'throws':
            return `the call throws ${seen.error} after ONE request, no re-ask`;
    }
}

function expectSeen(run: StubbedRun<Answer>, seen: Seen) {
    switch (seen.kind) {
        case 'answer':
            expect(run.error).toBeUndefined();
            expect(run.result).toEqual(seen.value);
            expect(run.requests).toHaveLength(1);
            return;
        case 'reask':
            expect(run.error).toBeUndefined();
            expect(run.result).toEqual(REASKED);
            expect(run.requests).toHaveLength(2);
            return;
        case 'throws':
            expect(String((run.error as Error)?.message)).toMatch(seen.error);
            expect(run.requests).toHaveLength(1);
            return;
    }
}

const PLATFORM_KEY = 'API_KODUS_PROVIDER_FIREWORKS_API_KEY';
const previousPlatformKey = process.env[PLATFORM_KEY];
beforeAll(() => {
    // A `kodus` slot reads Kodus's platform key from env at build time.
    process.env[PLATFORM_KEY] ??= 'k';
});
afterAll(() => {
    if (previousPlatformKey === undefined) delete process.env[PLATFORM_KEY];
    else process.env[PLATFORM_KEY] = previousPlatformKey;
});

// ─── the matrix ─────────────────────────────────────────────────────────────

describe.each(ROWS)('$id', (row) => {
    const route = routeOf(row);

    it(`the gate gives it ${row.plan} over ${row.protocol} / ${row.channel} (route: ${route})`, async () => {
        expect(gatePlan(row.slot)).toBe(row.plan);
        const run = await withStubbedModel(
            (req) => cleanReplyFor(req, FINDINGS),
            () => structuredCall(row.slot),
        );
        expect(run.error).toBeUndefined();
        expect(run.requests).toHaveLength(1);
        const [req] = run.requests;
        expect({ protocol: req.protocol, channel: channelOf(req) }).toEqual({
            protocol: row.protocol,
            channel: row.channel,
        });
        expect(run.result).toEqual(FINDINGS);
    });

    describe.each(SHAPES)('text shape $id', (shape) => {
        const seen = seenFor(route, shape);
        it(
            titleOf(seen),
            async () => {
                const run = await withStubbedModel(scripted(shape.reply), () =>
                    structuredCall(row.slot),
                );
                if (shape.maxMs !== undefined) {
                    expect(run.ms).toBeLessThan(shape.maxMs);
                }
                expectSeen(run, seen);
            },
            30_000,
        );
    });

    // ── what the provider's OWN channels can carry ─────────────────────────

    it('a schema-invalid object in the structured channel is never accepted', async () => {
        // Valid JSON of the wrong type: the SDK's TypeValidationError is not a
        // parse error, so the salvage declines and the schema-mismatch re-ask
        // runs. reroute-json validates the text itself and re-asks once too.
        const invalid = { violations: [{ body: 'bug', line: '12' }] };
        const run = await withStubbedModel(
            scripted((req) =>
                channelOf(req) === 'json-tool'
                    ? { toolInput: invalid }
                    : { text: JSON.stringify(invalid) },
            ),
            () => structuredCall(row.slot),
        );
        expectSeen(run, { kind: 'reask' });
    });

    it('an example object in the reasoning channel never becomes the answer', async () => {
        const run = await withStubbedModel(
            (req) => ({
                ...cleanReplyFor(req, FINDINGS),
                reasoning:
                    'If nothing is wrong I would return {"violations":[]}.',
            }),
            () => structuredCall(row.slot),
        );
        expectSeen(run, { kind: 'answer', value: FINDINGS });
    });

    it('the token limit spent before any answer text is thrown, never re-asked', async () => {
        // finish = length with an empty text: the SDK skips the parse and
        // `result.output` throws NoOutputGeneratedError — not
        // NoObjectGeneratedError — so neither the salvage nor the re-ask runs.
        // reroute-json reads `r.text` itself and fails its own way.
        const run = await withStubbedModel(
            scripted({
                text: '',
                reasoning: 'Thinking: {"violations":[]} if clean, but',
                cutOff: true,
            }),
            () => structuredCall(row.slot),
        );
        expectSeen(run, {
            kind: 'throws',
            error: route === 'reroute-json' ? REROUTE_FAILED : NO_OUTPUT,
        });
    });

    if (row.channel === 'json-tool') {
        it('prose before the forced tool call does not displace the tool answer', async () => {
            // Bedrock keeps the text and joins it to the tool input
            // (`I will … now.{"violations":…}`): JSON.parse fails and
            // repairAndValidate recovers the object. Anthropic drops the text.
            const run = await withStubbedModel(
                () => ({
                    text: 'I will report the findings now.',
                    toolInput: FINDINGS,
                }),
                () => structuredCall(row.slot),
            );
            expectSeen(run, { kind: 'answer', value: FINDINGS });
        });

        it('a schema-valid example in the prose before the forced tool call never replaces the tool answer', async () => {
            // Bedrock emits the json tool's input as one more text part after
            // the model's own text: the prose example came first and shipped
            // as an empty review.
            const run = await withStubbedModel(
                () => ({
                    text: 'If nothing is wrong I would return {"violations":[]}.',
                    toolInput: FINDINGS,
                }),
                () => structuredCall(row.slot),
            );
            expectSeen(run, { kind: 'answer', value: FINDINGS });
        });
    }
});

// ─── coverage: the table must keep up with the registry and the corpus ─────

describe('coverage', () => {
    it('every registered provider is driven by a row or excluded with a reason', () => {
        const driven = new Set(ROWS.map((r) => r.slot.provider as string));
        const missing = REGISTRY.ids().filter(
            (id) => !driven.has(id) && !(id in EXCLUDED_PROVIDERS),
        );
        expect(missing).toEqual([]);
    });

    it('every production provider × plan × wire channel has a row', async () => {
        const key = (
            r: Pick<Row, 'plan' | 'protocol' | 'channel'>,
            p: string,
        ) => `${p} | ${r.plan} | ${r.protocol} / ${r.channel}`;
        const covered = new Set(
            ROWS.map((r) => key(r, r.slot.provider as string)),
        );
        const uncovered = new Map<string, string>();
        const failed: string[] = [];
        for (const shape of PROD_SHAPES as Record<string, unknown>[]) {
            const { orgs: _orgs, ...slot } = shape;
            const provider = slot.provider as string;
            if (provider in EXCLUDED_PROVIDERS) continue;
            const run = await withStubbedModel(
                (req) => cleanReplyFor(req, FINDINGS),
                () => structuredCall(slot),
            );
            const req = run.requests[0];
            if (!req || run.error !== undefined) {
                failed.push(`${provider} / ${slot.model}`);
                continue;
            }
            const k = key(
                {
                    plan: gatePlan(slot),
                    protocol: req.protocol,
                    channel: channelOf(req),
                },
                provider,
            );
            if (!covered.has(k)) uncovered.set(k, String(slot.model));
        }
        expect(failed).toEqual([]);
        expect(Object.fromEntries(uncovered)).toEqual({});
    }, 300_000);
});
