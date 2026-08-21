import {
    openRouterHonorsJsonSchema,
    openAiCompatibleHonorsJsonSchema,
    isNeverDowngradeModel,
} from './structured-output-gate';

describe('openRouterHonorsJsonSchema', () => {
    it('enables for known schema-honoring prefixes', () => {
        expect(openRouterHonorsJsonSchema('openai/gpt-5')).toBe(true);
        expect(openRouterHonorsJsonSchema('anthropic/claude-opus-5')).toBe(true);
        expect(openRouterHonorsJsonSchema('google/gemini-3')).toBe(true);
        expect(openRouterHonorsJsonSchema('moonshotai/kimi-k2')).toBe(true);
    });

    it('rejects unknown upstreams', () => {
        expect(openRouterHonorsJsonSchema('deepseek/deepseek-chat')).toBe(false);
        expect(openRouterHonorsJsonSchema('x-ai/grok-4')).toBe(false);
    });
});

describe('openAiCompatibleHonorsJsonSchema', () => {
    const orig = { ...process.env };
    afterEach(() => {
        process.env = { ...orig };
    });

    it('false without a baseURL', () => {
        expect(openAiCompatibleHonorsJsonSchema(undefined)).toBe(false);
        expect(openAiCompatibleHonorsJsonSchema('')).toBe(false);
    });

    it('true for vLLM :8000 and Fireworks', () => {
        expect(openAiCompatibleHonorsJsonSchema('http://vllm.internal:8000/v1')).toBe(true);
        expect(openAiCompatibleHonorsJsonSchema('https://api.fireworks.ai/inference/v1')).toBe(true);
    });

    it('false for an unknown proxy, true once ops allowlists it', () => {
        expect(openAiCompatibleHonorsJsonSchema('https://my-proxy.example.com/v1')).toBe(false);
        process.env.API_TRUST_JSON_SCHEMA_BASE_URLS = 'my-proxy.example.com,other';
        expect(openAiCompatibleHonorsJsonSchema('https://my-proxy.example.com/v1')).toBe(true);
    });
});

describe('isNeverDowngradeModel', () => {
    it('matches Kimi / Moonshot in any casing/host form', () => {
        expect(isNeverDowngradeModel('kimi-k2.7-code')).toBe(true);
        expect(isNeverDowngradeModel('moonshotai/kimi-k2')).toBe(true);
        expect(isNeverDowngradeModel('Moonshot-v1-128k')).toBe(true);
    });
    it('does not match unrelated models', () => {
        expect(isNeverDowngradeModel('gpt-5')).toBe(false);
        expect(isNeverDowngradeModel('claude-opus-5')).toBe(false);
    });
});
