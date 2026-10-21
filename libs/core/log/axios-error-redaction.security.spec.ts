/**
 * AxiosError credential redaction through the real pino `err` serializer.
 *
 * An AxiosError carries the live Node ClientRequest, whose `_header` is the
 * raw request head as ONE string ("POST /x HTTP/1.1\r\nAuthorization: Basic
 * ...\r\n"). deepSanitize redacted by key name only, so a credential inside
 * that string reached production logs in clear text (an Azure DevOps PAT).
 * Secrets carried in a URL query string (`?token=`) or inside a JSON-string
 * request body leaked the same way.
 *
 * A failing assertion here is a REAL leak, NOT a test to relax.
 */
import { AddressInfo } from 'net';
import * as http from 'http';

import axios from 'axios';
import pino from 'pino';

const { deepSanitize, sanitizeString, SENSITIVE_KEYS, KEY_SENSITIVITY_CACHE } =
    jest.requireActual('@libs/core/log/logger') as {
        deepSanitize: (obj: any) => any;
        sanitizeString: (value: string) => string;
        SENSITIVE_KEYS: Set<string>;
        KEY_SENSITIVITY_CACHE: Map<string, boolean>;
    };

const FAKE_PAT = 'fake-pat-0000000000000000000000000000000000000000000000000000';
const FAKE_WEBHOOK_TOKEN = '00112233445566778899aabbccddeeff:deadbeefdeadbeef';
const FAKE_CLIENT_SECRET = 'fake-client-secret-1234567890';

function serializeLikeLogger(err: unknown) {
    return deepSanitize(pino.stdSerializers.err(err as Error));
}

describe('logger err serializer — AxiosError credential leaks', () => {
    let server: http.Server;
    let baseURL: string;

    beforeAll(async () => {
        server = http.createServer((req, res) => {
            if (req.url?.startsWith('/hang')) {
                return; // never answers, so the client times out
            }
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ message: 'Access Denied' }));
        });
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    async function captureAxiosError(): Promise<unknown> {
        const basic = Buffer.from(`:${FAKE_PAT}`).toString('base64');
        try {
            await axios.post(
                `${baseURL}/_apis/hooks/subscriptions?api-version=7.1`,
                {
                    clientSecret: FAKE_CLIENT_SECRET,
                    consumerInputs: {
                        url: `https://webhooks.example.com/azure-repos/webhook?token=${encodeURIComponent(FAKE_WEBHOOK_TOKEN)}`,
                    },
                },
                { headers: { Authorization: `Basic ${basic}` } },
            );
        } catch (error) {
            return error;
        }
        throw new Error('expected the request to fail');
    }

    it('does not leak the Authorization header from the raw request head', async () => {
        const error = await captureAxiosError();
        const basic = Buffer.from(`:${FAKE_PAT}`).toString('base64');

        const serialized = JSON.stringify(serializeLikeLogger(error));

        expect(serialized).not.toContain(basic);
        expect(serialized).not.toContain(FAKE_PAT);
    });

    it('does not leak secrets from the JSON-string request body', async () => {
        const error = await captureAxiosError();

        const serialized = JSON.stringify(serializeLikeLogger(error));

        expect(serialized).not.toContain(FAKE_WEBHOOK_TOKEN);
        expect(serialized).not.toContain(
            encodeURIComponent(FAKE_WEBHOOK_TOKEN),
        );
        expect(serialized).not.toContain(FAKE_CLIENT_SECRET);
    });

    it('keeps the fields needed to debug the failure', async () => {
        const error = await captureAxiosError();

        const out = serializeLikeLogger(error);

        expect(out.message).toBe('Request failed with status code 403');
        expect(out.response?.status).toBe(403);
        expect(out.response?.data).toEqual({ message: 'Access Denied' });
        expect(out.config?.method).toBe('post');
        expect(out.config?.url).toContain('/_apis/hooks/subscriptions');
    });

    it('does not leak the header or the body when the request times out', async () => {
        const basic = Buffer.from(`:${FAKE_PAT}`).toString('base64');
        let error: unknown;
        try {
            await axios.post(
                `${baseURL}/hang`,
                {
                    consumerInputs: {
                        url: `https://webhooks.example.com/hook?token=${encodeURIComponent(FAKE_WEBHOOK_TOKEN)}`,
                    },
                },
                { headers: { Authorization: `Basic ${basic}` }, timeout: 200 },
            );
        } catch (caught) {
            error = caught;
        }

        const serialized = JSON.stringify(serializeLikeLogger(error));

        expect((error as any)?.code).toBe('ECONNABORTED');
        // On a timeout axios attaches follow-redirects' wrapper, not the
        // native ClientRequest.
        expect(serializeLikeLogger(error).request).toBe('[RedirectableRequest]');
        expect(serialized).not.toContain(basic);
        expect(serialized).not.toContain(
            encodeURIComponent(FAKE_WEBHOOK_TOKEN),
        );
        // The body sits in `_requestBodyBuffers` as a Buffer; its bytes would
        // survive as a numeric array without the binary marker.
        expect(serialized).not.toContain('"type":"Buffer"');
    });

    it('does not leak the axios auth option when the request times out', async () => {
        let error: unknown;
        try {
            await axios.get(`${baseURL}/hang`, {
                auth: { username: 'svc-user', password: FAKE_CLIENT_SECRET },
                timeout: 200,
            });
        } catch (caught) {
            error = caught;
        }

        const serialized = JSON.stringify(serializeLikeLogger(error));

        expect((error as any)?.code).toBe('ECONNABORTED');
        expect(serialized).not.toContain(FAKE_CLIENT_SECRET);
    });

    it('replaces the live Node request/socket graph with a marker', async () => {
        const error = await captureAxiosError();

        const out = serializeLikeLogger(error);

        expect(out.request).toBe('[ClientRequest]');
        expect(out.response?.request).toBe('[ClientRequest]');
    });
});

describe('deepSanitize — binary values', () => {
    it('replaces a Buffer with a size marker instead of its bytes', () => {
        const out = deepSanitize({ body: Buffer.from('bytes-with-a-secret') });

        expect(out.body).toBe('[Binary 19 bytes]');
    });
});

describe('sanitizeString — secrets embedded in strings', () => {
    it('redacts sensitive raw header lines', () => {
        const head =
            'POST /x HTTP/1.1\r\nAccept: */*\r\nAuthorization: Bearer abc.def\r\nPRIVATE-TOKEN: glpat-xyz\r\nHost: example.com\r\n\r\n';

        const out = sanitizeString(head);

        expect(out).not.toContain('abc.def');
        expect(out).not.toContain('glpat-xyz');
        expect(out).toContain('Accept: */*');
        expect(out).toContain('Host: example.com');
    });

    it('redacts a sensitive header name written with separators', () => {
        const out = sanitizeString('api_key: k-secret\nX_API_KEY: k-secret2');

        expect(out).not.toContain('k-secret');
        expect(out).not.toContain('k-secret2');
    });

    it('redacts every name in SENSITIVE_KEYS when it carries a value in a string', () => {
        // The probe value must not contain a hint stem of its own, otherwise
        // it opens the gate by itself and this walk can never fail.
        let probe = 0;

        for (const key of SENSITIVE_KEYS) {
            const value = `pr0be-${probe++}`;

            expect(sanitizeString(`{"${key}":"${value}"}`)).not.toContain(
                value,
            );
            expect(sanitizeString(`${key}: ${value}`)).not.toContain(value);
        }
    });

    it('redacts header-like lines inside a unified diff', () => {
        const out = sanitizeString(
            '@@ -1,2 +1,2 @@\n-  token: old-value\n+  authorization: Bearer new-value\n   unchanged: kept',
        );

        expect(out).not.toContain('old-value');
        expect(out).not.toContain('new-value');
        expect(out).toContain('unchanged: kept');
    });

    it('redacts query-style secrets on added and removed diff lines', () => {
        const out = sanitizeString(
            '@@ -1 +1 @@\n-access_token=old-tok\n+access_token=new-tok\n+PRIVATE_TOKEN=gl-tok',
        );

        expect(out).not.toContain('old-tok');
        expect(out).not.toContain('new-tok');
        expect(out).not.toContain('gl-tok');
        expect(out).toContain('+access_token=[REDACTED]');
    });

    it('does not grow the key cache with names found inside strings', () => {
        const before = KEY_SENSITIVITY_CACHE.size;
        const payload = JSON.stringify(
            Object.fromEntries(
                Array.from({ length: 600 }, (_, i) => [`field_key_${i}`, 'x']),
            ),
        );

        sanitizeString(payload);

        expect(KEY_SENSITIVITY_CACHE.size).toBe(before);
    });

    it('redacts sensitive query-string and form parameters', () => {
        const out = sanitizeString(
            'https://api.example.com/cb?state=ok&access_token=tok123&client_secret=sec456 grant_type=refresh&refresh_token=rt789',
        );

        expect(out).not.toContain('tok123');
        expect(out).not.toContain('sec456');
        expect(out).not.toContain('rt789');
        expect(out).toContain('state=ok');
        expect(out).toContain('grant_type=refresh');
    });

    it('redacts sensitive keys inside a JSON string', () => {
        const out = sanitizeString(
            JSON.stringify({ name: 'repo', token: 'jsonTok', nested: { apiKey: 'k1' } }),
        );

        expect(out).not.toContain('jsonTok');
        expect(out).not.toContain('k1');
        expect(out).toContain('"name":"repo"');
    });

    it('returns the same reference for ordinary strings', () => {
        const stack =
            'AxiosError: Request failed with status code 403\n    at settle (/app/node_modules/axios/dist/node/axios.cjs:2090:12)';
        const message = 'Error creating/replacing hook: tokens used 42';

        expect(sanitizeString(stack)).toBe(stack);
        expect(sanitizeString(message)).toBe(message);
    });
});
