import { BYOKProvider } from '@libs/llm/model-providers';
import type { ProviderBuildConfig } from '../kernel/types';
import { codexSubscriptionModule } from './index';

const config: ProviderBuildConfig = {
    provider: BYOKProvider.CHATGPT_SUBSCRIPTION,
    apiKey: '',
    model: 'gpt-5.6-luna',
};

describe('ChatGPT subscription provider', () => {
    it('declares the measured endpoint capabilities and reasoning traits', () => {
        expect(codexSubscriptionModule.capabilities(config.model)).toEqual({
            maxInputTokens: 400_000,
            structuredOutput: 'json_schema',
            toolCalling: 'native',
            usageGranularity: 'reasoning_split',
            streaming: true,
            promptCaching: false,
            supportsTemperature: false,
            supportsReasoning: true,
        });
        expect(codexSubscriptionModule.reasoningTraits?.(config)).toEqual({
            thinksByDefault: true,
            canDisableThinking: true,
            supportsForcedToolChoice: true,
            forcedToolChoiceRejectsThinking: false,
        });
        expect(codexSubscriptionModule.temperaturePolicy?.(config)).toEqual({
            kind: 'unsupported',
        });
    });

    it('lists the two account-scoped models as CatalogModel objects', () => {
        expect(
            codexSubscriptionModule.modelListing?.('chatgpt_subscription'),
        ).toEqual({
            kind: 'static',
            models: [
                { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
                { id: 'gpt-5.6-luna', name: 'GPT-5.6 Luna' },
                { id: 'gpt-5.6-terra', name: 'GPT-5.6 Terra' },
            ],
        });
        expect(codexSubscriptionModule.catalog).toBeUndefined();
    });

    it('builds without credentials or an auth file', () => {
        const previous = process.env.API_CODEX_AUTH_FILE;
        delete process.env.API_CODEX_AUTH_FILE;
        try {
            expect(() => codexSubscriptionModule.build(config)).not.toThrow();
        } finally {
            if (previous === undefined) delete process.env.API_CODEX_AUTH_FILE;
            else process.env.API_CODEX_AUTH_FILE = previous;
        }
    });
});
