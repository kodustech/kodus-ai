import { z } from 'zod';
import { parseStrictJson } from '@libs/runtime/protocol/strict-json';

// Data contract only. No transport, model resolution, execution, redaction,
// canary detection, authorization or budget enforcement is performed here.
export const MODEL_TURN_LIMITS = {
    requestBytes: 2_000_000,
    responseBytes: 1_000_000,
    depth: 32,
    nodes: 20_000,
    frames: 200,
    parts: 64,
    tools: 6,
    toolCalls: 16,
    text: 400_000,
    arguments: 131_072,
} as const;

export const MODEL_TURN_TOOL_NAMES = [
    'list_files',
    'read_file',
    'search_code',
    'exec_on_base',
    'browser_explore',
    'submit_plan',
] as const;
const toolName = z.enum(MODEL_TURN_TOOL_NAMES);
const id = z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\u0000-\u001f\u007f]+$/);
const text = z.string().max(MODEL_TURN_LIMITS.text);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({
    runId: z.uuid(),
    attempt: z.number().int().positive(),
    turnId: z.uuid(),
});

/** Known text/tools metadata only. Unknown provider namespaces/fields fail closed. */
const metadata = z.strictObject({
    // Responses continuation state is per-content, unlike generation diagnostics.
    openai: z
        .strictObject({
            itemId: z.string().max(128).nullable().optional(),
            reasoningEncryptedContent: z
                .string()
                .max(65_536)
                .nullable()
                .optional(),
            phase: z.enum(['commentary', 'final_answer']).nullable().optional(),
        })
        .optional(),
    anthropic: z
        .strictObject({
            signature: z.string().max(65_536).optional(),
            redactedData: z.string().max(65_536).optional(),
            cacheControl: z
                .strictObject({
                    type: z.literal('ephemeral'),
                    ttl: z.enum(['5m', '1h']).optional(),
                })
                .optional(),
        })
        .optional(),
    google: z
        .strictObject({ thoughtSignature: z.string().max(65_536).optional() })
        .optional(),
    // The installed Vertex adapter preserves both its current and legacy namespace.
    googleVertex: z
        .strictObject({ thoughtSignature: z.string().max(65_536).optional() })
        .optional(),
    vertex: z
        .strictObject({ thoughtSignature: z.string().max(65_536).optional() })
        .optional(),
});
const promptText = z.strictObject({
    type: z.literal('text'),
    text,
    providerOptions: metadata.optional(),
});
const promptReasoning = z.strictObject({
    type: z.literal('reasoning'),
    text,
    providerOptions: metadata.optional(),
});
const promptCall = z.strictObject({
    type: z.literal('tool-call'),
    toolCallId: id,
    toolName,
    input: z.json(),
    providerOptions: metadata.optional(),
});
const toolOutput = z.union([
    z.strictObject({ type: z.enum(['text', 'error-text']), value: text }),
    z.strictObject({ type: z.enum(['json', 'error-json']), value: z.json() }),
    z.strictObject({
        type: z.literal('execution-denied'),
        reason: text.optional(),
    }),
]);
const promptResult = z.strictObject({
    type: z.literal('tool-result'),
    toolCallId: id,
    toolName,
    output: toolOutput,
    providerOptions: metadata.optional(),
});
const frameSchema = z.union([
    z.strictObject({
        role: z.literal('system'),
        content: text,
        providerOptions: metadata.optional(),
    }),
    z.strictObject({
        role: z.literal('user'),
        content: z.array(promptText).min(1).max(MODEL_TURN_LIMITS.parts),
        providerOptions: metadata.optional(),
    }),
    z.strictObject({
        role: z.literal('assistant'),
        content: z
            .array(z.union([promptText, promptReasoning, promptCall]))
            .min(1)
            .max(MODEL_TURN_LIMITS.parts),
        providerOptions: metadata.optional(),
    }),
    z.strictObject({
        role: z.literal('tool'),
        content: z.array(promptResult).min(1).max(MODEL_TURN_LIMITS.parts),
        providerOptions: metadata.optional(),
    }),
]);
const declaration = z.strictObject({
    type: z.literal('function'),
    name: toolName,
    description: z.string().max(8_192).optional(),
    inputSchema: z
        .record(z.string(), z.json())
        .refine((schema) => schema.type === 'object'),
    strict: z.boolean().optional(),
});
const choice = z.union([
    z.strictObject({ type: z.enum(['auto', 'none', 'required']) }),
    z.strictObject({ type: z.literal('tool'), toolName }),
]);
export const ModelTurnRequestSchema = z.strictObject({
    v: z.literal(1),
    scope: scopeSchema,
    task: z.literal('runtime.plan'),
    toolset: z.literal('runtime-planner-v1'),
    call: z.strictObject({
        prompt: z.array(frameSchema).min(1).max(MODEL_TURN_LIMITS.frames),
        tools: z.array(declaration).max(MODEL_TURN_LIMITS.tools),
        toolChoice: choice.optional(),
        maxOutputTokens: z.number().int().min(1).max(64_000).optional(),
        temperature: z.number().min(0).max(2).optional(),
    }),
});
const generatedText = z.strictObject({
    type: z.literal('text'),
    text,
    providerMetadata: metadata.optional(),
});
const generatedReasoning = z.strictObject({
    type: z.literal('reasoning'),
    text,
    providerMetadata: metadata.optional(),
});
const generatedCall = z.strictObject({
    type: z.literal('tool-call'),
    toolCallId: id,
    toolName,
    input: z.string().max(MODEL_TURN_LIMITS.arguments),
    providerExecuted: z.literal(false).optional(),
    providerMetadata: metadata.optional(),
});
const usageSchema = z.discriminatedUnion('reported', [
    z
        .strictObject({
            reported: z.literal(true),
            inputTokens: z.strictObject({
                total: count.optional(),
                noCache: count.optional(),
                cacheRead: count.optional(),
                cacheWrite: count.optional(),
            }),
            outputTokens: z.strictObject({
                total: count.optional(),
                text: count.optional(),
                reasoning: count.optional(),
            }),
        })
        .refine(
            (usage) =>
                Object.keys(usage.inputTokens).length +
                    Object.keys(usage.outputTokens).length >
                0,
        ),
    z.strictObject({ reported: z.literal(false) }),
]);
const warningSchema = z.union([
    z.strictObject({
        type: z.enum(['unsupported', 'compatibility']),
        feature: z.string().max(512),
        details: text.optional(),
    }),
    z.strictObject({
        type: z.literal('deprecated'),
        setting: z.string().max(512),
        message: text,
    }),
    z.strictObject({ type: z.literal('other'), message: text }),
]);
export const ModelTurnResponseSchema = z.strictObject({
    v: z.literal(1),
    scope: scopeSchema,
    generation: z.strictObject({
        content: z
            .array(z.union([generatedText, generatedReasoning, generatedCall]))
            .max(MODEL_TURN_LIMITS.parts),
        finishReason: z.strictObject({
            unified: z.enum([
                'stop',
                'length',
                'content-filter',
                'tool-calls',
                'error',
                'other',
            ]),
            raw: z.string().max(512).optional(),
        }),
        usage: usageSchema,
        warnings: z.array(warningSchema).max(32),
        providerMetadata: metadata.optional(),
    }),
    budget: z.strictObject({
        remainingTokens: count,
        usageBasis: z.enum(['provider_reported', 'reservation']),
        /** Some raw attempts did not report complete usage; measured counters remain partial. */
        additionalUsageUnknown: z.literal(true).optional(),
    }),
});
export type ModelTurnRequest = z.infer<typeof ModelTurnRequestSchema>;
export type ModelTurnResponse = z.infer<typeof ModelTurnResponseSchema>;
export type ModelTurnScope = ModelTurnRequest['scope'];

export class ModelTurnValidationError extends Error {
    constructor(
        readonly code:
            'invalid_frame' | 'too_large' | 'too_deep' | 'too_many_nodes',
    ) {
        super(`Model turn refused (${code})`);
        this.name = 'ModelTurnValidationError';
    }
}
const refuse = (): never => {
    throw new ModelTurnValidationError('invalid_frame');
};

/** Inspect descriptors before JSON/Zod: no getters, toJSON, cycles or exotic objects. */
function boundedJson(
    input: unknown,
    maxBytes: number,
    sdkOptionalFields = false,
): unknown {
    let value = input;
    if (typeof value === 'string') {
        if (Buffer.byteLength(value, 'utf8') > maxBytes)
            throw new ModelTurnValidationError('too_large');
        try {
            value = parseStrictJson(value, MODEL_TURN_LIMITS.depth);
        } catch {
            return refuse();
        }
    }
    let nodes = 0,
        encodedBytes = 0;
    const addBytes = (bytes: number) => {
        encodedBytes += bytes;
        if (encodedBytes > maxBytes)
            throw new ModelTurnValidationError('too_large');
    };
    const addStringBytes = (part: string) => {
        addBytes(2); // JSON quotes.
        for (let i = 0; i < part.length; i++) {
            const ch = part.charCodeAt(i);
            if (
                ch === 34 ||
                ch === 92 ||
                ch === 8 ||
                ch === 9 ||
                ch === 10 ||
                ch === 12 ||
                ch === 13
            )
                addBytes(2);
            else if (ch < 32) addBytes(6);
            else if (ch < 128) addBytes(1);
            else if (ch < 2048) addBytes(2);
            else if (
                ch >= 0xd800 &&
                ch <= 0xdbff &&
                part.charCodeAt(i + 1) >= 0xdc00 &&
                part.charCodeAt(i + 1) <= 0xdfff
            ) {
                addBytes(4);
                i++;
            } else if (ch >= 0xd800 && ch <= 0xdfff)
                addBytes(6); // JSON escapes lone surrogates.
            else addBytes(3);
        }
    };
    const active = new WeakSet<object>();
    const visit = (part: unknown, depth: number): void => {
        if (++nodes > MODEL_TURN_LIMITS.nodes)
            throw new ModelTurnValidationError('too_many_nodes');
        if (depth > MODEL_TURN_LIMITS.depth)
            throw new ModelTurnValidationError('too_deep');
        if (typeof part === 'string') {
            addStringBytes(part);
            return;
        }
        if (part === null) {
            addBytes(4);
            return;
        }
        if (typeof part === 'boolean') {
            addBytes(part ? 4 : 5);
            return;
        }
        if (typeof part === 'number' && Number.isFinite(part)) {
            addBytes(JSON.stringify(part).length);
            return;
        }
        if (typeof part !== 'object' || !part || active.has(part))
            return refuse();
        const array = Array.isArray(part);
        const prototype = Object.getPrototypeOf(part);
        if (
            prototype !== (array ? Array.prototype : Object.prototype) &&
            !(prototype === null && !array)
        )
            return refuse();
        if (
            array &&
            Object.getOwnPropertyDescriptor(part, 'length')!.value >
                MODEL_TURN_LIMITS.nodes - nodes
        ) {
            throw new ModelTurnValidationError('too_many_nodes');
        }
        if (Object.getOwnPropertySymbols(part).length) return refuse();
        const keys = Object.getOwnPropertyNames(part).filter(
            (key) => !(array && key === 'length'),
        );
        if (
            array &&
            keys.length !==
                Object.getOwnPropertyDescriptor(part, 'length')!.value
        )
            return refuse();
        addBytes(2 + Math.max(0, keys.length - 1)); // Braces/brackets and commas.
        active.add(part);
        for (const key of keys) {
            const d = Object.getOwnPropertyDescriptor(part, key)!;
            if (
                key === '__proto__' ||
                !d.enumerable ||
                !('value' in d) ||
                (array && !/^(0|[1-9]\d*)$/.test(key))
            )
                return refuse();
            if (sdkOptionalFields && !array && d.value === undefined) continue;
            if (!array) {
                addStringBytes(key);
                addBytes(1);
            }
            visit(d.value, depth + 1);
        }
        active.delete(part);
    };
    try {
        visit(value, 0);
        if (Buffer.byteLength(JSON.stringify(value), 'utf8') > maxBytes)
            throw new ModelTurnValidationError('too_large');
        return value;
    } catch (e) {
        if (e instanceof ModelTurnValidationError) throw e;
        return refuse();
    }
}

/** SDK-native optional fields may be undefined; JSON omits them, after the same bounds/descriptor checks. */
export function modelTurnSdkJson(input: unknown): unknown {
    return JSON.parse(
        JSON.stringify(
            boundedJson(input, MODEL_TURN_LIMITS.requestBytes, true),
        ),
    );
}

function historyCalls(req: ModelTurnRequest): Set<string> {
    const seen = new Set<string>(),
        pending = new Map<string, string>();
    for (const [i, frame] of req.call.prompt.entries()) {
        if (frame.role === 'system' && i !== 0) return refuse();
        if (frame.role !== 'tool' && pending.size) return refuse();
        if (frame.role === 'assistant') {
            const calls = frame.content.filter(
                (part) => part.type === 'tool-call',
            );
            if (calls.length > MODEL_TURN_LIMITS.toolCalls) return refuse();
            for (const part of calls) {
                if (seen.has(part.toolCallId)) return refuse();
                seen.add(part.toolCallId);
                pending.set(part.toolCallId, part.toolName);
            }
        } else if (frame.role === 'tool') {
            for (const part of frame.content) {
                if (pending.get(part.toolCallId) !== part.toolName)
                    return refuse();
                pending.delete(part.toolCallId);
            }
        }
    }
    if (pending.size) return refuse();
    return seen;
}

/** Bounds and correlation are part of the parser; using the shape schema alone is insufficient. */
export function parseModelTurnRequest(input: unknown): ModelTurnRequest {
    const parsed = ModelTurnRequestSchema.safeParse(
        boundedJson(input, MODEL_TURN_LIMITS.requestBytes),
    );
    if (!parsed.success) return refuse();
    const request = parsed.data;
    const names = new Set(request.call.tools.map((tool) => tool.name));
    if (names.size !== request.call.tools.length) return refuse();
    const toolChoice = request.call.toolChoice;
    if (
        (toolChoice?.type === 'tool' && !names.has(toolChoice.toolName)) ||
        (toolChoice?.type === 'required' && !names.size)
    )
        return refuse();
    historyCalls(request);
    return request;
}

export function parseModelTurnResponse(
    input: unknown,
    rawRequest: unknown,
): ModelTurnResponse {
    const request = parseModelTurnRequest(rawRequest);
    const parsed = ModelTurnResponseSchema.safeParse(
        boundedJson(input, MODEL_TURN_LIMITS.responseBytes),
    );
    if (!parsed.success) return refuse();
    const response = parsed.data;
    if (
        response.scope.runId !== request.scope.runId ||
        response.scope.attempt !== request.scope.attempt ||
        response.scope.turnId !== request.scope.turnId
    )
        return refuse();
    const usage = response.generation.usage;
    const completeUsage =
        usage.reported &&
        usage.inputTokens.total !== undefined &&
        usage.outputTokens.total !== undefined;
    if (
        (response.budget.usageBasis === 'provider_reported' &&
            (!completeUsage || response.budget.additionalUsageUnknown)) ||
        (response.budget.usageBasis === 'reservation' &&
            completeUsage &&
            !response.budget.additionalUsageUnknown)
    )
        return refuse();
    const seen = historyCalls(request),
        names = new Set(request.call.tools.map((tool) => tool.name));
    const calls = response.generation.content.filter(
        (part) => part.type === 'tool-call',
    );
    if (calls.length > MODEL_TURN_LIMITS.toolCalls) return refuse();
    for (const part of calls) {
        if (seen.has(part.toolCallId) || !names.has(part.toolName))
            return refuse();
        seen.add(part.toolCallId);
        let args: unknown;
        try {
            args = parseStrictJson(part.input, MODEL_TURN_LIMITS.depth);
        } catch {
            return refuse();
        }
        if (!args || typeof args !== 'object' || Array.isArray(args))
            return refuse();
        boundedJson(args, MODEL_TURN_LIMITS.arguments);
    }
    return response;
}
