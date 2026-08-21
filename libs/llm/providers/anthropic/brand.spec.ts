/**
 * anthropicBrandModule — baseURL resolution for the Anthropic-protocol brands
 * (Moonshot/Kimi, Z.ai/GLM). The brand's `baseURL` field is `required: false`
 * (a key-only connect is allowed), but the shared build appends `/v1` to
 * `anthropicCompatibleRootURL(baseURL || '')`, so an empty baseURL would yield
 * the invalid relative URL '/v1'. These specs pin that a key-only connect falls
 * back to the brand's curated `defaults.baseURL` instead.
 *
 * `@ai-sdk/anthropic` is mocked so we can capture the exact baseURL the module
 * hands the SDK without a live call (the conformance specs cover the real path).
 */
const createAnthropicMock = jest.fn((_cfg: { baseURL?: string }) => {
    const factory = (_model: string) => ({ id: 'stub-model' });
    return factory;
});

jest.mock('@ai-sdk/anthropic', () => ({
    createAnthropic: (cfg: { baseURL?: string }) => createAnthropicMock(cfg),
}));

import { moonshotModule } from '../moonshot/index';
import { zaiModule } from '../zai/index';

const baseURLOf = (): string =>
    createAnthropicMock.mock.calls.at(-1)?.[0]?.baseURL ?? '';

describe('anthropicBrandModule — baseURL fallback for a key-only connect', () => {
    beforeEach(() => createAnthropicMock.mockClear());

    it('Moonshot with NO baseURL falls back to the curated default endpoint (not /v1)', () => {
        moonshotModule.build({
            provider: 'moonshot',
            model: 'kimi-k2.7-code',
            apiKey: 'k',
        } as any);

        const url = baseURLOf();
        expect(url).not.toBe('/v1');
        expect(url).toBe('https://api.moonshot.ai/anthropic/v1');
    });

    it('Z.ai with NO baseURL falls back to the curated default endpoint (not /v1)', () => {
        zaiModule.build({
            provider: 'zai',
            model: 'glm-5.2',
            apiKey: 'k',
        } as any);

        const url = baseURLOf();
        expect(url).not.toBe('/v1');
        expect(url).toBe('https://api.z.ai/api/anthropic/v1');
    });

    it('an EXPLICIT baseURL still wins over the catalog default', () => {
        moonshotModule.build({
            provider: 'moonshot',
            model: 'kimi-k2.7-code',
            apiKey: 'k',
            baseURL: 'https://api.kimi.com/coding',
        } as any);

        expect(baseURLOf()).toBe('https://api.kimi.com/coding/v1');
    });
});
