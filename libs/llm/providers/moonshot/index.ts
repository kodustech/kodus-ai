/**
 * Moonshot (Kimi) provider module — id `moonshot`.
 *
 * Makes Moonshot a FIRST-CLASS registry provider instead of the old model-name
 * sniffing + inline `createOpenAICompatible` exception in byok-to-vercel.ts. The
 * managed trial-default (kimi-* with no BYOK) now routes through this module.
 *
 * Moonshot speaks the OpenAI Chat Completions protocol (api.moonshot.ai/v1), so
 * this mirrors novita/openrouter (built via `createOpenAICompatible`). Its models
 * are Kimi/Moonshot, which must NEVER be downgraded off native `json_schema`
 * (D-00b, Pitfall 2) — the shared `isNeverDowngradeModel` policy drives the
 * structured-output gate here, the SAME policy the openai module applies to Kimi
 * served over `openai_compatible`.
 *
 * BEHAVIOR-PRESERVATION NOTE (byok-to-vercel.env-default.spec.ts case 7/9): the
 * old inline exception produced `createOpenAICompatible({name, apiKey, baseURL})`
 * with NO `supportsStructuredOutputs` field for the managed trial-default (which
 * is called WITHOUT the structuredOutputs opt-in). So build() OMITS the field
 * entirely unless the caller opts in — reproducing the exact factory call the
 * inline made, keeping the golden-master cases green. (novita/openrouter always
 * emit the boolean; moonshot conditionally omits it precisely to match the pinned
 * managed-default call shape.)
 */
import type { LanguageModel } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { z } from 'zod';
import { isNeverDowngradeModel } from '@libs/llm/structured-output-gate';
import { registerProvider } from '../kernel/registry';
import { moonshotModelListing } from './listing';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderBuildOptions,
    ProviderModule,
} from '../kernel/types';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

export const moonshotModule: ProviderModule = {
    id: 'moonshot',
    label: 'Moonshot',

    settingsSchema: z.object({ baseURL: z.string().optional() }),

    capabilities(model: string): ModelCapabilities {
        return {
            supportsTemperature: true,
            // Reasoning (kimi-*-thinking) is upstream-dependent and was not mapped
            // by the old inline exception; keep it off by default (normalizeUsage
            // still reads a reasoning split when an upstream reports one — see below).
            supportsReasoning: false,
            // Kimi/Moonshot honor strict native json_schema (never-downgrade, D-00b).
            structuredOutput: isNeverDowngradeModel(model)
                ? 'json_schema'
                : 'json_object',
            toolCalling: 'native',
            usageGranularity: 'output_only',
            streaming: true,
            promptCaching: false,
        };
    },

    build(cfg: ProviderBuildConfig, opts?: ProviderBuildOptions): LanguageModel {
        // Kimi/Moonshot is the never-downgrade family: keep json_schema ON when
        // opted in (a baseURL heuristic would reject a direct-Moonshot upstream —
        // D-00b). No other moonshot model qualifies, so this is the whole gate.
        const enableStructuredOutputs =
            opts?.structuredOutputs === true &&
            isNeverDowngradeModel(cfg.model);
        return createOpenAICompatible({
            name: 'moonshot',
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL || 'https://api.moonshot.ai/v1',
            // OMIT the field unless opting in — the managed trial-default is called
            // without the opt-in and its factory call shape (no field) is pinned by
            // byok-to-vercel.env-default.spec.ts case 7/9.
            ...(enableStructuredOutputs
                ? { supportsStructuredOutputs: true }
                : {}),
        })(cfg.model);
    },

    // No reasoning() — the inline moonshot exception mapped no thinking param;
    // keep parity (default: off).

    // ── Usage extraction (Q4: reasoning is a detail-OF output) ───────────────
    // @ai-sdk/openai-compatible maps Moonshot's { prompt_tokens, completion_tokens }
    // onto the high-level ai@7 LanguageModelUsage shape. A kimi-*-thinking upstream
    // surfaces its split at `outputTokenDetails.reasoningTokens` (top-level
    // `reasoningTokens` is the ai@6 flat fallback; 0 for non-thinking calls).
    // Reasoning is a subset of output — `output` is the FULL completion count and is
    // NEVER reduced by reasoning (Q4 double-count trap).
    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        { key: 'apiKey', label: 'API key', type: 'password', required: true, scope: 'top' },
        { key: 'baseURL', label: 'Base URL', type: 'url', required: false, scope: 'top', placeholder: 'https://api.moonshot.ai/v1' },
    ],
    modelListing: moonshotModelListing,
};

registerProvider(moonshotModule);
