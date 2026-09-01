/**
 * Amazon Bedrock provider module (Phase 1, plan 01-02) — id `amazon_bedrock`.
 * Reproduces byok-to-vercel.ts's AMAZON_BEDROCK case via the shared
 * bedrockModelFromCredentials builder (bearer-token OR SigV4 IAM). Unlike other
 * providers, bedrock authenticates with the aws* fields (NOT `apiKey`); the
 * builder decrypts them internally, so the config is passed through as-is.
 */
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { bedrockModelFromCredentials } from '@libs/llm/model-builders';
import { registerProvider } from '../kernel/registry';
import { reasoningConfigForModel } from '../kernel/model-reasoning';
import {
    anthropicEphemeralCacheHint,
    isAnthropicModel,
} from '../kernel/anthropic-cache';
import { anthropicModule } from '../anthropic';
import { bedrockModelListing } from './listing';
import type { TemperaturePolicy } from '../kernel/model-types';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderModule,
} from '../kernel/types';
import {
    NON_REASONING_TRAITS,
    type ModelReasoningTraits,
} from '../kernel/reasoning-traits';
import { normalizeSdkResult, normalizeSdkUsage } from '../kernel/usage';

/**
 * Claude-on-Bedrock is the SAME model as native Claude, so it obeys the same
 * temperature rule — and that rule is not "reasoning models don't take it": the
 * 4.7+ line REJECTS temperature outright, a 400 on the whole request. Bedrock
 * used to answer `supportsTemperature: true` for every family at once, which
 * covered `global.anthropic.claude-opus-4-7` and `eu.anthropic.claude-opus-4-8`
 * (both live in production) with the wrong answer. Delegating means the answer
 * is written once, by the module that owns Claude. Non-Claude families here
 * (Nova, MiniMax, Kimi) take temperature freely.
 */
function bedrockTemperaturePolicy(model: string): TemperaturePolicy {
    return isAnthropicModel(model)
        ? anthropicModule.temperaturePolicy!({
              provider: 'amazon_bedrock',
              model,
          } as ProviderBuildConfig)
        : { kind: 'adjustable' };
}

export const bedrockModule: ProviderModule = {
    id: 'amazon_bedrock',
    label: 'Amazon Bedrock',
    doc: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',

    settingsSchema: z.object({
        awsRegion: z.string().optional(),
        awsBearerToken: z.string().optional(),
        awsAccessKeyId: z.string().optional(),
        awsSecretAccessKey: z.string().optional(),
        awsSessionToken: z.string().optional(),
    }),

    capabilities(model: string): ModelCapabilities {
        // Bedrock hosts many families; reasoning is a model-family property, so
        // it is resolved centrally — a Claude on Bedrock gets the same reasoning
        // config as native Anthropic (was hardcoded `false`, losing it entirely).
        const reasoningConfig = reasoningConfigForModel(model);
        return {
            supportsReasoning: !!reasoningConfig,
            reasoningConfig,
            structuredOutput: 'none',
            toolCalling: 'native',
            usageGranularity: 'output_only',
            streaming: true,
            // Only the Anthropic-family deployments accept inline cache markers;
            // Nova/Llama/etc. on Bedrock don't (matches systemCacheControl below).
            promptCaching: isAnthropicModel(model),
        };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        // aws* fields carry the ENCRYPTED ciphertext; the builder decrypts them.
        return bedrockModelFromCredentials(cfg, cfg.model);
    },

    // No reasoning() — Bedrock has no native thinking mapping here (default: off).

    temperaturePolicy(cfg: ProviderBuildConfig): TemperaturePolicy {
        return bedrockTemperaturePolicy(cfg.model);
    },

    // `@ai-sdk/amazon-bedrock` builds models whose provider id is `amazon-bedrock`
    // (verified against the built model, not the docs), so that — or its camelCase
    // form — is the only key the SDK reads. Declaring it is what lets a user's
    // Custom reasoning override be wrapped under a key that exists; undeclared, it
    // went out unwrapped and was dropped without a word (the Novita failure).
    providerOptionsNamespace: () => 'amazon-bedrock',

    // Claude-on-Bedrock honors the SAME `anthropic.cacheControl` marker as native
    // Anthropic (per the AI SDK Bedrock docs). Non-Anthropic Bedrock models cache
    // implicitly / not at all, so they get no inline hint. 5-minute ephemeral only
    // (the 1h TTL is gated to specific Claude 4.5 deployments — not assumed here).
    systemCacheControl(
        cfg: ProviderBuildConfig,
    ): Record<string, unknown> | undefined {
        return isAnthropicModel(cfg.model)
            ? anthropicEphemeralCacheHint()
            : undefined;
    },

    // Claude-on-Bedrock: extended thinking is OPT-IN (reasoning_config) → OFF by
    // default, so a structured call is valid as-is; forced tool_choice still
    // rejects thinking IF one enables it. Non-Anthropic families (Nova/Llama)
    // neither think nor force → the safe default.
    reasoningTraits(cfg: ProviderBuildConfig): ModelReasoningTraits {
        if (!isAnthropicModel(cfg.model)) {
            return NON_REASONING_TRAITS;
        }
        return {
            thinksByDefault: false,
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: true,
        };
    },

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // @ai-sdk/amazon-bedrock maps Bedrock's usage onto the high-level ai@7
    // LanguageModelUsage shape, so generateText's result carries the same fields
    // every module reads. ai@7 nests reasoning under
    // `outputTokenDetails.reasoningTokens`; the top-level `reasoningTokens` is the
    // ai@6 flat fallback (0 when a Bedrock model reports no thinking split).
    // Reasoning is a detail-OF output — `output` is the FULL completion count and
    // is NEVER reduced by reasoning (Q4 double-count trap).
    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        {
            key: 'awsBearerToken',
            label: 'Bedrock API key (bearer)',
            type: 'password',
            required: false,
            scope: 'settings',
        },
        {
            key: 'awsAccessKeyId',
            label: 'AWS access key id',
            type: 'text',
            required: false,
            scope: 'settings',
        },
        {
            key: 'awsSecretAccessKey',
            label: 'AWS secret access key',
            type: 'password',
            required: false,
            scope: 'settings',
        },
        {
            key: 'awsRegion',
            label: 'AWS region',
            type: 'text',
            required: false,
            scope: 'settings',
            placeholder: 'us-east-1',
        },
    ],
    modelListing: bedrockModelListing,
};

registerProvider(bedrockModule);
