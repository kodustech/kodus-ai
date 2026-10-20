/**
 * A single-shot call on the Claude Agent SDK: one `query()`, one turn, no tools.
 * With a schema the CLI serves it through `outputFormat` (its StructuredOutput
 * tool); the answer comes back shaped like `generateText`'s (`text`, `output`,
 * `usage`), and `runReviewCall` validates it and runs its usual recovery.
 */
import type { SdkOneShotCall, SdkOneShotResult } from '@libs/llm/sdk-executor-registry';

import { apiErrorFromUpstream, ClaudeSdkInfraError } from './errors';
import { resolveClaudeSdkRoute } from './eligibility';
import { langfuseRequestObserver } from './observe';
import { cliReasoning } from './reasoning';
import { systemPromptFor, toAiSdkUsage, type ClaudeSdkDeps } from './sdk-loop-call';

export async function runClaudeSdkOneShot(deps: ClaudeSdkDeps, call: SdkOneShotCall): Promise<SdkOneShotResult> {
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
        async (session) => {
            let result: any;
            let text = '';
            let thrown: unknown;
            try {
                for await (const m of runtime.query({
                    prompt: call.prompt,
                    options: {
                        model: session.model,
                        systemPrompt: systemPromptFor(call.system, deps.framing),
                        tools: [],
                        mcpServers: {},
                        allowedTools: [],
                        settingSources: [],
                        persistSession: false,
                        cwd: session.home,
                        env: session.env,
                        maxTurns: call.jsonSchema ? 2 : 1,
                        thinking: reasoning.thinking,
                        ...(reasoning.effort ? { effort: reasoning.effort } : {}),
                        ...(call.jsonSchema ? { outputFormat: { type: 'json_schema', schema: call.jsonSchema } } : {}),
                        abortController: session.abortController,
                        spawnClaudeCodeProcess: session.spawn,
                    },
                })) {
                    if (m.type === 'assistant' && !m.parent_tool_use_id) {
                        for (const block of m.message?.content ?? []) if (block.type === 'text') text += block.text;
                    } else if (m.type === 'result') result = m;
                }
            } catch (err) {
                thrown = err;
            }

            if (session.gateway.localErrors.length) throw session.gateway.localErrors[session.gateway.localErrors.length - 1];
            const usage = toAiSdkUsage(session.gateway.ledger.snapshot().usage);
            if (result && !result.is_error) {
                return {
                    text: typeof result.result === 'string' && result.result ? result.result : text,
                    ...(result.structured_output !== undefined ? { output: result.structured_output } : {}),
                    usage,
                    finishReason: 'stop',
                };
            }
            // Out of structured-output retries: the text goes to the caller's
            // validation, which raises what generateText raises for it.
            if (result?.subtype === 'error_max_structured_output_retries' || (call.jsonSchema && result?.subtype === 'error_max_turns')) {
                return { text, usage, finishReason: 'stop' };
            }
            const upstream = session.gateway.ledger.lastError();
            if (upstream) throw apiErrorFromUpstream(upstream, `${session.gateway.baseUrl}/v1/messages`);
            if (call.signal?.aborted) throw call.signal.reason ?? new Error('aborted');
            if (!result) {
                const message = String((thrown as Error)?.message ?? thrown ?? 'no result');
                throw new ClaudeSdkInfraError(/ENOENT|not found|spawn/i.test(message) ? 'spawn' : 'no-result', message, { cause: thrown });
            }
            throw new ClaudeSdkInfraError('model-rejected', String(result.result ?? result.subtype ?? 'error result'));
        },
    );
}
