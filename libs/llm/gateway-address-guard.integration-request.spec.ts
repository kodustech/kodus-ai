/**
 * `integrationRequestGuard` on the real axios (an MCP server's OAuth
 * endpoints): the address each connection dials is judged, the first one and
 * every redirect hop, an IP literal included. On cloud a private address is
 * refused; on a self-hosted install only the metadata service is.
 *
 * No external network: the resolver is replaced, the listeners are local.
 * Where cloud needs an address to pass, the operator allowance stands in for a
 * public host (it opens exactly that host and port).
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dns from 'dns';
import axios from 'axios';
import { integrationRequestGuard } from './gateway-address-guard';

jest.mock('dns', () => ({ ...jest.requireActual('dns'), lookup: jest.fn() }));
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

const { environment } = jest.requireMock('@libs/ee/configs/environment');
const mockLookup = dns.lookup as unknown as jest.Mock;
const ALLOW = 'API_ALLOWED_PRIVATE_HOSTS';
const savedAllow = process.env[ALLOW];

let auth: Server;
let internal: Server;
let authPort: number;
let internalPort: number;
let reached: string[];
let redirectTo: string | undefined;

beforeAll(async () => {
    internal = createServer((req, res) => {
        reached.push(`internal ${req.method} ${req.url}`);
        res.end('{"secret":true}');
    });
    auth = createServer((req, res) => {
        reached.push(`auth ${req.method} ${req.url}`);
        if (redirectTo) {
            res.statusCode = 302;
            res.setHeader('location', redirectTo);
            res.end();
            return;
        }
        res.setHeader('content-type', 'application/json');
        res.end('{"issuer":"x"}');
    });
    await new Promise<void>((r) => internal.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => auth.listen(0, '127.0.0.1', r));
    internalPort = (internal.address() as AddressInfo).port;
    authPort = (auth.address() as AddressInfo).port;
});

afterAll(async () => {
    if (savedAllow === undefined) delete process.env[ALLOW];
    else process.env[ALLOW] = savedAllow;
    await new Promise<void>((r) => internal.close(() => r()));
    await new Promise<void>((r) => auth.close(() => r()));
});

beforeEach(() => {
    reached = [];
    redirectTo = undefined;
    delete process.env[ALLOW];
    environment.API_CLOUD_MODE = true;
    mockLookup.mockReset();
    mockLookup.mockImplementation((_host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        return typeof options === 'object' && options?.all
            ? cb(null, [{ address: '127.0.0.1', family: 4 }])
            : cb(null, '127.0.0.1', 4);
    });
});

const get = (url: string) =>
    axios
        .get(url, {
            validateStatus: () => true,
            ...integrationRequestGuard(url),
        })
        .then(
            (res) => ({ data: res.data, err: undefined as any }),
            (err) => ({ data: undefined, err }),
        );

const messageOf = (err: any): string => {
    const out: string[] = [];
    for (let e = err, i = 0; e && i < 6; e = e.cause, i++)
        out.push(String(e.message ?? e));
    return out.join(' | ');
};

describe('integrationRequestGuard on the real axios', () => {
    it('cloud: a host that resolves to a private address is refused, nothing sent', async () => {
        const out = await get(
            `http://as.example.test:${authPort}/.well-known/oauth-authorization-server`,
        );
        expect(reached).toEqual([]);
        expect(messageOf(out.err)).toMatch(
            /OAuth endpoint host "as\.example\.test" resolves to a private or reserved address/,
        );
    });

    it('cloud: a private IP literal is refused before the request', () => {
        expect(() =>
            integrationRequestGuard(`http://10.0.0.5:${authPort}/token`),
        ).toThrow(/resolves to a private or reserved address \(10\.0\.0\.5\)/);
    });

    it('cloud: a reachable server cannot redirect onto a private IP literal', async () => {
        process.env[ALLOW] = `as.example.test:${authPort}`;
        redirectTo = `http://127.0.0.1:${internalPort}/latest/meta-data/`;
        const out = await get(
            `http://as.example.test:${authPort}/.well-known/oauth-authorization-server`,
        );
        expect(reached).toEqual([
            'auth GET /.well-known/oauth-authorization-server',
        ]);
        expect(messageOf(out.err)).toMatch(
            /resolves to a private or reserved address \(127\.0\.0\.1\)/,
        );
    });

    it('cloud: a reachable server cannot redirect onto a name that resolves privately', async () => {
        process.env[ALLOW] = `as.example.test:${authPort}`;
        redirectTo = `http://other.example.test:${internalPort}/latest/meta-data/`;
        const out = await get(
            `http://as.example.test:${authPort}/.well-known/oauth-authorization-server`,
        );
        expect(reached).toEqual([
            'auth GET /.well-known/oauth-authorization-server',
        ]);
        expect(messageOf(out.err)).toMatch(
            /other\.example\.test" resolves to a private or reserved address/,
        );
    });

    it('cloud: a reachable server answers', async () => {
        process.env[ALLOW] = `as.example.test:${authPort}`;
        const out = await get(
            `http://as.example.test:${authPort}/.well-known/oauth-authorization-server`,
        );
        expect(out.err).toBeUndefined();
        expect(out.data).toEqual({ issuer: 'x' });
    });

    it('self-hosted: a server on the operator network answers, and may redirect inside it', async () => {
        environment.API_CLOUD_MODE = false;
        redirectTo = `http://127.0.0.1:${internalPort}/next`;
        const out = await get(`http://as.example.test:${authPort}/start`);
        expect(out.err).toBeUndefined();
        expect(reached).toEqual(['auth GET /start', 'internal GET /next']);
    });

    it('self-hosted: a redirect onto the metadata service is refused', async () => {
        environment.API_CLOUD_MODE = false;
        redirectTo = 'http://169.254.169.254/latest/meta-data/';
        const out = await get(`http://as.example.test:${authPort}/start`);
        expect(messageOf(out.err)).toMatch(
            /resolves to a private or reserved address \(169\.254\.169\.254\)/,
        );
    });
});
