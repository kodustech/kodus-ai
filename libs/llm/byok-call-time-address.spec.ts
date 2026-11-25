/**
 * A BYOK base URL is checked when the key is saved or tested, but a review call
 * happens later, and the host's DNS can answer differently by then. The review
 * call itself must refuse a host that NOW resolves to a private or reserved
 * address, for every provider whose base URL comes from the org.
 *
 * No external network and no real DNS: `dns.lookup` is replaced, and the only
 * listener is a local HTTP server that counts what reaches it. The base URL
 * names `localhost` so that, without a call-time check, the request goes to that
 * server (the system resolves `localhost` from the hosts file) and the count
 * shows it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dns from 'dns';
import { generateText } from 'ai';
import { REGISTRY } from '@libs/llm/providers';
import { classifyLLMError, LlmErrorCategory } from '@libs/llm/error-classifier';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { buildModelFromSlot } from './byok-to-vercel';

jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
}));

jest.mock('dns', () => {
    const actual = jest.requireActual('dns');
    return { ...actual, lookup: jest.fn() };
});

const mockLookup = dns.lookup as unknown as jest.Mock;

/** Every provider id whose settings let the org type a base URL. */
const USER_BASE_URL_PROVIDERS = REGISTRY.ids().filter((id) => {
    const shape = (REGISTRY.get(id).settingsSchema as any)?.shape ?? {};
    return 'baseURL' in shape;
});

let server: Server;
let port: number;
let requests: string[];

beforeAll(async () => {
    server = createServer((req, res) => {
        requests.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        res.end(
            JSON.stringify({
                id: 'x',
                object: 'chat.completion',
                created: 0,
                model: 'm',
                choices: [
                    {
                        index: 0,
                        message: { role: 'assistant', content: 'pong' },
                        finish_reason: 'stop',
                    },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
        );
    });
    await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
    );
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

beforeEach(() => {
    requests = [];
    mockLookup.mockReset();
    // The host now answers a private address (a stored URL that passed its
    // save-time check and was re-pointed afterwards looks exactly like this).
    mockLookup.mockImplementation((_host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const all = typeof options === 'object' && options?.all;
        return all
            ? cb(null, [{ address: '127.0.0.1', family: 4 }])
            : cb(null, '127.0.0.1', 4);
    });
});

function messages(err: unknown): string {
    const out: string[] = [];
    let cur: any = err;
    for (let i = 0; cur && i < 8; i++) {
        out.push(String(cur.message ?? cur));
        if (Array.isArray(cur.errors)) {
            out.push(...cur.errors.map((e: any) => String(e?.message ?? e)));
        }
        cur = cur.cause;
    }
    return out.join(' | ');
}

describe('a review call re-checks the BYOK gateway address when it connects', () => {
    it('covers every provider that takes a user base URL', () => {
        expect(USER_BASE_URL_PROVIDERS).toEqual(
            expect.arrayContaining([
                'openai',
                'openai_compatible',
                'anthropic',
                'anthropic_compatible',
                'google_gemini',
                'open_router',
                'moonshot',
                'zai',
                'novita',
                'azure',
            ]),
        );
    });

    it.each(USER_BASE_URL_PROVIDERS)(
        '%s: a host that now resolves to a private address is refused, and nothing reaches it',
        async (provider) => {
            const slot = {
                provider,
                apiKey: 'sk-test',
                model: 'test-model',
                baseURL: `http://localhost:${port}/v1`,
            } as unknown as NormalizedModel;

            const error = await generateText({
                model: buildModelFromSlot(slot) as any,
                prompt: 'ping',
                maxRetries: 0,
            }).then(
                () => undefined,
                (e: unknown) => e,
            );

            expect(requests).toEqual([]);
            expect(messages(error)).toMatch(/private or reserved address/);
        },
    );
});

describe("the refusal reads as the org's configuration, not a transient failure", () => {
    it('is CONFIG_INVALID (no retry, no fallback) and says why', async () => {
        const slot = {
            provider: 'openai_compatible',
            apiKey: 'sk-test',
            model: 'test-model',
            baseURL: `http://localhost:${port}/v1`,
        } as unknown as NormalizedModel;
        const error = await generateText({
            model: buildModelFromSlot(slot) as any,
            prompt: 'ping',
            maxRetries: 0,
        }).then(
            () => undefined,
            (e: unknown) => e,
        );
        const info = classifyLLMError(error);
        expect(info.category).toBe(LlmErrorCategory.CONFIG_INVALID);
        expect(info.friendlyMessage).toMatch(/private or reserved address/);
    });
});

describe('a gateway the self-hosted operator allowed runs the review call (#2381)', () => {
    const saved = process.env.API_ALLOWED_PRIVATE_HOSTS;
    afterEach(() => {
        if (saved === undefined) delete process.env.API_ALLOWED_PRIVATE_HOSTS;
        else process.env.API_ALLOWED_PRIVATE_HOSTS = saved;
    });

    // Every provider that takes a base URL: the call reaches the gateway. The
    // local server answers chat completions only, so a provider on another
    // protocol (native OpenAI's Responses API, Anthropic, Gemini) gets a reply
    // it cannot parse; what is checked here is that it was not refused.
    it.each(USER_BASE_URL_PROVIDERS)(
        '%s: an allowed host:port is reached',
        async (provider) => {
            process.env.API_ALLOWED_PRIVATE_HOSTS = `localhost:${port}`;
            const slot = {
                provider,
                apiKey: 'sk-test',
                model: 'test-model',
                baseURL: `http://localhost:${port}/v1`,
            } as unknown as NormalizedModel;
            const error = await generateText({
                model: buildModelFromSlot(slot) as any,
                prompt: 'ping',
                maxRetries: 0,
            }).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(requests).toHaveLength(1);
            expect(messages(error)).not.toMatch(/private or reserved address/);
        },
    );
});
