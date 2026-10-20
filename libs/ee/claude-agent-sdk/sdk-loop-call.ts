/**
 * An agent loop on the Claude Agent SDK (#2113): the call `runAgentLoopCall`
 * would have made with `generateText`, run in Claude's own loop instead.
 *
 * The session gets the loop's tools over in-process MCP, no built-in tool, no
 * settings from disk, the harness policies through the director hooks, and a
 * gateway token instead of a key. Each finished step is handed to the runner's
 * `onStepFinish` as the AI SDK step event it already reads; the result is
 * shaped like `generateText`'s (`text`, `steps`, `usage`), so the runner, the
 * span and the failover guard see what they see today.
 */
import { asSchema, type ModelMessage } from 'ai';

import type { SdkCallUsage, SdkLoopCall } from '@libs/llm/sdk-executor-registry';
import { createLogger } from '@libs/core/log/logger';

import { buildDirectorHooks, newDirectorState, type ToolBatchCall } from './director-hooks';
import { apiErrorFromUpstream, ClaudeSdkInfraError } from './errors';
import type { LedgerUsage } from './gateway/ledger';
import { bareName, toMcpServer, type LoopTool } from './mcp-bridge';
import { langfuseRequestObserver } from './observe';
import type { SdkProcessPool, SdkSession } from './process-pool';
import { cliReasoning } from './reasoning';
import { resolveClaudeSdkRoute } from './eligibility';
import type { SdkRuntime } from './sdk-runtime';

const logger = createLogger('ClaudeSdkLoopCall');

/**
 * A8: how our system prompt reaches Claude's loop. Chosen by the eval matrix
 * (T35); until then our prompt goes as the whole system prompt.
 */
export type SystemFraming = 'own' | 'claude-code-preset';
export const SYSTEM_FRAMING: SystemFraming = 'own';

export function systemPromptFor(system: string | undefined, framing: SystemFraming = SYSTEM_FRAMING) {
    if (framing === 'claude-code-preset') return { type: 'preset' as const, preset: 'claude_code' as const, ...(system ? { append: system } : {}) };
    return system ?? '';
}

export interface ClaudeSdkDeps {
    pool: SdkProcessPool;
    runtime: () => SdkRuntime;
    framing?: SystemFraming;
}

export function toAiSdkUsage(u: LedgerUsage): SdkCallUsage {
    return {
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        totalTokens: u.inputTokens + u.outputTokens,
        inputTokenDetails: { noCacheTokens: u.inputTokens - u.cacheReadTokens - u.cacheWriteTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens },
        outputTokenDetails: { textTokens: u.outputTokens, reasoningTokens: 0 },
    };
}

function contentText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((p: any) => (p?.type === 'text' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
}

/**
 * The conversation as the SDK's one prompt. A run is a user prompt, sometimes
 * after seeded turns; user turns are joined as they are, any other turn is
 * labelled so the model reads who said it.
 */
export function promptFrom(messages: ModelMessage[]): string {
    const onlyUser = messages.every((m) => m.role === 'user');
    return messages
        .map((m) => (onlyUser ? contentText(m.content) : `${m.role}: ${contentText(m.content)}`))
        .filter(Boolean)
        .join('\n\n');
}

/** The last JSON object (or array) in a text, fenced or not. */
export function lastJson(text: string): unknown {
    const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
    for (const candidate of [...fenced.reverse(), text]) {
        for (const open of ['{', '[']) {
            const start = candidate.indexOf(open);
            const end = candidate.lastIndexOf(open === '{' ? '}' : ']');
            if (start < 0 || end <= start) continue;
            try {
                return JSON.parse(candidate.slice(start, end + 1));
            } catch {
                /* next candidate */
            }
        }
    }
    return undefined;
}

/**
 * Text-JSON salvage: the input of a result-tool call from the final text. A
 * bare array goes under the schema's single array property (the finder's
 * `suggestions`), the way the envelope recovery does on the one-shot path.
 */
export function salvageResultInput(text: string, resultTool: LoopTool | undefined): Record<string, unknown> | undefined {
    const value = lastJson(text);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    if (!Array.isArray(value)) return undefined;
    let props: Record<string, any> = {};
    try {
        props = (asSchema(resultTool?.inputSchema as any).jsonSchema as any)?.properties ?? {};
    } catch {
        props = {};
    }
    const arrays = Object.keys(props).filter((k) => props[k]?.type === 'array');
    return arrays.length === 1 ? { [arrays[0]]: value } : undefined;
}

interface AssistantTurn {
    id: string;
    text: string;
    toolUses: Array<{ id: string; name: string; input: unknown }>;
    usage?: any;
    emitted: boolean;
}

export async function runClaudeSdkLoopCall(deps: ClaudeSdkDeps, call: SdkLoopCall): Promise<any> {
    const resolved = resolveClaudeSdkRoute(call.slot);
    if (!resolved) throw new ClaudeSdkInfraError('gateway', 'slot is not eligible for the Agent SDK');
    const runtime = deps.runtime();
    const reasoning = cliReasoning(call.providerOptions);

    return deps.pool.withSession(
        {
            resolved,
            envelope: { slot: call.slot, organizationId: call.organizationId, provider: call.provider ?? call.slot?.provider, queueTimeoutMs: call.queueTimeoutMs, reporter: call.reporter },
            temperature: call.temperature,
            signal: call.signal,
            queueTimeoutMs: call.queueTimeoutMs,
            observe: langfuseRequestObserver(call.runName, call.telemetryMetadata),
            env: { maxOutputTokens: call.maxOutputTokens },
        },
        (session) => runInSession(deps, runtime, call, session, reasoning),
    );
}

async function runInSession(deps: ClaudeSdkDeps, runtime: SdkRuntime, call: SdkLoopCall, session: SdkSession, reasoning: ReturnType<typeof cliReasoning>): Promise<any> {
    const { loop } = call;
    const tools = loop.tools as Record<string, LoopTool>;
    const { server, names } = toMcpServer(runtime, tools, { abortSignal: session.abortController.signal });
    const turns = new Map<string, AssistantTurn>();
    const order: string[] = [];
    const toolResults = new Map<string, { output: unknown; isError: boolean }>();
    const stepEvents: any[] = [];
    const state = newDirectorState();

    const emitStep = async (event: any) => {
        stepEvents.push(event);
        state.steps += 1;
        await loop.onStepFinish?.(event);
    };
    const toolResultOf = (id: string, fallback?: unknown) => toolResults.get(id)?.output ?? fallback;

    const onToolBatch = async (calls: ToolBatchCall[]) => {
        const ids = new Set(calls.map((c) => c.tool_use_id));
        const owners = order.filter((id) => turns.get(id)!.toolUses.some((t) => ids.has(t.id)));
        owners.forEach((id) => (turns.get(id)!.emitted = true));
        const text = owners.map((id) => turns.get(id)!.text).join('');
        const usage = owners.map((id) => turns.get(id)!.usage).find(Boolean);
        await emitStep({
            text,
            toolCalls: calls.map((c) => ({ type: 'tool-call', toolCallId: c.tool_use_id, toolName: bareName(c.tool_name), input: c.tool_input })),
            toolResults: calls.map((c) => ({ type: 'tool-result', toolCallId: c.tool_use_id, toolName: bareName(c.tool_name), input: c.tool_input, output: toolResultOf(c.tool_use_id, c.tool_response) })),
            finishReason: 'tool-calls',
            ...(usage ? { usage: stepUsage(usage) } : {}),
        });
    };

    const trace: Array<{ kind: string; detail: Record<string, unknown> }> = [];
    const hooks = buildDirectorHooks({ director: loop.director, resultToolName: loop.resultToolName, state, onToolBatch, trace: (kind, detail) => trace.push({ kind, detail }) });

    let result: any;
    let thrown: unknown;
    let sessionId: string | undefined;
    try {
        for await (const m of runtime.query({
            prompt: promptFrom(call.messages),
            options: {
                model: session.model,
                systemPrompt: systemPromptFor(call.system, deps.framing),
                tools: [],
                mcpServers: names.length ? { kodus: server } : {},
                allowedTools: names,
                settingSources: [],
                persistSession: false,
                cwd: session.home,
                env: session.env,
                // A Stop block for the finalize note is one more turn (spike).
                maxTurns: loop.maxSteps + 1,
                thinking: reasoning.thinking,
                ...(reasoning.effort ? { effort: reasoning.effort } : {}),
                hooks,
                abortController: session.abortController,
                spawnClaudeCodeProcess: session.spawn,
            },
        })) {
            if (m.type === 'system' && m.subtype === 'init') sessionId = m.session_id;
            else if (m.type === 'assistant' && !m.parent_tool_use_id) {
                const id = m.message?.id ?? `turn-${order.length}`;
                let turn = turns.get(id);
                if (!turn) {
                    turn = { id, text: '', toolUses: [], emitted: false };
                    turns.set(id, turn);
                    order.push(id);
                }
                if (m.message?.usage) turn.usage = m.message.usage;
                for (const block of m.message?.content ?? []) {
                    if (block.type === 'text') turn.text += block.text;
                    else if (block.type === 'tool_use') turn.toolUses.push({ id: block.id, name: block.name, input: block.input });
                }
            } else if (m.type === 'user' && Array.isArray(m.message?.content)) {
                for (const block of m.message.content) {
                    if (block?.type === 'tool_result') toolResults.set(block.tool_use_id, { output: contentText(block.content) || block.content, isError: !!block.is_error });
                }
            } else if (m.type === 'result') {
                result = m;
            }
        }
    } catch (err) {
        // "Result received, then the process exits 1" (max turns, an error
        // result) is how the SDK ends; the result message is what counts.
        thrown = err;
    }

    const ledger = session.gateway.ledger.snapshot();
    if (session.gateway.localErrors.length) throw session.gateway.localErrors[session.gateway.localErrors.length - 1];
    const budgetEnd = result?.subtype === 'error_max_turns';
    const ok = result && (!result.is_error || budgetEnd);
    if (!ok) {
        const upstream = session.gateway.ledger.lastError();
        if (upstream) throw apiErrorFromUpstream(upstream, `${session.gateway.baseUrl}/v1/messages`);
        if (call.signal?.aborted) throw call.signal.reason ?? new Error('aborted');
        if (!result) {
            const message = String((thrown as Error)?.message ?? thrown ?? 'no result');
            throw new ClaudeSdkInfraError(/ENOENT|not found|spawn/i.test(message) ? 'spawn' : 'no-result', message, { cause: thrown });
        }
        // An error result with no upstream error: the CLI refused before any request (model id, options).
        throw new ClaudeSdkInfraError(state.steps === 0 ? 'model-rejected' : 'crash', String(result.result ?? result.subtype ?? 'error result'));
    }

    // Turns not handed over by a tool batch: the final text, a Stop re-prompt,
    // a tool turn cut by the turn cap. Each is a step, in order.
    const rest = order.map((id) => turns.get(id)!).filter((t) => !t.emitted);
    for (const [i, turn] of rest.entries()) {
        const last = i === rest.length - 1;
        const salvage =
            last && loop.resultToolName && !state.resultCalled && !turn.toolUses.length
                ? salvageResultInput(turn.text, (loop.tools as Record<string, LoopTool>)[loop.resultToolName])
                : undefined;
        const toolCalls = [
            ...turn.toolUses.map((t) => ({ type: 'tool-call', toolCallId: t.id, toolName: bareName(t.name), input: t.input })),
            ...(salvage ? [{ type: 'tool-call', toolCallId: 'salvage', toolName: loop.resultToolName, input: salvage }] : []),
        ];
        if (salvage) trace.push({ kind: 'result.salvaged', detail: { step: state.steps } });
        await emitStep({
            text: turn.text,
            toolCalls,
            toolResults: turn.toolUses.filter((t) => toolResults.has(t.id)).map((t) => ({ type: 'tool-result', toolCallId: t.id, toolName: bareName(t.name), input: t.input, output: toolResults.get(t.id)!.output })),
            finishReason: turn.toolUses.length ? 'tool-calls' : 'stop',
            ...(turn.usage ? { usage: stepUsage(turn.usage) } : {}),
        });
    }

    checkUsage(ledger.usage, result, session.model, sessionId, call);
    const usage = toAiSdkUsage(ledger.usage);
    const finalText = order.length ? turns.get(order[order.length - 1])!.text : '';
    return {
        text: finalText,
        steps: stepEvents,
        usage,
        totalUsage: usage,
        finishReason: budgetEnd ? 'length' : state.stopped ? 'stop' : stepEvents[stepEvents.length - 1]?.finishReason ?? 'stop',
        warnings: [],
        response: { id: sessionId ?? 'claude-agent-sdk', modelId: session.model, timestamp: new Date(), messages: [] },
        providerMetadata: {
            claudeAgentSdk: { sessionId, numTurns: result?.num_turns, requests: ledger.requests.length, compactions: ledger.compactions, sdkVersion: runtime.version, trace },
        },
    };
}

function stepUsage(u: any) {
    const cacheRead = u.cache_read_input_tokens ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    return toAiSdkUsage({ inputTokens: (u.input_tokens ?? 0) + cacheRead + cacheWrite, outputTokens: u.output_tokens ?? 0, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
}

/** The gateway's sum is what the span records; the CLI's own count is a cross-check. */
function checkUsage(ledger: LedgerUsage, result: any, model: string, sessionId: string | undefined, call: SdkLoopCall) {
    const mu = Object.entries(result?.modelUsage ?? {}).find(([k]) => k.startsWith(model))?.[1] as any;
    if (!mu) return;
    const cli = (mu.inputTokens ?? 0) + (mu.cacheReadInputTokens ?? 0) + (mu.cacheCreationInputTokens ?? 0);
    if (cli !== ledger.inputTokens || (mu.outputTokens ?? 0) !== ledger.outputTokens) {
        logger.warn({
            message: 'claude-sdk usage mismatch between gateway and CLI',
            context: 'ClaudeSdkLoopCall',
            metadata: { sessionId, runName: call.runName, organizationId: call.organizationId, gateway: ledger, cli: { input: cli, output: mu.outputTokens } },
        });
    }
}
