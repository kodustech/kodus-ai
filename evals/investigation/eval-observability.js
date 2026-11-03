/**
 * Registers the LlmObservability port for the eval, so benchmark runs produce
 * Langfuse traces the way production does.
 *
 * Why the eval had none: `agent-loop-call.ts` wraps every model call in a span
 * only when `getLlmObservability()` returns an implementation, and the single
 * registration lives in `ObservabilityService`'s constructor — a NestJS
 * singleton. The eval has no Nest container, so the port stayed empty and every
 * call ran through the bare `exec()` branch with no span at all. Nothing was
 * being dropped; nothing was ever created.
 *
 * Diagnosing it took a detour worth recording: the Langfuse processor logs
 * "Dropped span due to shouldExportSpan filter" for spans from an unrecognized
 * instrumentation scope, which is why a hand-rolled OTel span does not arrive
 * either. `startActiveObservation` from @langfuse/tracing produces one the
 * processor accepts.
 *
 * Deliberately NOT the production service: that one needs ConfigService and a
 * Mongo connection for its own metrics store, none of which a benchmark run
 * has. This implements the same three-line contract and nothing else.
 */
const { setLlmObservability } = require('@libs/llm/llm-observability');
const { startActiveObservation } = require('@langfuse/tracing');

/** Usage keys the Langfuse UI reads for cost — same names the production span
 *  sets, so a benchmark trace and a real one are comparable side by side. */
function usageAttrs(result) {
    const u = result?.usage || {};
    const out = {};
    if (u.inputTokens != null) out['gen_ai.usage.input_tokens'] = u.inputTokens;
    if (u.outputTokens != null) out['gen_ai.usage.output_tokens'] = u.outputTokens;
    if (u.totalTokens != null) out['gen_ai.usage.total_tokens'] = u.totalTokens;
    if (u.reasoningTokens != null)
        out['gen_ai.usage.reasoning_tokens'] = u.reasoningTokens;
    return out;
}

function registerEvalObservability() {
    setLlmObservability({
        async runAiSdkLLMInSpan(params) {
            const {
                spanName,
                runName,
                model,
                byokModelId,
                credentialId,
                route,
                usedFallback,
                attrs,
                exec,
            } = params;

            return startActiveObservation(
                spanName || runName || 'llm',
                async (span) => {
                    span.update({
                        input: undefined,
                        metadata: {
                            runName,
                            model,
                            byokModelId,
                            credentialId,
                            route,
                            usedFallback,
                            ...(attrs || {}),
                        },
                    });
                    try {
                        const result = await exec();
                        const u = usageAttrs(result);
                        span.update({
                            metadata: { ...u },
                            ...(result?.usage
                                ? {
                                      usageDetails: {
                                          input: result.usage.inputTokens,
                                          output: result.usage.outputTokens,
                                          total: result.usage.totalTokens,
                                      },
                                  }
                                : {}),
                        });
                        return result;
                    } catch (err) {
                        // A failed call is the one you most want to find later.
                        span.update({
                            level: 'ERROR',
                            statusMessage: String(err?.message || err).slice(0, 300),
                        });
                        throw err;
                    }
                },
                { asType: 'generation' },
            );
        },
    });
}

module.exports = { registerEvalObservability };
