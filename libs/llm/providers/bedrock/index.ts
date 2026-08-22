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
import { bedrockModelListing } from './listing';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderModule,
} from '../kernel/types';
import {
    normalizeSdkResult,
    normalizeSdkUsage,
} from '../kernel/usage';

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
            supportsTemperature: true,
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

    // Claude-on-Bedrock honors the SAME `anthropic.cacheControl` marker as native
    // Anthropic (per the AI SDK Bedrock docs). Non-Anthropic Bedrock models cache
    // implicitly / not at all, so they get no inline hint. 5-minute ephemeral only
    // (the 1h TTL is gated to specific Claude 4.5 deployments — not assumed here).
    systemCacheControl(cfg: ProviderBuildConfig): Record<string, unknown> | undefined {
        return isAnthropicModel(cfg.model)
            ? anthropicEphemeralCacheHint()
            : undefined;
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
        { key: 'awsBearerToken', label: 'Bedrock API key (bearer)', type: 'password', required: false, scope: 'settings' },
        { key: 'awsAccessKeyId', label: 'AWS access key id', type: 'text', required: false, scope: 'settings' },
        { key: 'awsSecretAccessKey', label: 'AWS secret access key', type: 'password', required: false, scope: 'settings' },
        { key: 'awsRegion', label: 'AWS region', type: 'text', required: false, scope: 'settings', placeholder: 'us-east-1' },
    ],
    modelListing: bedrockModelListing,
};

registerProvider(bedrockModule);
