/**
 * The Gemini module honors the transport it is given.
 *
 * `ProviderBuildOptions.fetch` is how the connection probe refuses redirects on
 * a user-typed endpoint, and how a test keeps a call off the network. Gemini
 * accepts a user baseURL, so dropping the option sent the request to the real
 * host through the global fetch instead.
 *
 * Every fetch here throws before a response exists, so nothing leaves the
 * process.
 */
import { googleGeminiModule } from './index';
import type { ProviderBuildConfig } from '../kernel/types';

const cfg = (over: Partial<ProviderBuildConfig> = {}): ProviderBuildConfig =>
    ({
        provider: 'google_gemini',
        apiKey: 'fake-gemini-key',
        model: 'gemini-3.5-flash',
        ...over,
    }) as ProviderBuildConfig;

const PROMPT: any = [{ role: 'user', content: [{ type: 'text', text: '.' }] }];

/** A transport that records the request and stops it. */
function recordingFetch() {
    const urls: string[] = [];
    const fn = jest.fn(async (url: unknown) => {
        urls.push(String(url));
        throw new Error('captured; nothing is sent');
    });
    return { fetch: fn as unknown as typeof fetch, fn, urls };
}

async function callOnce(model: unknown): Promise<void> {
    try {
        await (model as any).doGenerate({ prompt: PROMPT });
    } catch {
        // The recording fetch always stops the call.
    }
}

describe('googleGeminiModule.build with an injected fetch', () => {
    let globalFetch: jest.SpyInstance;

    beforeEach(() => {
        // A default-path leak reaches this spy instead of Google.
        globalFetch = jest
            .spyOn(globalThis, 'fetch')
            .mockRejectedValue(new Error('global fetch reached'));
    });

    afterEach(() => {
        globalFetch.mockRestore();
    });

    it('sends generateContent through the injected fetch, not the global one', async () => {
        const injected = recordingFetch();

        await callOnce(
            googleGeminiModule.build(cfg(), { fetch: injected.fetch }),
        );

        expect(injected.fn).toHaveBeenCalledTimes(1);
        expect(injected.urls[0]).toMatch(
            /generativelanguage\.googleapis\.com\/.*gemini-3\.5-flash:generateContent/,
        );
        expect(globalFetch).not.toHaveBeenCalled();
    });

    it('keeps a user baseURL when a fetch is injected', async () => {
        const injected = recordingFetch();

        await callOnce(
            googleGeminiModule.build(
                cfg({ baseURL: 'https://gemini-proxy.example.test/v1beta' }),
                { fetch: injected.fetch },
            ),
        );

        expect(injected.urls[0]).toMatch(
            /^https:\/\/gemini-proxy\.example\.test\/v1beta\/models\/gemini-3\.5-flash:generateContent/,
        );
    });

    it('still uses the global fetch when none is injected', async () => {
        await callOnce(googleGeminiModule.build(cfg()));

        expect(globalFetch).toHaveBeenCalledTimes(1);
        expect(String(globalFetch.mock.calls[0][0])).toMatch(
            /generativelanguage\.googleapis\.com/,
        );
    });
});
