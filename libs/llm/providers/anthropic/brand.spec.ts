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
const createAnthropicMock = jest.fn(
    (_cfg: { baseURL?: string; headers?: Record<string, string> }) => {
        const factory = (_model: string) => ({ id: 'stub-model' });
        return factory;
    },
);

jest.mock('@ai-sdk/anthropic', () => ({
    createAnthropic: (cfg: { baseURL?: string; headers?: Record<string, string> }) =>
        createAnthropicMock(cfg),
}));

import { moonshotModule } from '../moonshot/index';
import { zaiModule } from '../zai/index';

const baseURLOf = (): string =>
    createAnthropicMock.mock.calls.at(-1)?.[0]?.baseURL ?? '';

const headersOf = (): Record<string, string> | undefined =>
    createAnthropicMock.mock.calls.at(-1)?.[0]?.headers;

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

    // A brand credential (Moonshot/Z.ai) explicitly re-pointed at OpenCode Go's
    // baseURL is an unlikely setup (nobody normally aims a "Kimi" connection at
    // a different provider's endpoint), but `asCompatible` spreads the WHOLE cfg
    // through unchanged before delegating to `anthropicModule.build` — so the
    // #1880 x-opencode-session gate should still fire here exactly as it does
    // for a plain anthropic_compatible slot, purely from that composition.
    it('a brand config explicitly re-pointed at OpenCode Go still gets x-opencode-session (composition through asCompatible)', () => {
        moonshotModule.build({
            provider: 'moonshot',
            model: 'kimi-k2.7-code',
            apiKey: 'k',
            baseURL: 'https://opencode.ai/zen/go',
            byokModelId: 'model-123',
        } as any);

        expect(baseURLOf()).toBe('https://opencode.ai/zen/go/v1');
        expect(headersOf()?.['x-opencode-session']).toMatch(/^[0-9a-f]{32}$/);
    });
});
