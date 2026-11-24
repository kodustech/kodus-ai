/**
 * The call-time half of the BYOK gateway check: the address a connection is
 * about to use is judged in that connection's own lookup, so the address that
 * was checked is the address that is dialed — there is no second lookup that
 * could answer differently.
 *
 * No external network and no real DNS: the resolver is injected, and the only
 * listener is a local HTTP server. Where a test needs a connection to SUCCEED,
 * it injects a policy that treats the loopback address as allowed, standing in
 * for a public one.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
    GatewayAddressRefusedError,
    createGatewayDispatcher,
    gatewayGuardedFetch,
    gatewayLookup,
    isPrivateOrReservedIp,
} from './gateway-address-guard';

type Answer = { address: string; family: number };

/** A resolver that answers from a script, one entry per call. */
function scriptedResolver(...script: Answer[][]) {
    const calls: string[] = [];
    const resolve = (host: string, _opts: unknown, cb: any) => {
        calls.push(host);
        const next = script[Math.min(calls.length - 1, script.length - 1)];
        cb(null, next);
    };
    return { resolve, calls };
}

/** fetch rejects with `fetch failed`; the refusal is its cause. Node's fetch
 *  re-wraps a cause from another realm (Jest's), so the message is compared. */
function expectRefused(err: any): void {
    expect(err?.message).toBe('fetch failed');
    expect(String(err?.cause?.message)).toMatch(
        /private or reserved address \(.+\); the call was not sent/,
    );
}

const v4 = (address: string): Answer => ({ address, family: 4 });
const v6 = (address: string): Answer => ({ address, family: 6 });

function lookupOnce(
    lookup: ReturnType<typeof gatewayLookup>,
    options: { all?: boolean },
): Promise<{ err: any; address?: any; family?: number }> {
    return new Promise((resolve) =>
        (lookup as any)(
            'gateway.example.test',
            options,
            (err, address, family) => resolve({ err, address, family }),
        ),
    );
}

describe('gatewayLookup', () => {
    it('refuses a host whose answer is a private address', async () => {
        const { resolve } = scriptedResolver([v4('10.0.0.5')]);
        const { err } = await lookupOnce(gatewayLookup(resolve), { all: true });
        expect(err).toBeInstanceOf(GatewayAddressRefusedError);
        expect(err.message).toMatch(
            /gateway\.example\.test.*private or reserved address \(10\.0\.0\.5\)/,
        );
    });

    it('refuses a mapped IPv6 answer that carries the metadata address', async () => {
        const { resolve } = scriptedResolver([v6('::ffff:a9fe:a9fe')]);
        const { err } = await lookupOnce(gatewayLookup(resolve), { all: true });
        expect(err).toBeInstanceOf(GatewayAddressRefusedError);
    });

    it('refuses when ANY answer is private, even next to a public one', async () => {
        const { resolve } = scriptedResolver([
            v4('8.8.8.8'),
            v6('64:ff9b::a00:1'),
        ]);
        const { err } = await lookupOnce(gatewayLookup(resolve), { all: true });
        expect(err).toBeInstanceOf(GatewayAddressRefusedError);
    });

    it('hands back exactly the public answers it checked (all: true)', async () => {
        const answers = [v4('8.8.8.8'), v6('2606:4700:4700::1111')];
        const { resolve } = scriptedResolver(answers);
        const out = await lookupOnce(gatewayLookup(resolve), { all: true });
        expect(out.err).toBeNull();
        expect(out.address).toEqual(answers);
    });

    it('hands back the first checked answer when one address is asked for', async () => {
        const { resolve } = scriptedResolver([v6('2606:4700:4700::1111')]);
        const out = await lookupOnce(gatewayLookup(resolve), {});
        expect(out).toEqual({
            err: null,
            address: '2606:4700:4700::1111',
            family: 6,
        });
    });

    it('passes a resolver failure through unchanged', async () => {
        const failure = Object.assign(new Error('ENOTFOUND'), {
            code: 'ENOTFOUND',
        });
        const resolve = (_h: string, _o: unknown, cb: any) => cb(failure);
        const { err } = await lookupOnce(gatewayLookup(resolve), { all: true });
        expect(err).toBe(failure);
    });
});

describe('gatewayGuardedFetch', () => {
    let server: Server;
    let port: number;
    let requests: string[];
    let redirectTo: string | undefined;

    beforeAll(async () => {
        server = createServer((req, res) => {
            requests.push(`${req.method} ${req.url}`);
            if (redirectTo) {
                res.statusCode = 302;
                res.setHeader('location', redirectTo);
                res.end();
                return;
            }
            res.end('pong');
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
        redirectTo = undefined;
    });

    /** Loopback stands in for a public address; everything else is refused. */
    const onlyLoopbackAllowed = (ip: string) => ip !== '127.0.0.1';

    it('a host that resolves to a private address at call time is refused before connecting', async () => {
        const { resolve, calls } = scriptedResolver([v4('127.0.0.1')]);
        const dispatcher = createGatewayDispatcher({ resolve });
        const guarded = gatewayGuardedFetch(undefined, dispatcher);
        const err = await guarded(
            `http://gateway.example.test:${port}/v1/chat/completions`,
        ).then(
            () => undefined,
            (e: any) => e,
        );
        expectRefused(err);
        expect(calls).toEqual(['gateway.example.test']);
        expect(requests).toEqual([]);
        await dispatcher.close();
    });

    it('connects to the very address it checked: one lookup, no second answer', async () => {
        // A rebinding resolver: the first answer passes, every later one would not.
        const { resolve, calls } = scriptedResolver(
            [v4('127.0.0.1')],
            [v4('10.9.9.9')],
        );
        const dispatcher = createGatewayDispatcher({
            resolve,
            refuses: onlyLoopbackAllowed,
        });
        const res = await gatewayGuardedFetch(
            undefined,
            dispatcher,
        )(`http://gateway.example.test:${port}/v1/models`);
        expect(await res.text()).toBe('pong');
        expect(requests).toEqual(['GET /v1/models']);
        expect(calls).toEqual(['gateway.example.test']);
        await dispatcher.close();
    });

    it.each([
        ['an IPv4 literal', () => `http://127.0.0.1:${port}/v1`],
        [
            'a bracketed mapped literal',
            () => `http://[::ffff:7f00:1]:${port}/v1`,
        ],
    ])('%s is judged without a lookup and refused', async (_label, url) => {
        const { resolve, calls } = scriptedResolver([v4('8.8.8.8')]);
        const dispatcher = createGatewayDispatcher({ resolve });
        const err = await gatewayGuardedFetch(
            undefined,
            dispatcher,
        )(url()).then(
            () => undefined,
            (e: any) => e,
        );
        expectRefused(err);
        expect(calls).toEqual([]);
        expect(requests).toEqual([]);
        await dispatcher.close();
    });

    it('a redirect onto a private address is refused at the hop', async () => {
        const { resolve } = scriptedResolver([v4('127.0.0.1')]);
        const dispatcher = createGatewayDispatcher({
            resolve,
            refuses: onlyLoopbackAllowed,
        });
        redirectTo = `http://127.0.0.2:${port}/latest/meta-data/`;
        const err = await gatewayGuardedFetch(
            undefined,
            dispatcher,
        )(`http://gateway.example.test:${port}/v1/models`).then(
            () => undefined,
            (e: any) => e,
        );
        expectRefused(err);
        expect(requests).toEqual(['GET /v1/models']);
        await dispatcher.close();
    });

    it('composes with a caller transport (the probe refuses redirects) and keeps the guard', async () => {
        const seen: RequestInit[] = [];
        const inner = ((input: any, init?: RequestInit) => {
            seen.push(init ?? {});
            return fetch(input, { ...init, redirect: 'error' });
        }) as typeof fetch;
        const { resolve } = scriptedResolver([v4('127.0.0.1')]);
        const dispatcher = createGatewayDispatcher({ resolve });
        const err = await gatewayGuardedFetch(inner, dispatcher)(
            `http://gateway.example.test:${port}/v1`,
            { method: 'POST', body: '{}' },
        ).then(
            () => undefined,
            (e: any) => e,
        );
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({ method: 'POST', body: '{}' });
        expectRefused(err);
        expect(requests).toEqual([]);
        await dispatcher.close();
    });
});

describe('isPrivateOrReservedIp', () => {
    it.each([
        '10.0.0.1',
        '127.0.0.1',
        '0.0.0.0',
        '169.254.169.254',
        '100.100.0.1',
        '::1',
        '::',
        'fe80::1%en0',
        'fec0::1',
        'ff02::1',
        '::ffff:169.254.169.254',
        '::ffff:a9fe:a9fe',
        '[::ffff:a9fe:a9fe]',
        '::a9fe:a9fe',
        '64:ff9b::a9fe:a9fe',
        '2002:0a00:0001::',
        '2001:0:4136:e378:8000:63bf:3fff:fdd2',
        'not-an-address',
    ])('refuses %s', (ip) => {
        expect(isPrivateOrReservedIp(ip)).toBe(true);
    });

    it.each([
        '8.8.8.8',
        '203.0.113.10',
        '2606:4700:4700::1111',
        '2001:db8::1',
        '[2606:4700:4700::1111]',
        '::ffff:8.8.8.8',
        '64:ff9b::808:808',
        '2002:808:808::1',
    ])('allows %s', (ip) => {
        expect(isPrivateOrReservedIp(ip)).toBe(false);
    });
});
