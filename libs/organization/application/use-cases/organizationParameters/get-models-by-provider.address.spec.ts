/**
 * The model listing on a user endpoint, through the real axios and a real
 * socket: the address the socket resolves is judged when it connects, not only
 * by the save-time guard a moment earlier. A host that answers public to the
 * guard and private to the socket (DNS rebinding) is refused before any byte is
 * sent; an operator-allowed gateway is listed (#2381).
 *
 * No external network: both resolvers are replaced, and the only listener is a
 * local HTTP server that records what reaches it.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as dns from 'dns';
import { lookup as lookupPromise } from 'dns/promises';
import { GetModelsByProviderUseCase } from './get-models-by-provider.use-case';

jest.mock('@libs/common/utils/crypto', () => ({
    encrypt: (v: string) => v,
    decrypt: (v: string) => v,
}));
jest.mock('dns', () => ({ ...jest.requireActual('dns'), lookup: jest.fn() }));
jest.mock('dns/promises', () => ({
    ...jest.requireActual('dns/promises'),
    lookup: jest.fn(),
}));

const socketLookup = dns.lookup as unknown as jest.Mock;
const guardLookup = lookupPromise as unknown as jest.Mock;

/** What the socket's resolver answers for every host. */
function socketAnswers(address: string) {
    socketLookup.mockImplementation((_host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const family = address.includes(':') ? 6 : 4;
        return typeof options === 'object' && options?.all
            ? cb(null, [{ address, family }])
            : cb(null, address, family);
    });
}

function buildUseCase() {
    const providerService = { isProviderSupported: () => true } as any;
    const orgParamsService = {
        findByKey: jest.fn().mockResolvedValue(null),
    } as any;
    return new GetModelsByProviderUseCase(providerService, orgParamsService);
}

let server: Server;
let port: number;
let reached: string[];
const savedAllowance = process.env.API_ALLOWED_PRIVATE_HOSTS;

beforeAll(async () => {
    server = createServer((req, res) => {
        reached.push(`${req.method} ${req.url}`);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'gw-model' }] }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
    reached = [];
    socketLookup.mockReset();
    guardLookup.mockReset();
    delete process.env.API_ALLOWED_PRIVATE_HOSTS;
});

afterEach(() => {
    if (savedAllowance === undefined) {
        delete process.env.API_ALLOWED_PRIVATE_HOSTS;
    } else {
        process.env.API_ALLOWED_PRIVATE_HOSTS = savedAllowance;
    }
});

describe('model listing on a user endpoint judges the address the socket dials', () => {
    it('a host that answered public to the guard and private to the socket is refused, nothing sent', async () => {
        // The guard's lookup sees a public address; the socket's sees loopback.
        guardLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
        socketAnswers('127.0.0.1');
        // https with a port the local server listens on: if the socket were not
        // refused, the TLS handshake would reach the server and record a hit.
        const err = await buildUseCase()
            .execute(
                'openai_compatible',
                { organizationId: 'org-1' } as any,
                {
                    apiKey: 'sk-org',
                    baseURL: `https://rebind.example.test:${port}/v1`,
                } as any,
            )
            .then(
                () => undefined,
                (e: unknown) => e,
            );

        expect(socketLookup).toHaveBeenCalled();
        expect(reached).toEqual([]);
        expect(String((err as Error)?.message ?? err)).toMatch(
            /private or reserved address/,
        );
    });

    it('an operator-allowed gateway on the private network is listed', async () => {
        process.env.API_ALLOWED_PRIVATE_HOSTS = `llm.internal:${port}`;
        guardLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        socketAnswers('127.0.0.1');

        const out = await buildUseCase().execute(
            'openai_compatible',
            { organizationId: 'org-1' } as any,
            {
                apiKey: 'sk-org',
                baseURL: `http://llm.internal:${port}/v1`,
            } as any,
        );

        expect(reached).toEqual(['GET /v1/models']);
        expect(out.models.map((m: any) => m.id ?? m)).toContain('gw-model');
    });

    it('the allowance is for its port: the same host elsewhere is refused', async () => {
        process.env.API_ALLOWED_PRIVATE_HOSTS = `llm.internal:${port + 1}`;
        guardLookup.mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
        socketAnswers('127.0.0.1');

        const err = await buildUseCase()
            .execute(
                'openai_compatible',
                { organizationId: 'org-1' } as any,
                {
                    apiKey: 'sk-org',
                    baseURL: `https://llm.internal:${port}/v1`,
                } as any,
            )
            .then(
                () => undefined,
                (e: unknown) => e,
            );

        expect(reached).toEqual([]);
        expect(String((err as Error)?.message ?? err)).toMatch(
            /private or reserved address/,
        );
    });
});
