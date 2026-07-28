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
import { registerProvider } from './registry';
import type {
    ModelCapabilities,
    ModelResult,
    NormalizedUsage,
    ProviderBuildConfig,
    ProviderModule,
} from './types';

export const bedrockModule: ProviderModule = {
    id: 'amazon_bedrock',
    label: 'Amazon Bedrock',

    settingsSchema: z.object({
        awsRegion: z.string().optional(),
        awsBearerToken: z.string().optional(),
        awsAccessKeyId: z.string().optional(),
        awsSecretAccessKey: z.string().optional(),
        awsSessionToken: z.string().optional(),
    }),

    capabilities(_model: string): ModelCapabilities {
        // Bedrock hosts many families; reasoning support is model-specific and
        // not advertised generically at this tier. Refined in 01-04.
        return {
            supportsTemperature: true,
            supportsReasoning: false,
            structuredOutput: 'none',
            toolCalling: 'native',
            usageGranularity: 'output_only',
            streaming: true,
            promptCaching: false,
        };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        // aws* fields carry the ENCRYPTED ciphertext; the builder decrypts them.
        return bedrockModelFromCredentials(cfg, cfg.model);
    },

    // No reasoning() — Bedrock has no native thinking mapping here (default: off).

    // ── Phase 3: real usage extraction (D-01 / Q4) ──────────────────────────
    // @ai-sdk/amazon-bedrock maps Bedrock's usage onto the high-level ai@7
    // LanguageModelUsage shape, so generateText's result carries the same fields
    // every module reads. ai@7 nests reasoning under
    // `outputTokenDetails.reasoningTokens`; the top-level `reasoningTokens` is the
    // ai@6 flat fallback (0 when a Bedrock model reports no thinking split).
    // Reasoning is a detail-OF output — `output` is the FULL completion count and
    // is NEVER reduced by reasoning (Q4 double-count trap).
    normalizeUsage(raw: unknown): NormalizedUsage {
        const u =
            (raw as { usage?: Record<string, any> } | undefined)?.usage ?? {};
        return {
            input: u.inputTokens ?? 0,
            output: u.outputTokens ?? 0,
            reasoning:
                u.outputTokenDetails?.reasoningTokens ??
                u.reasoningTokens ??
                0,
        };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: this.normalizeUsage(raw), raw };
    },

    uiFields: [
        { key: 'awsBearerToken', label: 'Bedrock API key (bearer)', type: 'password', required: false, scope: 'settings' },
        { key: 'awsAccessKeyId', label: 'AWS access key id', type: 'text', required: false, scope: 'settings' },
        { key: 'awsSecretAccessKey', label: 'AWS secret access key', type: 'password', required: false, scope: 'settings' },
        { key: 'awsRegion', label: 'AWS region', type: 'text', required: false, scope: 'settings', placeholder: 'us-east-1' },
    ],
};

registerProvider(bedrockModule);
