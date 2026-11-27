/**
 * Provider-shaped replies for `structured-output-recovery-matrix.spec.ts`.
 *
 * The matrix asks what the CALLER gets back when a model's answer arrives in a
 * given shape, so the answer has to reach the structured executor the way it
 * does in production: inside the provider's own response body, parsed by the
 * provider's own AI SDK package. This module owns the five wire formats the
 * registry speaks and nothing else — no provider module is mocked, only
 * `globalThis.fetch` (the same seam as `testing/byok-wire.ts`, which covers
 * every provider, including the ones that do not take a `fetch` option).
 *
 * Never touches the network: every request is answered from here.
 */

export type WireProtocol =
    | 'openai-chat'
    | 'openai-responses'
    | 'anthropic-messages'
    | 'gemini-generate'
    | 'bedrock-converse';

/** How the request asked for structured output — read off the body, so a row
 *  states what really went on the wire, not what a capability table claims. */
export type StructuredChannel =
    | 'response_format:json_schema'
    | 'response_format:json_object'
    | 'text.format:json_schema'
    | 'text.format:json_object'
    | 'output_config.format'
    | 'json-tool'
    | 'responseSchema'
    | 'text';

export interface CapturedRequest {
    url: string;
    protocol: WireProtocol;
    body: any;
}

/** One model reply. `text` is the assistant text block; `reasoning` rides the
 *  protocol's own reasoning channel (never the text); `toolInput` is the
 *  forced json tool's input; `cutOff` ends the reply on the token limit. */
export interface ModelReply {
    text?: string;
    reasoning?: string;
    toolInput?: unknown;
    cutOff?: boolean;
}

export function protocolOf(url: string): WireProtocol | undefined {
    if (/\/converse(\?|$)/.test(url)) return 'bedrock-converse';
    if (/:generateContent(\?|$)/.test(url)) return 'gemini-generate';
    if (/\/messages(\?|$)/.test(url)) return 'anthropic-messages';
    if (/\/responses(\?|$)/.test(url)) return 'openai-responses';
    if (/\/chat\/completions(\?|$)/.test(url)) return 'openai-chat';
    return undefined;
}

function hasJsonTool(tools: unknown, nameOf: (t: any) => unknown): boolean {
    return Array.isArray(tools) && tools.some((t) => nameOf(t) === 'json');
}

export function channelOf(req: CapturedRequest): StructuredChannel {
    const b = req.body ?? {};
    switch (req.protocol) {
        case 'openai-chat':
            if (b.response_format?.type === 'json_schema') {
                return 'response_format:json_schema';
            }
            if (b.response_format?.type === 'json_object') {
                return 'response_format:json_object';
            }
            return 'text';
        case 'openai-responses':
            if (b.text?.format?.type === 'json_schema') {
                return 'text.format:json_schema';
            }
            if (b.text?.format?.type === 'json_object') {
                return 'text.format:json_object';
            }
            return 'text';
        case 'anthropic-messages':
            if (b.output_config?.format) return 'output_config.format';
            if (hasJsonTool(b.tools, (t) => t?.name)) return 'json-tool';
            return 'text';
        case 'gemini-generate':
            return b.generationConfig?.responseSchema ||
                b.generationConfig?.responseJsonSchema
                ? 'responseSchema'
                : 'text';
        case 'bedrock-converse':
            if (b.additionalModelRequestFields?.output_config?.format) {
                return 'output_config.format';
            }
            if (hasJsonTool(b.toolConfig?.tools, (t) => t?.toolSpec?.name)) {
                return 'json-tool';
            }
            return 'text';
    }
}

/** A clean answer in the form the request asked for: the forced tool's input
 *  when it forced one, otherwise the JSON as text. */
export function cleanReplyFor(
    req: CapturedRequest,
    value: unknown,
): ModelReply {
    return channelOf(req) === 'json-tool'
        ? { toolInput: value }
        : { text: JSON.stringify(value) };
}

const USAGE_CHAT = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

/** The provider's response body carrying `reply`, as its SDK expects it. */
export function wireBody(protocol: WireProtocol, reply: ModelReply): unknown {
    const { text, reasoning, toolInput, cutOff } = reply;
    switch (protocol) {
        case 'openai-chat':
            return {
                id: 'chatcmpl-matrix',
                object: 'chat.completion',
                created: 0,
                model: 'matrix',
                choices: [
                    {
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: text ?? null,
                            // DeepSeek / Kimi / GLM put reasoning here.
                            ...(reasoning
                                ? { reasoning_content: reasoning }
                                : {}),
                        },
                        finish_reason: cutOff ? 'length' : 'stop',
                    },
                ],
                usage: USAGE_CHAT,
            };
        case 'openai-responses':
            return {
                id: 'resp_matrix',
                object: 'response',
                created_at: 0,
                model: 'matrix',
                status: cutOff ? 'incomplete' : 'completed',
                incomplete_details: cutOff
                    ? { reason: 'max_output_tokens' }
                    : null,
                output: [
                    ...(reasoning
                        ? [
                              {
                                  type: 'reasoning',
                                  id: 'rs_matrix',
                                  summary: [
                                      { type: 'summary_text', text: reasoning },
                                  ],
                              },
                          ]
                        : []),
                    {
                        type: 'message',
                        id: 'msg_matrix',
                        role: 'assistant',
                        status: cutOff ? 'incomplete' : 'completed',
                        content: [
                            {
                                type: 'output_text',
                                text: text ?? '',
                                annotations: [],
                            },
                        ],
                    },
                ],
                usage: {
                    input_tokens: 1,
                    output_tokens: 1,
                    total_tokens: 2,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                },
            };
        case 'anthropic-messages':
            return {
                id: 'msg_matrix',
                type: 'message',
                role: 'assistant',
                model: 'matrix',
                content: [
                    ...(reasoning
                        ? [
                              {
                                  type: 'thinking',
                                  thinking: reasoning,
                                  signature: 'sig',
                              },
                          ]
                        : []),
                    ...(text != null ? [{ type: 'text', text }] : []),
                    ...(toolInput !== undefined
                        ? [
                              {
                                  type: 'tool_use',
                                  id: 'toolu_matrix',
                                  name: 'json',
                                  input: toolInput,
                              },
                          ]
                        : []),
                ],
                stop_reason:
                    toolInput !== undefined
                        ? 'tool_use'
                        : cutOff
                          ? 'max_tokens'
                          : 'end_turn',
                stop_sequence: null,
                usage: { input_tokens: 1, output_tokens: 1 },
            };
        case 'gemini-generate':
            return {
                candidates: [
                    {
                        content: {
                            role: 'model',
                            parts: [
                                ...(reasoning
                                    ? [{ text: reasoning, thought: true }]
                                    : []),
                                { text: text ?? '' },
                            ],
                        },
                        finishReason: cutOff ? 'MAX_TOKENS' : 'STOP',
                    },
                ],
                usageMetadata: {
                    promptTokenCount: 1,
                    candidatesTokenCount: 1,
                    totalTokenCount: 2,
                },
            };
        case 'bedrock-converse':
            return {
                output: {
                    message: {
                        role: 'assistant',
                        content: [
                            ...(reasoning
                                ? [
                                      {
                                          reasoningContent: {
                                              reasoningText: {
                                                  text: reasoning,
                                                  signature: 'sig',
                                              },
                                          },
                                      },
                                  ]
                                : []),
                            ...(text != null ? [{ text }] : []),
                            ...(toolInput !== undefined
                                ? [
                                      {
                                          toolUse: {
                                              toolUseId: 'tooluse_matrix',
                                              name: 'json',
                                              input: toolInput,
                                          },
                                      },
                                  ]
                                : []),
                        ],
                    },
                },
                stopReason:
                    toolInput !== undefined
                        ? 'tool_use'
                        : cutOff
                          ? 'max_tokens'
                          : 'end_turn',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                metrics: { latencyMs: 1 },
            };
    }
}

export interface StubbedRun<T> {
    result?: T;
    error?: unknown;
    /** Model calls only, in order (a provider's token fetch is not counted). */
    requests: CapturedRequest[];
    ms: number;
}

/**
 * Run `fn` with `globalThis.fetch` answering every model call from `reply`
 * (called with the request and its 0-based index). Any other URL is refused,
 * so a test can never reach the network.
 */
export async function withStubbedModel<T>(
    reply: (req: CapturedRequest, index: number) => ModelReply,
    fn: () => Promise<T>,
): Promise<StubbedRun<T>> {
    const requests: CapturedRequest[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init: any) => {
        const url =
            typeof input === 'string' ? input : String(input?.url ?? input);
        const protocol = protocolOf(url);
        if (!protocol) {
            return new Response(
                JSON.stringify({ error: `matrix stub: no route for ${url}` }),
                {
                    status: 404,
                    headers: { 'content-type': 'application/json' },
                },
            );
        }
        const req: CapturedRequest = {
            url,
            protocol,
            body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        requests.push(req);
        return new Response(
            JSON.stringify(wireBody(protocol, reply(req, requests.length - 1))),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
    }) as typeof fetch;
    const started = Date.now();
    try {
        const result = await fn();
        return { result, requests, ms: Date.now() - started };
    } catch (error) {
        return { error, requests, ms: Date.now() - started };
    } finally {
        globalThis.fetch = realFetch;
    }
}
