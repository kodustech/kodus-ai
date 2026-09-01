/**
 * Regression + contract: a key-only connect to an Anthropic-protocol BRAND
 * (Kimi/GLM, and any future one) must resolve the brand's canonical endpoint on
 * its own — the connect form carries no baseURL for a curated brand.
 *
 * Why this file exists: removing the curated catalog dropped `defaults.baseURL`,
 * and the connection probe — which had NO test — started throwing "baseURL is
 * required for moonshot". The coupling was indirect (catalog → web form → request
 * baseURL → probe), so a grep for direct `defaults.baseURL` readers missed it.
 * The endpoint now lives on the provider module (`defaultBaseURL`); this sweeps
 * EVERY brand that declares one, so a new brand is covered automatically and this
 * whole class of regression can't come back silently.
 *
 * The probe no longer builds requests itself — it hands a slot to
 * `probeSlotCall`, which runs the review's own montagem. So these assert what
 * this use-case is actually responsible for: the SLOT it assembles. That the
 * slot then produces the right request is `probe-slot-call.spec` plus the
 * provider modules' own specs.
 */

//
import { REGISTRY } from '@libs/llm/providers';
import { BadRequestException } from '@nestjs/common';
import {
    TestByokConnectionUseCase,
    assertSafeOpenAICompatibleUrl,
} from './test-byok-connection.use-case';
import { lookup as dnsLookup } from 'dns/promises';

jest.mock('dns/promises', () => ({
    lookup: jest
        .fn()
        .mockResolvedValue([{ address: '203.0.113.10', family: 4 }]),
}));

const probeSlotCall = jest.fn();
jest.mock('@libs/llm/probe-slot-call', () => ({
    probeSlotCall: (...args: any[]) => probeSlotCall(...args),
}));

// The slot carries ciphertext by contract; decryption happens in the model
// build. Stub the crypto so a test doesn't need a real key configured.
jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => `enc(${v})`,
    decrypt: (v: string) => v,
}));

function useCase() {
    const providerService = { isProviderSupported: () => true } as any;
    return new TestByokConnectionUseCase(providerService);
}

const probedSlot = () => probeSlotCall.mock.calls[0][0];

// Every brand that declares a canonical endpoint — the exact set whose key-only
// connect depends on the module supplying baseURL. Derived from the registry, so
// a new brand joins this matrix the moment it ships.
const BRANDS_WITH_ENDPOINT = REGISTRY.all()
    .filter((m) => typeof m.defaultBaseURL === 'string' && m.defaultBaseURL)
    .map((m) => [m.id, m.defaultBaseURL as string] as const);

beforeEach(() => {
    probeSlotCall.mockReset();
    probeSlotCall.mockResolvedValue({ latencyMs: 12 });
});

describe('brands expose their canonical endpoint on the module', () => {
    it('at least the two Anthropic-protocol brands are present', () => {
        const ids = BRANDS_WITH_ENDPOINT.map(([id]) => id);
        expect(ids).toEqual(expect.arrayContaining(['moonshot', 'zai']));
    });

    it.each(BRANDS_WITH_ENDPOINT)(
        '%s → defaultBaseURL is a valid https URL',
        (_id, baseURL) => {
            expect(() => new URL(baseURL)).not.toThrow();
            expect(baseURL.startsWith('https://')).toBe(true);
        },
    );
});

describe('TestByokConnectionUseCase — key-only brand connect resolves the endpoint', () => {
    // The regression itself, swept over every brand: a key + NO baseURL must probe
    // the brand's own host, never throw "baseURL is required".
    it.each(BRANDS_WITH_ENDPOINT)(
        '%s: key-only (no baseURL) probes its own host, no 400',
        async (id, baseURL) => {
            const res = await useCase().execute({
                provider: id,
                apiKey: 'sk-test',
                model: 'some-model',
            });

            expect(res.ok).toBe(true);
            expect(probedSlot().baseURL).toBe(baseURL);
        },
    );

    it('a generic anthropic_compatible (no brand endpoint) still requires baseURL', async () => {
        await expect(
            useCase().execute({
                provider: 'anthropic_compatible',
                apiKey: 'sk-test',
                model: 'some-model',
            }),
        ).rejects.toThrow(/baseURL is required/i);
    });
});

// Fix 2 — the Test validates the configured tuning against the model's rules and
// returns a client error BEFORE any network round-trip, so a value the runtime
// would silently drop (an always-thinking Kimi ignores a non-1 temperature) fails
// the Test instead of saving quiet.
describe('TestByokConnectionUseCase — tuning validation short-circuits the probe', () => {
    it('kimi-k2.7-code + temperature 0.2 → bad_request, no call', async () => {
        const res = await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'kimi-k2.7-code',
            temperature: 0.2,
        });
        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(res.message).toContain('1');
        expect(probeSlotCall).not.toHaveBeenCalled();
    });

    it('kimi-k2.7-code + reasoningEffort "none" → bad_request, no call', async () => {
        const res = await useCase().execute({
            provider: 'anthropic_compatible',
            apiKey: 'sk-test',
            baseURL: 'https://api.moonshot.ai/anthropic',
            model: 'kimi-k2.7-code',
            reasoningEffort: 'none',
        });
        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(probeSlotCall).not.toHaveBeenCalled();
    });

    it('kimi-k2.7-code + temperature 1 (matches the pin) → proceeds to probe', async () => {
        const res = await useCase().execute({
            provider: 'novita',
            apiKey: 'sk-test',
            model: 'kimi-k2.7-code',
            temperature: 1,
        });
        expect(res.ok).toBe(true);
        expect(probeSlotCall).toHaveBeenCalled();
    });
});

/**
 * The point of the refactor: the Test proves the config being SAVED. Every
 * field the save persists rides the probed slot, so a value the provider will
 * reject fails here rather than on the first review.
 */
describe('TestByokConnectionUseCase — the probe runs the config being saved', () => {
    it('carries the advanced settings, not just the key and model', async () => {
        await useCase().execute({
            provider: 'open_router',
            apiKey: 'sk-test',
            model: 'anthropic/claude-x',
            temperature: 0.3,
            reasoningEffort: 'high',
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ['anthropic'],
            openrouterAllowFallbacks: false,
        });

        expect(probedSlot()).toMatchObject({
            provider: 'open_router',
            model: 'anthropic/claude-x',
            temperature: 0.3,
            reasoningEffort: 'high',
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ['anthropic'],
            openrouterAllowFallbacks: false,
        });
    });

    it('hands the builder ciphertext, keeping the slot contract intact', async () => {
        await useCase().execute({
            provider: 'openai',
            apiKey: 'sk-plaintext',
            model: 'gpt-x',
        });

        expect(probedSlot().apiKey).toBe('enc(sk-plaintext)');
        expect(probedSlot().apiKey).not.toBe('sk-plaintext');
    });

    // A probe without a model could only answer "is the key valid?" — the weaker
    // question this refactor exists to stop answering.
    it('refuses to run without a model instead of testing something else', async () => {
        const res = await useCase().execute({
            provider: 'openai',
            apiKey: 'sk-test',
        });

        expect(res.ok).toBe(false);
        expect(res.code).toBe('bad_request');
        expect(res.message).toMatch(/model/i);
        expect(probeSlotCall).not.toHaveBeenCalled();
    });
});

// ---------------------------------------------------------------------------
// Mutation-killing coverage of the deterministic helpers. These assert exact
// return shapes, both sides of every branch, and the numeric boundaries so a
// flipped comparator or a swapped literal fails the suite.
// ---------------------------------------------------------------------------

const mockLookup = dnsLookup as unknown as jest.Mock;

describe('assertSafeOpenAICompatibleUrl — protocol + URL parsing guards', () => {
    it('rejects a syntactically invalid URL', async () => {
        await expect(
            assertSafeOpenAICompatibleUrl('not a url'),
        ).rejects.toThrow(/not a valid URL/i);
    });

    it('rejects a non-https scheme (http)', async () => {
        await expect(
            assertSafeOpenAICompatibleUrl('http://example.com'),
        ).rejects.toThrow(/must use https/i);
    });

    it('rejects a non-https scheme (file)', async () => {
        await expect(
            assertSafeOpenAICompatibleUrl('file:///etc/passwd'),
        ).rejects.toThrow(/must use https/i);
    });

    it('throws BadRequestException specifically for a bad scheme', async () => {
        await expect(
            assertSafeOpenAICompatibleUrl('ftp://example.com'),
        ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects when DNS resolution fails', async () => {
        mockLookup.mockRejectedValueOnce(new Error('ENOTFOUND'));
        await expect(
            assertSafeOpenAICompatibleUrl('https://nope.example.com'),
        ).rejects.toThrow(/Couldn't resolve host/i);
    });

    it('resolves (no throw) for an https host that maps to a public IP', async () => {
        mockLookup.mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);
        await expect(
            assertSafeOpenAICompatibleUrl('https://api.example.com'),
        ).resolves.toBeUndefined();
    });

    it('rejects when ANY resolved address is private, even if another is public', async () => {
        mockLookup.mockResolvedValueOnce([
            { address: '8.8.8.8', family: 4 },
            { address: '10.0.0.1', family: 4 },
        ]);
        await expect(
            assertSafeOpenAICompatibleUrl('https://api.example.com'),
        ).rejects.toThrow(/private or reserved/i);
    });

    it('resolves when every resolved address is public', async () => {
        mockLookup.mockResolvedValueOnce([
            { address: '8.8.8.8', family: 4 },
            { address: '203.0.113.10', family: 4 },
        ]);
        await expect(
            assertSafeOpenAICompatibleUrl('https://api.example.com'),
        ).resolves.toBeUndefined();
    });
});

describe('isPrivateOrReservedIp — via the SSRF guard, both verdicts', () => {
    // Private / reserved addresses MUST be rejected.
    const PRIVATE: [string, string][] = [
        ['0.0.0.0 (unspecified)', '0.0.0.0'],
        ['127.0.0.1 (loopback)', '127.0.0.1'],
        ['127.255.255.255 (loopback range)', '127.255.255.255'],
        ['10.x (RFC1918)', '10.1.2.3'],
        ['192.168.x (RFC1918)', '192.168.1.1'],
        ['169.254.169.254 (cloud metadata)', '169.254.169.254'],
        ['100.64.x (CGNAT)', '100.64.0.1'],
        ['172.16 boundary (RFC1918 low)', '172.16.0.1'],
        ['172.31 boundary (RFC1918 high)', '172.31.255.255'],
        ['172.24 (mid RFC1918)', '172.24.5.5'],
        ['::1 (IPv6 loopback)', '::1'],
        [':: (IPv6 unspecified)', '::'],
        ['fc00::/7 ULA (fc)', 'fc00::1'],
        ['fc00::/7 ULA (fd)', 'fd12:3456::1'],
        ['fe80::/10 link-local', 'fe80::1'],
    ];

    it.each(PRIVATE)('rejects %s', async (_label, ip) => {
        mockLookup.mockResolvedValueOnce([{ address: ip, family: 4 }]);
        await expect(
            assertSafeOpenAICompatibleUrl('https://host.example.com'),
        ).rejects.toThrow(/private or reserved/i);
    });

    // Public / non-reserved addresses MUST pass — these pin the boundaries so
    // `>=`/`<=` and prefix mutants die.
    const PUBLIC: [string, string][] = [
        ['8.8.8.8', '8.8.8.8'],
        ['203.0.113.10', '203.0.113.10'],
        ['172.15.0.1 (just below RFC1918)', '172.15.0.1'],
        ['172.32.0.1 (just above RFC1918)', '172.32.0.1'],
        ['11.0.0.1 (not 10.)', '11.0.0.1'],
        ['128.168.0.1 (not 192.168.)', '128.168.0.1'],
        ['100.63.0.1 (just below CGNAT block)', '100.63.0.1'],
        ['169.253.0.1 (not link-local)', '169.253.0.1'],
        ['2001:db8::1 (public IPv6)', '2001:db8::1'],
        ['fb00::1 (not ULA)', 'fb00::1'],
        ['fe70::1 (not link-local)', 'fe70::1'],
    ];

    it.each(PUBLIC)('accepts %s', async (_label, ip) => {
        mockLookup.mockResolvedValueOnce([{ address: ip, family: 4 }]);
        await expect(
            assertSafeOpenAICompatibleUrl('https://host.example.com'),
        ).resolves.toBeUndefined();
    });
});

describe('assertSafeRegion — via testBedrockBearer (guard runs before any fetch)', () => {
    let origFetch: typeof global.fetch;

    beforeEach(() => {
        origFetch = global.fetch;
        // A valid region passes the guard and reaches fetch; make it succeed so
        // the "no throw" branch produces a clean ok result.
        global.fetch = jest.fn().mockResolvedValue({
            ok: true,
            status: 200,
            text: async () => '',
        }) as any;
    });

    afterEach(() => {
        global.fetch = origFetch;
    });

    const bearer = (region: string) =>
        (useCase() as any).testBedrockBearer('tok', region);

    it('rejects an uppercase region', async () => {
        await expect(bearer('US-EAST-1')).rejects.toThrow(/Invalid region/i);
    });

    it('rejects a region with an underscore', async () => {
        await expect(bearer('us_east_1')).rejects.toThrow(/Invalid region/i);
    });

    it('rejects a region with a slash (path-traversal shape)', async () => {
        await expect(bearer('us/east')).rejects.toThrow(/Invalid region/i);
    });

    it('rejects a 1-char region (below the min of 2)', async () => {
        await expect(bearer('a')).rejects.toThrow(/Invalid region/i);
    });

    it('rejects a 33-char region (above the max of 32)', async () => {
        await expect(bearer('a'.repeat(33))).rejects.toThrow(/Invalid region/i);
    });

    it('throws a BadRequestException for an invalid region', async () => {
        await expect(bearer('BAD!')).rejects.toBeInstanceOf(
            BadRequestException,
        );
    });

    it('accepts a normal region (us-east-1) and reaches the probe', async () => {
        const res = await bearer('us-east-1');
        expect(res.ok).toBe(true);
        expect(res.code).toBe('ok');
        expect(global.fetch).toHaveBeenCalled();
    });

    it('accepts a 2-char region (min boundary)', async () => {
        await expect(bearer('ap')).resolves.toMatchObject({ ok: true });
    });

    it('accepts a 32-char region (max boundary)', async () => {
        await expect(bearer('a'.repeat(32))).resolves.toMatchObject({
            ok: true,
        });
    });
});

describe('parseXmlOrJson', () => {
    const parse = (body: string) => (useCase() as any).parseXmlOrJson(body);

    it('returns null for an empty body', () => {
        expect(parse('')).toBeNull();
    });

    it('parses a valid JSON object', () => {
        expect(parse('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
    });

    it('extracts the first <Message> block from XML when JSON parse fails', () => {
        expect(
            parse('<Error><Message>Access denied</Message></Error>'),
        ).toEqual({ message: 'Access denied' });
    });

    it('returns null for non-JSON, non-XML garbage', () => {
        expect(parse('totally not structured')).toBeNull();
    });

    it('returns null when XML has no <Message> tag', () => {
        expect(parse('<Error><Code>Boom</Code></Error>')).toBeNull();
    });
});

describe('extractProviderMessage', () => {
    const extract = (data: unknown) =>
        (useCase() as any).extractProviderMessage(data);

    it('returns undefined for null / undefined', () => {
        expect(extract(null)).toBeUndefined();
        expect(extract(undefined)).toBeUndefined();
    });

    it('returns undefined for an empty string', () => {
        expect(extract('')).toBeUndefined();
    });

    it('returns undefined for a whitespace-only string (length guard)', () => {
        expect(extract('    ')).toBeUndefined();
    });

    it('returns a trimmed short string body verbatim', () => {
        expect(extract('  boom  ')).toBe('boom');
    });

    it('returns a 499-char string (just under the 500 cap)', () => {
        const s = 'a'.repeat(499);
        expect(extract(s)).toBe(s);
    });

    it('returns undefined for a 500-char string (at the cap)', () => {
        expect(extract('a'.repeat(500))).toBeUndefined();
    });

    it('returns undefined for a non-object, non-string value', () => {
        expect(extract(42)).toBeUndefined();
    });

    it('reads error.message (OpenAI/Anthropic shape) with trimming', () => {
        expect(extract({ error: { message: '  model x not found  ' } })).toBe(
            'model x not found',
        );
    });

    it('prefers error.message over a top-level message', () => {
        expect(
            extract({ error: { message: 'from error' }, message: 'top' }),
        ).toBe('from error');
    });

    it('reads a string error field', () => {
        expect(extract({ error: '  plain error  ' })).toBe('plain error');
    });

    it('falls back to a top-level message', () => {
        expect(extract({ message: '  top-level  ' })).toBe('top-level');
    });

    it("reads Gemini's google.rpc.Status details[0].reason", () => {
        expect(
            extract({ error: { details: [{ reason: 'RESOURCE_EXHAUSTED' }] } }),
        ).toBe('RESOURCE_EXHAUSTED');
    });

    it('returns undefined when details[0] has no reason', () => {
        expect(extract({ error: { details: [{}] } })).toBeUndefined();
    });

    it('returns undefined when details is empty', () => {
        expect(extract({ error: { details: [] } })).toBeUndefined();
    });

    it('returns undefined for an object with no recognizable message', () => {
        expect(extract({ foo: 'bar' })).toBeUndefined();
    });
});

describe('buildBedrockError', () => {
    const build = (status: number, body: string, region?: string) =>
        (useCase() as any).buildBedrockError(status, body, Date.now(), region);

    it('maps 401 to auth and surfaces the provider message', () => {
        const res = build(401, '{"message":"bad creds"}');
        expect(res).toMatchObject({
            ok: false,
            code: 'auth',
            httpStatus: 401,
            providerMessage: 'bad creds',
        });
        expect(res.message).toMatch(/AWS rejected the credentials/i);
        expect(typeof res.latencyMs).toBe('number');
    });

    it('maps 403 to auth', () => {
        expect(build(403, '')).toMatchObject({ ok: false, code: 'auth' });
    });

    it('maps 404 to not_found with the region in the message', () => {
        const res = build(404, '', 'sa-east-1');
        expect(res).toMatchObject({
            ok: false,
            code: 'not_found',
            httpStatus: 404,
        });
        expect(res.message).toContain('sa-east-1');
    });

    it('maps 404 to not_found with a generic message when region is absent', () => {
        const res = build(404, '');
        expect(res.code).toBe('not_found');
        expect(res.message).toBe('Bedrock endpoint not found.');
    });

    it('maps any other status to server_error with the status in the message', () => {
        const res = build(500, '');
        expect(res).toMatchObject({
            ok: false,
            code: 'server_error',
            httpStatus: 500,
        });
        expect(res.message).toContain('500');
    });

    it('falls back to the raw body slice when no structured message exists', () => {
        const res = build(500, 'raw upstream failure text');
        expect(res.providerMessage).toBe('raw upstream failure text');
    });

    it('leaves providerMessage undefined for an empty body', () => {
        const res = build(500, '');
        expect(res.providerMessage).toBeUndefined();
    });
});

describe('normalizeError → fromHttpStatus mapping (via AI SDK error facts)', () => {
    const normalize = (err: unknown, latencyMs = 7) =>
        (useCase() as any).normalizeError(err, latencyMs);

    const sdkErr = (statusCode: number, message = 'provider says no') => ({
        name: 'AI_APICallError',
        message,
        statusCode,
        responseBody: { error: { message } },
    });

    it('401 → auth', () => {
        expect(normalize(sdkErr(401))).toMatchObject({
            ok: false,
            code: 'auth',
            httpStatus: 401,
            providerMessage: 'provider says no',
            latencyMs: 7,
        });
    });

    it('403 → auth', () => {
        expect(normalize(sdkErr(403)).code).toBe('auth');
    });

    it('404 → not_found', () => {
        expect(normalize(sdkErr(404)).code).toBe('not_found');
    });

    it('400 → bad_request', () => {
        expect(normalize(sdkErr(400)).code).toBe('bad_request');
    });

    it('402 → payment', () => {
        expect(normalize(sdkErr(402)).code).toBe('payment');
    });

    it('429 → rate_limit AND ok:true (throttle still means the key works)', () => {
        const res = normalize(sdkErr(429));
        expect(res.code).toBe('rate_limit');
        expect(res.ok).toBe(true);
    });

    it('500 → server_error (>= 500 boundary, low end)', () => {
        expect(normalize(sdkErr(500)).code).toBe('server_error');
    });

    it('499 → unknown (just below the 500 boundary)', () => {
        expect(normalize(sdkErr(499)).code).toBe('unknown');
    });

    it('418 (unclassified with a status) → unknown, message names the status', () => {
        const res = normalize(sdkErr(418));
        expect(res.code).toBe('unknown');
        expect(res.message).toContain('418');
    });

    it('reads statusCode nested under cause and the nested body', () => {
        const res = normalize({
            name: 'APICallError',
            cause: {
                statusCode: 404,
                responseBody: { error: { message: 'no such model' } },
            },
        });
        expect(res).toMatchObject({
            code: 'not_found',
            httpStatus: 404,
            providerMessage: 'no such model',
        });
    });

    it('an AI_APICallError with no status → unknown, no-status message', () => {
        const res = normalize({ name: 'AI_APICallError' });
        expect(res.code).toBe('unknown');
        expect(res.httpStatus).toBeUndefined();
        expect(res.message).toMatch(/couldn't classify/i);
    });
});

describe('normalizeError — axios and transport-level branches', () => {
    const normalize = (err: unknown, latencyMs = 5) =>
        (useCase() as any).normalizeError(err, latencyMs);

    const axiosErr = (extra: Record<string, unknown>) => ({
        isAxiosError: true,
        ...extra,
    });

    it('axios error with an HTTP status maps through fromHttpStatus', () => {
        const res = normalize(
            axiosErr({
                response: { status: 401, data: { error: { message: 'nope' } } },
            }),
        );
        expect(res).toMatchObject({
            code: 'auth',
            httpStatus: 401,
            providerMessage: 'nope',
        });
    });

    it('axios ECONNABORTED → network (timeout wording)', () => {
        const res = normalize(axiosErr({ code: 'ECONNABORTED' }));
        expect(res.code).toBe('network');
        expect(res.message).toMatch(/timed out/i);
    });

    it('axios ETIMEDOUT → network (timeout wording)', () => {
        expect(normalize(axiosErr({ code: 'ETIMEDOUT' })).code).toBe('network');
    });

    it('axios ECONNREFUSED → network, message names the code', () => {
        const res = normalize(axiosErr({ code: 'ECONNREFUSED' }));
        expect(res.code).toBe('network');
        expect(res.message).toContain('ECONNREFUSED');
    });

    it('axios ENOTFOUND → network', () => {
        expect(normalize(axiosErr({ code: 'ENOTFOUND' })).code).toBe('network');
    });

    it('axios EAI_AGAIN → network', () => {
        expect(normalize(axiosErr({ code: 'EAI_AGAIN' })).code).toBe('network');
    });

    it('axios error with no status and an unrecognized code → unknown', () => {
        const res = normalize(axiosErr({ code: 'ESOMETHING' }));
        expect(res.code).toBe('unknown');
    });

    it('an AbortError (our own timeout) → network', () => {
        const res = normalize({ name: 'AbortError' });
        expect(res.code).toBe('network');
        expect(res.message).toMatch(/timed out/i);
    });

    it('a plain Error → unknown, preserving its message', () => {
        const res = normalize(new Error('kaboom'));
        expect(res).toMatchObject({
            ok: false,
            code: 'unknown',
            latencyMs: 5,
            message: 'kaboom',
        });
    });

    it('an error object with no message → unknown with the default message', () => {
        const res = normalize({});
        expect(res.code).toBe('unknown');
        expect(res.message).toBe(
            'Unexpected error while testing the connection.',
        );
    });
});

describe('slotFromInput — the persisted slot shape', () => {
    const slot = (input: any, baseURL?: string) =>
        (useCase() as any).slotFromInput(input, baseURL);

    it('encrypts the apiKey (never hands the builder plaintext)', () => {
        const s = slot({ provider: 'openai', apiKey: 'sk-secret' });
        expect(s.apiKey).toBe('enc(sk-secret)');
        expect(s.apiKey).not.toBe('sk-secret');
    });

    it('encrypts an empty string when apiKey is missing', () => {
        expect(slot({ provider: 'openai' }).apiKey).toBe('enc()');
    });

    it('trims the model', () => {
        expect(slot({ provider: 'openai', model: '  gpt-x  ' }).model).toBe(
            'gpt-x',
        );
    });

    it('defaults model to an empty string when absent', () => {
        expect(slot({ provider: 'openai' }).model).toBe('');
    });

    it('trims a provided baseURL', () => {
        expect(
            slot({ provider: 'openai' }, '  https://api.x.com  ').baseURL,
        ).toBe('https://api.x.com');
    });

    it('coerces a whitespace-only baseURL to undefined', () => {
        expect(slot({ provider: 'openai' }, '   ').baseURL).toBeUndefined();
    });

    it('leaves baseURL undefined when none is given', () => {
        expect(slot({ provider: 'openai' }).baseURL).toBeUndefined();
    });

    it('passes every advanced field through unchanged', () => {
        const input = {
            provider: 'open_router',
            apiKey: 'sk',
            model: 'anthropic/claude-x',
            temperature: 0.3,
            reasoningEffort: 'high',
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ['anthropic', 'google'],
            openrouterAllowFallbacks: false,
            vertexLocation: 'global',
            awsBearerToken: 'bt',
            awsAccessKeyId: 'ak',
            awsSecretAccessKey: 'sk2',
            awsRegion: 'us-east-1',
            awsSessionToken: 'st',
        };
        expect(slot(input, 'https://api.x.com')).toEqual({
            provider: 'open_router',
            apiKey: 'enc(sk)',
            model: 'anthropic/claude-x',
            baseURL: 'https://api.x.com',
            temperature: 0.3,
            reasoningEffort: 'high',
            reasoningConfigOverride: '{"reasoning":{"effort":"high"}}',
            maxOutputTokens: 2048,
            openrouterProviderOrder: ['anthropic', 'google'],
            openrouterAllowFallbacks: false,
            vertexLocation: 'global',
            awsBearerToken: 'bt',
            awsAccessKeyId: 'ak',
            awsSecretAccessKey: 'sk2',
            awsRegion: 'us-east-1',
            awsSessionToken: 'st',
        });
    });
});
