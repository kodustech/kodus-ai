/**
 * Structured single-shot LLM call for the review pipeline, on the LOCAL
 * (Vercel AI SDK) stack — no kodus-common PromptRunnerService.
 *
 * Model policy (mirrors the code-review agents):
 *   - main:      the org's BYOK model, or our managed default when no BYOK
 *                (`accounts/fireworks/models/deepseek-v4-flash` on Fireworks —
 *                resolved by byokToVercelModel).
 *   - fallback:  the org's OWN configured fallback (BYOK) if present; otherwise,
 *                ONLY for a trial/no-BYOK org, our managed `openai/gpt-oss-120b`
 *                on Groq. A BYOK org whose main fails does NOT cascade onto our
 *                managed Groq — that would bill us for their inference. A BYOK
 *                org without its own fallback simply fails.
 *
 * The managed Groq fallback is built from the same env the (removed) kodus-common
 * Groq provider used (`API_GROQ_API_KEY` / `API_GROQ_BASE_URL`), so there is no
 * decrypt path and no synthetic BYOK config.
 */
import { Output, type LanguageModel, type Schema } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { BYOKConfig } from '@kodus/kodus-common/llm';
import { z } from 'zod';
import { byokToVercelModel, getModelName } from '@libs/llm/byok-to-vercel';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';
import {
    tracedGenerateText,
    timeoutSignal,
    LLM_CALL_TIMEOUT_MS,
} from '@libs/llm/llm-call';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import { createLogger } from '@libs/core/log/logger';
import { zodToStrictWireSchema } from '@libs/llm/strict-wire-schema';
import { ObservabilityService } from '@libs/core/log/observability.service';

const logger = createLogger('StructuredReviewCall');

/** Managed trial-only fallback: Groq `openai/gpt-oss-120b`. Null if unconfigured. */
function buildTrialGroqFallback(): LanguageModel | null {
    const apiKey = process.env.API_GROQ_API_KEY;
    if (!apiKey) {
        return null;
    }
    return createOpenAICompatible({
        name: 'groq',
        apiKey,
        baseURL: process.env.API_GROQ_BASE_URL || 'https://api.groq.com/openai/v1',
    })('openai/gpt-oss-120b') as unknown as LanguageModel;
}

export interface StructuredReviewCallParams<S extends z.ZodType | Schema> {
    byokConfig?: BYOKConfig;
    /** A zod schema, or an AI-SDK `jsonSchema()` Schema when the caller
     *  needs the wire JSON schema to differ from the parse validation
     *  (e.g. OpenAI-strict `required` semantics vs lenient providers). */
    schema: S;
    system: string;
    user: string;
    /** Used for both the observability span and its runName. */
    runName: string;
    organizationId?: string;
    attrs?: Record<string, unknown>;
    observabilityService: ObservabilityService;
}

/**
 * Run a structured-output call on the review default (or BYOK) model, falling
 * back to the org's own fallback / the trial Groq model per the policy above.
 * Returns the parsed object validated against `schema`.
 */
export async function runStructuredReviewCall<S extends z.ZodType | Schema>(
    params: StructuredReviewCallParams<S>,
): Promise<S extends z.ZodType ? z.infer<S> : S extends Schema<infer T> ? T : never> {
    const {
        byokConfig,
        schema,
        system,
        user,
        runName,
        organizationId,
        attrs,
        observabilityService,
    } = params;

    const hasByok = !!byokConfig?.main;

    // A raw zod schema would go through the AI SDK's zodSchema(), whose
    // INPUT-side conversion drops `.optional()` fields from `required` —
    // OpenAI strict structured outputs 400 on that, which silently killed
    // kody-rules shards and guidance-file extraction for BYOK-OpenAI orgs.
    // Convert centrally so every caller (present and future) sends a
    // strict-compatible wire schema; AI-SDK Schema objects pass through
    // untouched (the caller already controls its wire format).
    let wireSchema: unknown = schema;
    if (schema instanceof z.ZodType) {
        try {
            wireSchema = zodToStrictWireSchema(schema);
        } catch (err) {
            // Unconvertible zod shape — fall back to the SDK's own
            // conversion rather than failing the call outright. That
            // fallback still 400s on OpenAI strict when the schema has
            // optional fields, so make the degradation loud: this is the
            // exact silence that hid the shard/extraction failures.
            logger.warn({
                message: `[strict-wire-schema] conversion failed for ${runName}; falling back to raw zod schema (OpenAI-strict callers may reject it): ${err instanceof Error ? err.message : String(err)}`,
                context: 'runStructuredReviewCall',
                metadata: { runName, organizationId, err },
            });
            wireSchema = schema;
        }
    }

    const mainModel = wrapByokModel(
        byokToVercelModel(byokConfig, 'main', { structuredOutputs: true }),
        { byokConfig, organizationId, role: 'main' },
    );

    // Customer BYOK fallback wins; else trial-only managed Groq; else none.
    const fallbackModel: LanguageModel | null = byokConfig?.fallback
        ? wrapByokModel(
              byokToVercelModel(byokConfig, 'fallback', {
                  structuredOutputs: true,
              }),
              { byokConfig, organizationId, role: 'fallback' },
          )
        : hasByok
          ? null
          : buildTrialGroqFallback();

    const call = (
        model: LanguageModel,
        modelName: string,
        isFallback: boolean,
    ): Promise<any> =>
        observabilityService
            .runAiSdkLLMInSpan<any>({
                spanName: runName,
                runName,
                model: modelName,
                attrs: { ...(attrs ?? {}), fallback: isFallback },
                exec: () =>
                    tracedGenerateText({
                        model: model as any,
                        system,
                        prompt: user,
                        output: Output.object({ schema: wireSchema as any }),
                        // Cap hung provider calls at LLM_CALL_TIMEOUT_MS (10min)
                        // instead of the 30min agent-level fallback — these run
                        // in parallel shards, so a stuck call must not hold a
                        // pipeline slot for the full agent budget. Also feeds the
                        // BYOK limiter cancellation. Matches peer AI-SDK callers.
                        abortSignal: timeoutSignal(LLM_CALL_TIMEOUT_MS),
                        ...toAiSdkTelemetryArgs(
                            buildLangfuseTelemetry(runName, {
                                organizationId,
                            }),
                        ),
                    } as any),
            })
            .then(
                (r: any) =>
                    (r.experimental_output ?? r.output) as any,
            );

    try {
        return await call(mainModel, getModelName(byokConfig), false);
    } catch (err) {
        if (!fallbackModel) {
            throw err;
        }
        return await call(
            fallbackModel,
            hasByok ? 'byok-fallback' : 'groq:openai/gpt-oss-120b',
            true,
        );
    }
}
