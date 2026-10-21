import { isOpenAiHost, servedByOpenAi } from './endpoint';

describe('providers/openai/endpoint', () => {
    it('knows OpenAI by its API host, whatever the path', () => {
        expect(isOpenAiHost('https://api.openai.com/v1')).toBe(true);
        expect(isOpenAiHost('https://API.OpenAI.com')).toBe(true);
        expect(isOpenAiHost(undefined)).toBe(false);
        expect(isOpenAiHost('not a url')).toBe(false);
        // A gateway, a proxy or Azure may not serve /v1/responses.
        expect(isOpenAiHost('https://litellm.example.com/v1')).toBe(false);
        expect(
            isOpenAiHost('https://gateway.ai.cloudflare.com/v1/acct/gw/openai'),
        ).toBe(false);
        expect(
            isOpenAiHost('https://my-resource.openai.azure.com/openai/v1'),
        ).toBe(false);
        expect(isOpenAiHost('https://api.openai.com.evil.example/v1')).toBe(
            false,
        );
    });

    it('sends only OpenAI reasoning models on OpenAI itself to the native SDK', () => {
        expect(servedByOpenAi('gpt-6-sol', 'https://api.openai.com/v1')).toBe(
            true,
        );
        expect(
            servedByOpenAi('gpt-5.6-terra', 'https://api.openai.com/v1'),
        ).toBe(true);
        expect(servedByOpenAi('o4-mini', 'https://api.openai.com/v1')).toBe(
            true,
        );
        // No reasoning_effort goes out for these, so chat completions serves them.
        expect(servedByOpenAi('gpt-4o', 'https://api.openai.com/v1')).toBe(
            false,
        );
        expect(
            servedByOpenAi('gpt-6-sol', 'https://litellm.example.com/v1'),
        ).toBe(false);
        expect(
            servedByOpenAi('deepseek-v4-flash', 'https://api.openai.com/v1'),
        ).toBe(false);
    });
});
