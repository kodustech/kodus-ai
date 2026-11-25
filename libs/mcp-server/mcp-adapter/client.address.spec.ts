/**
 * An MCP server URL an org typed is dialed through the address check
 * (gateway-address-guard.ts, `integrationAddressRefusal`): on cloud it may not
 * reach the platform's private network, and nowhere may it reach the cloud
 * metadata service. A first-party endpoint from the platform's configuration
 * (`trusted`) is dialed as before.
 *
 * No external network: the resolver is replaced, and the only listener is a
 * local HTTP server that records what reaches it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dns from 'dns';
import { SpecCompliantMCPClient } from './client';

jest.mock('dns', () => ({ ...jest.requireActual('dns'), lookup: jest.fn() }));
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

const { environment } = jest.requireMock('@libs/ee/configs/environment');
const mockLookup = dns.lookup as unknown as jest.Mock;

function resolvesTo(address: string) {
    mockLookup.mockImplementation((_host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const family = address.includes(':') ? 6 : 4;
        return typeof options === 'object' && options?.all
            ? cb(null, [{ address, family }])
            : cb(null, address, family);
    });
}

let server: Server;
let port: number;
let reached: string[];

beforeAll(async () => {
    server = createServer((req, res) => {
        reached.push(`${req.method} ${req.url}`);
        res.statusCode = 500;
        res.end('not an MCP server');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
    reached = [];
    mockLookup.mockReset();
    environment.API_CLOUD_MODE = true;
});

async function connect(
    type: 'http' | 'sse',
    trusted?: boolean,
    host = 'mcp.example.test',
) {
    const client = new SpecCompliantMCPClient({
        clientInfo: { name: 'test', version: '1.0.0' },
        transport: {
            type,
            url: `http://${host}:${port}/mcp`,
            trusted,
            timeout: 2_000,
            retries: 0,
        },
        capabilities: {},
    } as any);
    const err = await client.connect().then(
        () => undefined,
        (e: unknown) => e,
    );
    await client.disconnect().catch(() => undefined);
    return err;
}

const chain = (err: any): string => {
    const out: string[] = [];
    for (let e = err, i = 0; e && i < 6; e = e.cause, i++) {
        out.push(String(e.message ?? e));
    }
    return out.join(' | ');
};

describe('an org MCP server URL is dialed through the address check', () => {
    it.each(['http', 'sse'] as const)(
        'cloud, %s: a host that resolves to a private address is refused, nothing sent',
        async (type) => {
            resolvesTo('127.0.0.1');
            const err = await connect(type);
            expect(reached).toEqual([]);
            // The SSE transport re-wraps the failure as "SSE error: fetch failed".
            expect(chain(err)).toMatch(
                type === 'http'
                    ? /MCP server host "mcp\.example\.test" resolves to a private or reserved address/
                    : /fetch failed/,
            );
        },
    );

    it('cloud: a private IP literal is refused before dialing', async () => {
        const err = await connect('http', undefined, '127.0.0.1');
        expect(reached).toEqual([]);
        expect(chain(err)).toMatch(
            /resolves to a private or reserved address \(127\.0\.0\.1\)/,
        );
    });

    it.each(['http', 'sse'] as const)(
        'cloud, %s: a first-party endpoint from the platform configuration is dialed',
        async (type) => {
            // The unguarded transport resolves through Node itself, which the
            // mocked resolver does not reach: dial the literal.
            await connect(type, true, '127.0.0.1');
            expect(reached.length).toBeGreaterThan(0);
        },
    );

    it('self-hosted: a server on the operator network is dialed, as before', async () => {
        environment.API_CLOUD_MODE = false;
        resolvesTo('127.0.0.1');
        await connect('http');
        expect(reached.length).toBeGreaterThan(0);
    });

    it.each([true, false])(
        'cloud=%s: the metadata address is refused',
        async (cloud) => {
            environment.API_CLOUD_MODE = cloud;
            resolvesTo('169.254.169.254');
            const err = await connect('http');
            expect(chain(err)).toMatch(
                /resolves to a private or reserved address \(169\.254\.169\.254\)/,
            );
        },
    );
});
