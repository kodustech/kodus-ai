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
    addressRefusal,
    isAllowedPrivateHostName,
    isMetadataAddress,
    isPrivateOrReservedIp,
    parseAllowedPrivateHosts,
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
        // Reserved IPv4 ranges outside RFC 1918 (Kody, #2709).
        '192.0.0.8',
        '198.18.0.1',
        '198.19.255.255',
        '224.0.0.1',
        '239.255.255.250',
        '240.0.0.1',
        '255.255.255.255',
        '::ffff:198.18.0.1',
        // Reserved IPv6 ranges.
        '100::1',
        '2001:10::1',
    ])('refuses %s', (ip) => {
        expect(isPrivateOrReservedIp(ip)).toBe(true);
    });

    it.each([
        '8.8.8.8',
        '1.1.1.1',
        '203.0.113.10',
        '2001:db8::1',
        '198.20.0.1',
        '223.255.255.255',
        '2606:4700:4700::1111',
        '2a00:1450:4001::1',
        '2001:200::1',
        '3ffe::1',
        '[2606:4700:4700::1111]',
        '::ffff:8.8.8.8',
        '64:ff9b::808:808',
        '2002:808:808::1',
    ])('allows %s', (ip) => {
        expect(isPrivateOrReservedIp(ip)).toBe(false);
    });
});

describe('the operator allowance (API_ALLOWED_PRIVATE_HOSTS, #2381)', () => {
    it('reads names, addresses, ports and ranges, and reports what it cannot read', () => {
        const { allowances, invalid } = parseAllowedPrivateHosts(
            'llm.internal:4000, 10.0.0.5 [fd00::5]:8080 10.1.0.0/16,fd00:1::/32 GW.Corp. ' +
                'bad_host 10.0.0.0/33 host:99999 :80',
        );
        expect(allowances).toHaveLength(6);
        expect(invalid).toEqual([
            'bad_host',
            '10.0.0.0/33',
            'host:99999',
            ':80',
        ]);
    });

    it('with nothing set, refuses every private or reserved address', () => {
        const refuses = addressRefusal('llm.internal', 443, '');
        expect(refuses('10.0.0.5')).toBe(true);
        expect(refuses('127.0.0.1')).toBe(true);
        expect(refuses('8.8.8.8')).toBe(false);
    });

    it('a named host opens what it resolves to, on its port only', () => {
        const env = 'llm.internal:4000';
        expect(addressRefusal('llm.internal', 4000, env)('10.0.0.5')).toBe(
            false,
        );
        expect(addressRefusal('LLM.internal.', 4000, env)('10.0.0.5')).toBe(
            false,
        );
        expect(addressRefusal('llm.internal', 4001, env)('10.0.0.5')).toBe(
            true,
        );
        expect(addressRefusal('other.internal', 4000, env)('10.0.0.5')).toBe(
            true,
        );
    });

    it('a named host without a port opens it on any port', () => {
        expect(
            addressRefusal('llm.internal', 8080, 'llm.internal')('10.0.0.5'),
        ).toBe(false);
    });

    it('an address or range opens that address whatever name reached it', () => {
        const env = '10.1.0.0/16, 127.0.0.1:4000, fd00:1::/32';
        expect(addressRefusal('a.internal', 443, env)('10.1.200.3')).toBe(
            false,
        );
        expect(
            addressRefusal('a.internal', 443, env)('::ffff:10.1.200.3'),
        ).toBe(false);
        expect(addressRefusal('a.internal', 443, env)('10.2.0.1')).toBe(true);
        expect(addressRefusal('localhost', 4000, env)('127.0.0.1')).toBe(false);
        expect(addressRefusal('localhost', 4001, env)('127.0.0.1')).toBe(true);
        expect(addressRefusal('b.internal', 443, env)('fd00:1:2::3')).toBe(
            false,
        );
        expect(addressRefusal('b.internal', 443, env)('fd00:2::3')).toBe(true);
    });

    it.each([
        '169.254.169.254',
        '::ffff:169.254.169.254',
        '64:ff9b::a9fe:a9fe',
        '169.254.170.2',
        '100.100.100.200',
        'fd00:ec2::254',
        'fe80::1',
    ])(
        'never opens the metadata address %s, even when its range is allowed',
        (ip) => {
            const env =
                '169.254.0.0/16, 100.64.0.0/10, fd00::/8, fe80::/10, meta.internal';
            expect(isMetadataAddress(ip)).toBe(true);
            expect(addressRefusal('meta.internal', 443, env)(ip)).toBe(true);
        },
    );

    it('a public address stays open whatever is listed', () => {
        expect(
            addressRefusal('api.example.com', 443, '10.0.0.0/8')('8.8.8.8'),
        ).toBe(false);
    });

    it('plain http is for a host the operator named, not for an address it may resolve to', () => {
        expect(
            isAllowedPrivateHostName('llm.internal', 80, 'llm.internal:80'),
        ).toBe(true);
        expect(isAllowedPrivateHostName('10.0.0.5', 80, '10.0.0.5')).toBe(true);
        expect(isAllowedPrivateHostName('llm.internal', 80, '10.0.0.0/8')).toBe(
            false,
        );
        expect(
            isAllowedPrivateHostName('llm.internal', 81, 'llm.internal:80'),
        ).toBe(false);
    });
});

describe('the operator allowance at call time', () => {
    let gateway: Server;
    let internal: Server;
    let gatewayPort: number;
    let internalPort: number;
    let reached: string[];
    const saved = process.env.API_ALLOWED_PRIVATE_HOSTS;

    beforeAll(async () => {
        internal = createServer((req, res) => {
            reached.push(`internal ${req.method} ${req.url}`);
            res.end('ami-id');
        });
        gateway = createServer((req, res) => {
            reached.push(`gateway ${req.method} ${req.url}`);
            if (req.url?.includes('redirect')) {
                res.statusCode = 302;
                res.setHeader(
                    'location',
                    `http://127.0.0.1:${internalPort}/latest/meta-data/`,
                );
                res.end();
                return;
            }
            res.end('pong');
        });
        await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
        await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', r));
        internalPort = (internal.address() as AddressInfo).port;
        gatewayPort = (gateway.address() as AddressInfo).port;
    });

    afterAll(async () => {
        if (saved === undefined) delete process.env.API_ALLOWED_PRIVATE_HOSTS;
        else process.env.API_ALLOWED_PRIVATE_HOSTS = saved;
        await new Promise<void>((r) => internal.close(() => r()));
        await new Promise<void>((r) => gateway.close(() => r()));
    });

    beforeEach(() => {
        reached = [];
    });

    const call = (url: string) => {
        const { resolve } = scriptedResolver([v4('127.0.0.1')]);
        const dispatcher = createGatewayDispatcher({ resolve });
        return gatewayGuardedFetch(
            undefined,
            dispatcher,
        )(url).then(
            async (res) => ({ text: await res.text(), err: undefined as any }),
            (err) => ({ text: undefined, err }),
        );
    };

    it('reaches an allowed gateway, read from the environment at call time', async () => {
        process.env.API_ALLOWED_PRIVATE_HOSTS = `llm.internal:${gatewayPort}`;
        const out = await call(`http://llm.internal:${gatewayPort}/v1/models`);
        expect(out.text).toBe('pong');
        expect(reached).toEqual(['gateway GET /v1/models']);
    });

    it('refuses the same host on a port the operator did not name', async () => {
        process.env.API_ALLOWED_PRIVATE_HOSTS = `llm.internal:${gatewayPort + 1}`;
        const out = await call(`http://llm.internal:${gatewayPort}/v1/models`);
        expectRefused(out.err);
        expect(reached).toEqual([]);
    });

    it('an allowed gateway cannot redirect the call onto an address it was not allowed', async () => {
        process.env.API_ALLOWED_PRIVATE_HOSTS = `llm.internal:${gatewayPort}`;
        const out = await call(`http://llm.internal:${gatewayPort}/redirect`);
        expectRefused(out.err);
        expect(reached).toEqual(['gateway GET /redirect']);
    });
});
