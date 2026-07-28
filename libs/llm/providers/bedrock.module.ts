/**
 * Amazon Bedrock provider module (Phase 1, plan 01-02) — id `amazon_bedrock`.
 * Reproduces byok-to-vercel.ts's AMAZON_BEDROCK case via the shared
 * bedrockModelFromCredentials builder (bearer-token OR SigV4 IAM). Unlike other
 * providers, bedrock authenticates with the aws* fields (NOT `apiKey`); the
 * builder decrypts them internally, so the config is passed through as-is.
 */
import type { LanguageModel } from 'ai';
import { z } from 'zod';
import type { ModelCapabilities } from '@kodus/kodus-common/llm';
import { bedrockModelFromCredentials } from '@libs/llm/model-builders';
import { registerProvider } from './registry';
import type {
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
        return { supportsTemperature: true, supportsReasoning: false };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        // aws* fields carry the ENCRYPTED ciphertext; the builder decrypts them.
        return bedrockModelFromCredentials(cfg, cfg.model);
    },

    // No reasoning() — Bedrock has no native thinking mapping here (default: off).

    normalizeUsage(_raw: unknown): NormalizedUsage {
        return { input: 0, output: 0, reasoning: 0 };
    },
    normalize(raw: unknown): ModelResult {
        return { usage: { input: 0, output: 0, reasoning: 0 }, raw };
    },

    uiFields: [
        { key: 'awsBearerToken', label: 'Bedrock API key (bearer)', type: 'password', required: false, scope: 'settings' },
        { key: 'awsAccessKeyId', label: 'AWS access key id', type: 'text', required: false, scope: 'settings' },
        { key: 'awsSecretAccessKey', label: 'AWS secret access key', type: 'password', required: false, scope: 'settings' },
        { key: 'awsRegion', label: 'AWS region', type: 'text', required: false, scope: 'settings', placeholder: 'us-east-1' },
    ],
};

registerProvider(bedrockModule);
