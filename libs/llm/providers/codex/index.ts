import type { LanguageModel } from 'ai';
import { z } from 'zod';
import { buildCodexSubscriptionModel } from '@libs/llm/codex-subscription-model';
import { registerProvider } from '../kernel/registry';
import { normalizeSdkResult, normalizeSdkUsage } from '../kernel/usage';
import type {
    ModelCapabilities,
    ProviderBuildConfig,
    ProviderModule,
    ProviderReasoningOptions,
    ReasoningEffort,
} from '../kernel/types';
import type { ModelReasoningTraits } from '../kernel/reasoning-traits';

export const codexSubscriptionModule: ProviderModule = {
    id: 'chatgpt_subscription',
    label: 'ChatGPT Subscription',
    doc: 'https://developers.openai.com/codex/auth',

    settingsSchema: z.object({
        codexAccessToken: z.string().optional(),
        codexRefreshToken: z.string().optional(),
        accountId: z.string().optional(),
        codexNoRetainedReasoning: z.boolean().optional(),
    }),

    capabilities(): ModelCapabilities {
        return {
            maxInputTokens: 400_000,
            structuredOutput: 'json_schema',
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            promptCaching: false,
            supportsTemperature: false,
            supportsReasoning: true,
        };
    },

    build(cfg: ProviderBuildConfig): LanguageModel {
        const auth =
            cfg.codexAccessToken && cfg.accountId
                ? {
                      accessToken: cfg.codexAccessToken,
                      refreshToken: cfg.codexRefreshToken,
                      accountId: cfg.accountId,
                      credentialId: cfg.credentialId,
                      organizationId: cfg.organizationId,
                  }
                : undefined;
        return buildCodexSubscriptionModel(cfg.model, auth, {
            retainReasoning: !cfg.codexNoRetainedReasoning,
        });
    },

    reasoning(
        _cfg: ProviderBuildConfig,
        effort: ReasoningEffort,
    ): ProviderReasoningOptions {
        return effort === 'none' ? {} : { openai: { reasoningEffort: effort } };
    },

    reasoningTraits(): ModelReasoningTraits {
        return {
            thinksByDefault: true,
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
        };
    },

    temperaturePolicy: () => ({ kind: 'unsupported' }),
    normalizeUsage: normalizeSdkUsage,
    normalize: normalizeSdkResult,

    uiFields: [
        {
            key: 'codexAccessToken',
            label: 'Codex access token',
            type: 'password',
            required: true,
            scope: 'settings',
        },
        {
            key: 'codexRefreshToken',
            label: 'Codex refresh token',
            type: 'password',
            required: true,
            scope: 'settings',
        },
        {
            key: 'accountId',
            label: 'ChatGPT account id',
            type: 'text',
            required: true,
            scope: 'settings',
        },
    ],

    providerOptionsNamespace: () => 'openai',
    reasoningOverrideExample: () => '{\n  "reasoningEffort": "high"\n}',
    modelListing: () => ({
        kind: 'static',
        models: [
            { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
            { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
        ],
    }),
};

registerProvider(codexSubscriptionModule);
