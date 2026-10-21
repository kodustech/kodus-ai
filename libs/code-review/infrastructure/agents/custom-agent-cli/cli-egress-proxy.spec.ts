import * as net from 'node:net';
import * as tls from 'node:tls';
import * as vm from 'node:vm';

import { CLI_EGRESS_PROXY_SOURCE } from './cli-egress-proxy.source';

/** The shipped source, loaded the way Node would load it as a module. */
const load = () => {
    const module = { exports: {} as any };
    vm.runInNewContext(CLI_EGRESS_PROXY_SOURCE, {
        module,
        require: Object.assign((id: string) => require(id), { main: {} }),
        Buffer,
        process,
        Set,
    });
    return module.exports as {
        createProxyServer: (o: any) => net.Server;
        isPublicIPv4: (ip: string) => boolean;
        normalizeHost: (h: string) => string | null;
        parseSni: (b: Buffer) => { need?: boolean; host?: string | null };
    };
};

const proxy = load();

/** The first bytes a real TLS client sends for this server name. */
const clientHello = (servername?: string): Promise<Buffer> =>
    new Promise((resolve, reject) => {
        const server = net.createServer((socket) => {
            socket.once('data', (chunk: Buffer) => {
                resolve(chunk);
                socket.destroy();
                server.close();
            });
        });
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address() as net.AddressInfo;
            const client = tls.connect({
                host: '127.0.0.1',
                port,
                ...(servername ? { servername } : {}),
            });
            // Only the ClientHello is wanted: the server cuts the socket
            // before any certificate is sent, so the handshake error is moot.
            client.on('error', () => {});
        });
        server.on('error', reject);
    });

const listen = (server: net.Server): Promise<number> =>
    new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () =>
            resolve((server.address() as net.AddressInfo).port),
        ),
    );

/**
 * Sends `hello` through a proxy for `allowed`, resolving names with
 * `addresses`, and reports what the upstream saw.
 */
const through = async (params: {
    allowed: string[];
    hello: Buffer;
    addresses: string[];
}) => {
    const upstreamGot: Buffer[] = [];
    const upstream = net.createServer((socket) => {
        socket.on('data', (d: Buffer) => {
            upstreamGot.push(d);
            socket.write('pong');
        });
    });
    const upstreamPort = await listen(upstream);
    const dialed: Array<{ host: string; port: number }> = [];
    const looked: string[] = [];
    const server = proxy.createProxyServer({
        allowedHosts: params.allowed,
        lookup: (host: string, _o: unknown, cb: any) => {
            looked.push(host);
            cb(
                null,
                params.addresses.map((address) => ({ address, family: 4 })),
            );
        },
        connect: (o: { host: string; port: number }) => {
            dialed.push(o);
            return net.connect({ host: '127.0.0.1', port: upstreamPort });
        },
    });
    const port = await listen(server);
    const reply = await new Promise<string>((resolve) => {
        const client = net.connect({ host: '127.0.0.1', port }, () =>
            client.write(params.hello),
        );
        let got = '';
        client.on('data', (d) => {
            got += d.toString();
            client.destroy();
        });
        client.on('close', () => resolve(got));
        client.on('error', () => resolve(got));
    });
    server.close();
    upstream.close();
    return {
        reply,
        dialed,
        looked,
        upstreamGot: Buffer.concat(upstreamGot),
    };
};

describe('egress proxy: server name parsing', () => {
    it('reads the server name of a real ClientHello', async () => {
        const hello = await clientHello('api.lintkit.example');
        expect(proxy.parseSni(hello)).toEqual({ host: 'api.lintkit.example' });
    });

    it('asks for more bytes while the record is incomplete', async () => {
        const hello = await clientHello('api.lintkit.example');
        expect(proxy.parseSni(hello.subarray(0, 40))).toEqual({ need: true });
    });

    it('finds no name in a hello without one, or in plain HTTP', async () => {
        expect(proxy.parseSni(await clientHello())).toEqual({ host: null });
        expect(
            proxy.parseSni(
                Buffer.from('POST / HTTP/1.1\r\nHost: api.lintkit.example\r\n'),
            ),
        ).toEqual({ host: null });
    });

    it('survives truncated or lying length fields', async () => {
        const hello = await clientHello('api.lintkit.example');
        for (let cut = 6; cut < hello.length; cut += 7) {
            const forged = Buffer.from(hello.subarray(0, cut));
            forged.writeUInt16BE(cut - 5, 3);
            expect(() => proxy.parseSni(forged)).not.toThrow();
        }
    });
});

describe('egress proxy: forwarding', () => {
    it('forwards an allowed name to the address it resolves to', async () => {
        const hello = await clientHello('API.lintkit.example');
        const r = await through({
            allowed: ['api.lintkit.example'],
            hello,
            addresses: ['93.184.216.34'],
        });
        expect(r.looked).toEqual(['api.lintkit.example']);
        expect(r.dialed).toEqual([{ host: '93.184.216.34', port: 443 }]);
        expect(r.upstreamGot.equals(hello)).toBe(true);
        expect(r.reply).toBe('pong');
    });

    it('refuses a name off the allowlist without resolving or dialing', async () => {
        const r = await through({
            allowed: ['api.lintkit.example'],
            hello: await clientHello('evil.example'),
            addresses: ['93.184.216.34'],
        });
        expect(r.looked).toEqual([]);
        expect(r.dialed).toEqual([]);
        expect(r.reply).toBe('');
    });

    it('refuses a subdomain or a look-alike of an allowed name', async () => {
        for (const name of [
            'x.api.lintkit.example',
            'api.lintkit.example.evil.example',
        ]) {
            const r = await through({
                allowed: ['api.lintkit.example'],
                hello: await clientHello(name),
                addresses: ['93.184.216.34'],
            });
            expect(r.dialed).toEqual([]);
        }
    });

    it('refuses a connection that names no host, and plain HTTP', async () => {
        for (const hello of [
            await clientHello(),
            Buffer.from('GET / HTTP/1.1\r\nHost: api.lintkit.example\r\n\r\n'),
        ]) {
            const r = await through({
                allowed: ['api.lintkit.example'],
                hello,
                addresses: ['93.184.216.34'],
            });
            expect(r.dialed).toEqual([]);
        }
    });

    it.each(['127.0.0.1', '10.0.0.5', '169.254.169.254', '192.168.0.1'])(
        'refuses an allowed name that resolves to %s',
        async (ip) => {
            const r = await through({
                allowed: ['api.lintkit.example'],
                hello: await clientHello('api.lintkit.example'),
                addresses: ['93.184.216.34', ip],
            });
            expect(r.dialed).toEqual([]);
        },
    );
});

describe('egress proxy: address checks', () => {
    it.each([
        ['93.184.216.34', true],
        ['8.8.8.8', true],
        ['172.32.0.1', true],
        ['10.1.1.1', false],
        ['100.64.0.1', false],
        ['127.0.0.1', false],
        ['169.254.169.254', false],
        ['172.16.0.1', false],
        ['192.168.1.1', false],
        ['224.0.0.1', false],
        ['999.1.1.1', false],
        ['example.com', false],
    ])('%s public: %s', (ip, expected) => {
        expect(proxy.isPublicIPv4(ip as string)).toBe(expected);
    });
});
