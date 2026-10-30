import axios from 'axios';

import {
    BILLING_SIGNATURE_HEADER,
    BILLING_TIMESTAMP_HEADER,
    billingSignatureHeaders,
    billingSignaturePayload,
    canonicalBillingQuery,
} from './billing-signature';

/**
 * GOLDEN VECTORS — the same two lines exist in kodus-service-billing's
 * `src/config/utils/serviceToken.spec.ts`. They are the only mechanical link
 * between the signer here and the verifier there (separate repos, separate
 * deploys): if either side changes what it puts in the payload, one of the two
 * suites goes red instead of production answering 401 on every credit call.
 *
 * Do not "fix" a failure by updating the hex. Change both repos, or neither.
 */
export const GOLDEN_SECRET = 'kodus-test-secret';
export const GOLDEN_VECTORS = [
    {
        name: 'balance read (query signed, empty body)',
        method: 'GET',
        path: '/api/billing/credits/balance',
        query: 'organizationId=o&teamId=t',
        timestamp: '1789000000000',
        rawBody: '',
        signature:
            '263cfb56c87efae7f51f0d20fd2b9f2aab96d4de33ffd4e820eae3375fc68037',
    },
    {
        name: 'debit (body signed, no query)',
        method: 'POST',
        path: '/api/billing/credits/debit',
        query: '',
        timestamp: '1789000000000',
        rawBody: JSON.stringify({
            organizationId: 'o',
            entries: [{ usageKey: 'span:1', amountUsd: 0.5 }],
        }),
        signature:
            '03692a4564a44ae550d2ed76e831bf783961fe94be767f3059a1293ac30c84f6',
    },
    {
        name: 'a query value carrying a literal "?" (split once, never twice)',
        method: 'GET',
        path: '/api/billing/credits/balance',
        query: 'organizationId=o&returnTo=/byok?credits=success',
        timestamp: '1789000000000',
        rawBody: '',
        signature:
            'ca7fe2915861fc07dc4d947651841b2e4bcdd07f97ef4dafcca680a1739ca707',
    },
    {
        name: 'a DELETE that carries a body (no longer signed as empty)',
        method: 'DELETE',
        path: '/api/billing/credits/payment-method',
        query: 'organizationId=o',
        timestamp: '1789000000000',
        rawBody: JSON.stringify({ organizationId: 'o' }),
        signature:
            '9b9b420b6b6a7f29b6ee7fb1569f1f1e29f1376080b0faa85a0c856d1688d5e6',
    },
] as const;

describe('billing signature', () => {
    it.each(GOLDEN_VECTORS)('matches the golden vector: $name', (vector) => {
        const headers = billingSignatureHeaders({
            secret: GOLDEN_SECRET,
            method: vector.method,
            path: vector.path,
            query: vector.query,
            rawBody: vector.rawBody,
            now: Number(vector.timestamp),
        });
        expect(headers[BILLING_SIGNATURE_HEADER]).toBe(vector.signature);
        expect(headers[BILLING_TIMESTAMP_HEADER]).toBe(vector.timestamp);
    });

    it('sorts the query, so param order cannot cause a 401', () => {
        expect(canonicalBillingQuery('teamId=t&organizationId=o')).toBe(
            'organizationId=o&teamId=t',
        );
        expect(
            canonicalBillingQuery({ teamId: 't', organizationId: 'o' }),
        ).toBe('organizationId=o&teamId=t');
    });

    it('drops nullish params instead of signing the string "undefined"', () => {
        expect(
            canonicalBillingQuery({
                organizationId: 'o',
                teamId: undefined,
                before: null,
            }),
        ).toBe('organizationId=o');
    });

    it('signs the VALUES, so a signature cannot be aimed at another org', () => {
        const mine = billingSignaturePayload({
            method: 'GET',
            path: '/api/billing/credits/balance',
            query: { organizationId: 'mine' },
            timestamp: '1',
        });
        const theirs = billingSignaturePayload({
            method: 'GET',
            path: '/api/billing/credits/balance',
            query: { organizationId: 'victim' },
            timestamp: '1',
        });
        expect(mine).not.toBe(theirs);
    });

    it('signs a DELETE body instead of zeroing it', () => {
        const withBody = billingSignatureHeaders({
            secret: GOLDEN_SECRET,
            method: 'DELETE',
            path: '/api/billing/credits/payment-method',
            query: 'organizationId=o',
            rawBody: '{"organizationId":"o"}',
            now: 1,
        });
        const withoutBody = billingSignatureHeaders({
            secret: GOLDEN_SECRET,
            method: 'DELETE',
            path: '/api/billing/credits/payment-method',
            query: 'organizationId=o',
            now: 1,
        });
        expect(withBody[BILLING_SIGNATURE_HEADER]).not.toBe(
            withoutBody[BILLING_SIGNATURE_HEADER],
        );
    });

    it('returns no headers with no secret (billing then fails closed)', () => {
        expect(
            billingSignatureHeaders({
                secret: '',
                method: 'GET',
                path: '/api/billing/credits/balance',
            }),
        ).toEqual({});
    });
});

/**
 * The interceptor is where the payload meets the request axios actually sends:
 * the tenant lives in `params` for every credit read, and the body is
 * serialized by axios itself.
 */
describe('AxiosLicenseService request signing', () => {
    const envKeys = [
        'API_CREDITS_SERVICE_TOKEN',
        'API_BILLING_WEBHOOK_SECRET',
        'GLOBAL_KODUS_SERVICE_BILLING',
    ] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const key of envKeys) saved[key] = process.env[key];
        delete process.env.API_CREDITS_SERVICE_TOKEN;
        process.env.API_BILLING_WEBHOOK_SECRET = GOLDEN_SECRET;
        process.env.GLOBAL_KODUS_SERVICE_BILLING = 'http://billing:3000';
    });
    afterEach(() => {
        for (const key of envKeys) {
            if (saved[key] === undefined) delete process.env[key];
            else process.env[key] = saved[key];
        }
        jest.restoreAllMocks();
    });

    /** Run the real interceptor over a config and return the headers it set. */
    const runInterceptor = async (config: Record<string, unknown>) => {
        const captured: Array<Record<string, unknown>> = [];
        const create = jest.spyOn(axios, 'create');
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const {
            AxiosLicenseService,
        } = require('@libs/core/infrastructure/config/axios/microservices/license.axios');
        new AxiosLicenseService();
        const instance = create.mock.results[0].value as {
            interceptors: {
                request: {
                    handlers: Array<{ fulfilled: (c: unknown) => unknown }>;
                };
            };
        };
        const handler = instance.interceptors.request.handlers[0].fulfilled;
        const headers = new Map<string, string>();
        const result = (await handler({
            ...config,
            headers: { set: (k: string, v: string) => headers.set(k, v) },
        })) as unknown;
        captured.push({ result });
        return Object.fromEntries(headers);
    };

    it('signs the params, not just the path (the org lives in the query)', async () => {
        const headers = await runInterceptor({
            method: 'get',
            url: 'credits/balance',
            params: { organizationId: 'o', teamId: 't' },
        });
        const expected = billingSignatureHeaders({
            secret: GOLDEN_SECRET,
            method: 'GET',
            path: '/api/billing/credits/balance',
            query: { organizationId: 'o', teamId: 't' },
            now: Number(headers[BILLING_TIMESTAMP_HEADER]),
        });
        expect(headers[BILLING_SIGNATURE_HEADER]).toBe(
            expected[BILLING_SIGNATURE_HEADER],
        );
    });

    it('signs the serialized body on a debit', async () => {
        const data = {
            organizationId: 'o',
            entries: [{ usageKey: 'span:1', amountUsd: 0.5 }],
        };
        const headers = await runInterceptor({
            method: 'post',
            url: 'credits/debit',
            data,
        });
        expect(headers[BILLING_SIGNATURE_HEADER]).toBe(
            billingSignatureHeaders({
                secret: GOLDEN_SECRET,
                method: 'POST',
                path: '/api/billing/credits/debit',
                rawBody: JSON.stringify(data),
                now: Number(headers[BILLING_TIMESTAMP_HEADER]),
            })[BILLING_SIGNATURE_HEADER],
        );
    });

    it('MERGES an inline query with params (axios sends both)', async () => {
        const headers = await runInterceptor({
            method: 'get',
            url: 'credits/ledger?limit=25',
            params: { organizationId: 'o' },
        });
        expect(headers[BILLING_SIGNATURE_HEADER]).toBe(
            billingSignatureHeaders({
                secret: GOLDEN_SECRET,
                method: 'GET',
                path: '/api/billing/credits/ledger',
                query: 'limit=25&organizationId=o',
                now: Number(headers[BILLING_TIMESTAMP_HEADER]),
            })[BILLING_SIGNATURE_HEADER],
        );
    });

    it('signs array params the way axios serializes them (`key[]`)', async () => {
        const headers = await runInterceptor({
            method: 'get',
            url: 'credits/ledger',
            params: { organizationId: 'o', types: ['purchase', 'debit'] },
        });
        expect(headers[BILLING_SIGNATURE_HEADER]).toBe(
            billingSignatureHeaders({
                secret: GOLDEN_SECRET,
                method: 'GET',
                path: '/api/billing/credits/ledger',
                query: 'organizationId=o&types%5B%5D=purchase&types%5B%5D=debit',
                now: Number(headers[BILLING_TIMESTAMP_HEADER]),
            })[BILLING_SIGNATURE_HEADER],
        );
    });

    it('does not truncate a query value that contains a literal "?"', async () => {
        const headers = await runInterceptor({
            method: 'get',
            url: 'credits/balance?returnTo=/byok?credits=success',
            params: { organizationId: 'o' },
        });
        expect(headers[BILLING_SIGNATURE_HEADER]).toBe(
            billingSignatureHeaders({
                secret: GOLDEN_SECRET,
                method: 'GET',
                path: '/api/billing/credits/balance',
                query: 'organizationId=o&returnTo=/byok?credits=success',
                now: Number(headers[BILLING_TIMESTAMP_HEADER]),
            })[BILLING_SIGNATURE_HEADER],
        );
    });

    /**
     * The strongest form of this test: ask AXIOS ITSELF what the URL will be
     * and require the signed query to be the canonical form of exactly that.
     * It pins the pairs axios keeps and drops (`null` and `undefined` go, an
     * empty string stays, arrays become `key[]`) without this spec having to
     * restate those rules — if a future axios changes them, this goes red.
     */
    it.each([
        {
            name: 'a null param (axios drops it)',
            params: { organizationId: 'o', teamId: null },
        },
        {
            name: 'an undefined param',
            params: { organizationId: 'o', teamId: undefined },
        },
        {
            name: 'an EMPTY-STRING param (axios keeps it)',
            params: { organizationId: 'o', teamId: '' },
        },
        {
            name: 'array params',
            params: { organizationId: 'o', types: ['purchase', 'debit'] },
        },
        {
            name: 'params out of order',
            params: { teamId: 't', organizationId: 'o' },
        },
        { name: 'a numeric param', params: { organizationId: 'o', limit: 25 } },
    ])(
        'signs exactly what axios puts on the wire: $name',
        async ({ params }) => {
            const uri = axios.getUri({
                url: 'http://billing/api/billing/credits/ledger',
                params,
            });
            const wireQuery = uri.slice(uri.indexOf('?') + 1);

            const headers = await runInterceptor({
                method: 'get',
                url: 'credits/ledger',
                params,
            });

            expect(headers[BILLING_SIGNATURE_HEADER]).toBe(
                billingSignatureHeaders({
                    secret: GOLDEN_SECRET,
                    method: 'GET',
                    path: '/api/billing/credits/ledger',
                    query: wireQuery,
                    now: Number(headers[BILLING_TIMESTAMP_HEADER]),
                })[BILLING_SIGNATURE_HEADER],
            );
        },
    );

    it('sends no signature when no secret is configured', async () => {
        delete process.env.API_BILLING_WEBHOOK_SECRET;
        const headers = await runInterceptor({
            method: 'get',
            url: 'credits/balance',
            params: { organizationId: 'o' },
        });
        expect(headers[BILLING_SIGNATURE_HEADER]).toBeUndefined();
    });
});
