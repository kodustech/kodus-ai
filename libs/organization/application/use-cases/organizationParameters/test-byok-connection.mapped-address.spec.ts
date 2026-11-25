/**
 * The BYOK base-URL guard refuses a private or reserved address however it is
 * written. An IPv6 address can carry an IPv4 one (mapped `::ffff:a.b.c.d`, its
 * hex form `::ffff:a9fe:a9fe`, IPv4-compatible `::a.b.c.d`, NAT64
 * `64:ff9b::/96`, 6to4 `2002::/16`), and a connection to it reaches the IPv4
 * address it carries. The guard has to read the embedded address, not the
 * prefix.
 *
 * No network: `dns/promises.lookup` is replaced by a table that behaves like the
 * system resolver (an IP literal resolves to itself, a bracketed host does not
 * resolve, anything else answers from the table or fails with ENOTFOUND).
 */
import { isIP } from 'net';
import { lookup } from 'dns/promises';
import { assertSafeOpenAICompatibleUrl } from './test-byok-connection.use-case';

jest.mock('dns/promises', () => ({ lookup: jest.fn() }));
// The hint names a setting only a self-hosted install has; each test says
// which install it runs on.
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: false },
}));
const { environment } = jest.requireMock('@libs/ee/configs/environment');

const answers = new Map<string, string[]>();
const mockLookup = lookup as unknown as jest.Mock;

beforeEach(() => {
    answers.clear();
    mockLookup.mockReset();
    mockLookup.mockImplementation(async (host: string) => {
        if (isIP(host)) return [{ address: host, family: isIP(host) }];
        const found = answers.get(host);
        if (!found) {
            throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
                code: 'ENOTFOUND',
            });
        }
        return found.map((address) => ({ address, family: isIP(address) }));
    });
});

const GATEWAY = 'https://gateway.example.test/v1';
const answering = (...addresses: string[]) =>
    answers.set('gateway.example.test', addresses);

describe('a DNS answer carrying a private IPv4 inside an IPv6 address is refused', () => {
    const CARRIED: [string, string][] = [
        ['mapped metadata, dotted', '::ffff:169.254.169.254'],
        ['mapped metadata, hex', '::ffff:a9fe:a9fe'],
        ['mapped metadata, upper case', '::FFFF:A9FE:A9FE'],
        ['mapped metadata, fully expanded', '0:0:0:0:0:ffff:a9fe:a9fe'],
        ['mapped RFC1918, dotted', '::ffff:10.0.0.1'],
        ['mapped RFC1918, hex', '::ffff:a00:1'],
        ['mapped 192.168', '::ffff:192.168.1.10'],
        ['mapped 172.16/12', '::ffff:172.20.0.5'],
        ['mapped loopback', '::ffff:127.0.0.1'],
        ['mapped CGNAT', '::ffff:100.64.0.1'],
        ['IPv4-translated (::ffff:0:0:0/96)', '::ffff:0:a9fe:a9fe'],
        ['IPv4-compatible metadata, dotted', '::169.254.169.254'],
        ['IPv4-compatible metadata, hex', '::a9fe:a9fe'],
        ['IPv4-compatible RFC1918', '::10.0.0.1'],
        ['NAT64 metadata, dotted', '64:ff9b::169.254.169.254'],
        ['NAT64 metadata, hex', '64:ff9b::a9fe:a9fe'],
        ['NAT64 RFC1918', '64:ff9b::10.0.0.1'],
        ['NAT64 local-use prefix', '64:ff9b:1::a00:1'],
        ['6to4 carrying the metadata address', '2002:a9fe:a9fe::1'],
    ];

    it.each(CARRIED)('%s (%s)', async (_label, address) => {
        answering(address);
        await expect(assertSafeOpenAICompatibleUrl(GATEWAY)).rejects.toThrow(
            /private or reserved address/,
        );
    });

    it('a private answer next to a public one is refused', async () => {
        answering('2606:4700:4700::1111', '::ffff:169.254.169.254');
        await expect(assertSafeOpenAICompatibleUrl(GATEWAY)).rejects.toThrow(
            /private or reserved address/,
        );
    });
});

describe('the whole CGNAT block 100.64.0.0/10 is refused, not only 100.64.x', () => {
    it.each(['100.64.0.1', '100.100.1.1', '100.127.255.254'])(
        '%s',
        async (address) => {
            answering(address);
            await expect(
                assertSafeOpenAICompatibleUrl(GATEWAY),
            ).rejects.toThrow(/private or reserved address/);
        },
    );
});

describe('an IP literal in the URL is judged as the address it is', () => {
    const LITERALS: [string, string][] = [
        [
            'bracketed mapped metadata, dotted',
            'https://[::ffff:169.254.169.254]/v1',
        ],
        ['bracketed mapped metadata, hex', 'https://[::ffff:a9fe:a9fe]/v1'],
        ['bracketed mapped RFC1918', 'https://[::ffff:10.0.0.1]/v1'],
        ['bracketed IPv4-compatible', 'https://[::a9fe:a9fe]/v1'],
        ['bracketed NAT64', 'https://[64:ff9b::a9fe:a9fe]/v1'],
        ['bracketed loopback', 'https://[::1]/v1'],
        ['bracketed ULA', 'https://[fd00::1]/v1'],
        ['bracketed link-local', 'https://[fe80::1]/v1'],
        ['plain metadata IPv4', 'https://169.254.169.254/v1'],
    ];

    it.each(LITERALS)(
        '%s is refused as a private address',
        async (_label, url) => {
            await expect(assertSafeOpenAICompatibleUrl(url)).rejects.toThrow(
                /private or reserved address/,
            );
        },
    );

    it('a public IPv6 literal passes', async () => {
        await expect(
            assertSafeOpenAICompatibleUrl('https://[2606:4700:4700::1111]/v1'),
        ).resolves.toBeUndefined();
    });
});

describe('impact: what passed before still passes, what was refused still is', () => {
    const PUBLIC: [string, string][] = [
        ['public IPv4', '8.8.8.8'],
        ['documentation IPv4 used by the other specs', '203.0.113.10'],
        ['public IPv6', '2606:4700:4700::1111'],
        ['documentation IPv6', '2001:db8::1'],
        ['mapped PUBLIC IPv4', '::ffff:8.8.8.8'],
        ['NAT64 of a PUBLIC IPv4', '64:ff9b::808:808'],
        ['6to4 of a PUBLIC IPv4', '2002:808:808::1'],
        ['just below CGNAT', '100.63.255.255'],
        ['just above CGNAT', '100.128.0.1'],
    ];

    it.each(PUBLIC)('%s (%s) passes', async (_label, address) => {
        answering(address);
        await expect(
            assertSafeOpenAICompatibleUrl(GATEWAY),
        ).resolves.toBeUndefined();
    });

    it('public IPv4 literal passes', async () => {
        await expect(
            assertSafeOpenAICompatibleUrl('https://8.8.8.8/v1'),
        ).resolves.toBeUndefined();
    });

    it.each(['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', '10.1.2.3'])(
        'native private %s stays refused',
        async (address) => {
            answering(address);
            await expect(
                assertSafeOpenAICompatibleUrl(GATEWAY),
            ).rejects.toThrow(/private or reserved address/);
        },
    );

    it('plain http stays refused before any lookup', async () => {
        answering('8.8.8.8');
        await expect(
            assertSafeOpenAICompatibleUrl('http://gateway.example.test/v1'),
        ).rejects.toThrow(/must use https/);
        expect(mockLookup).not.toHaveBeenCalled();
    });

    it('a host that does not resolve stays refused', async () => {
        await expect(
            assertSafeOpenAICompatibleUrl('https://nowhere.example.test/v1'),
        ).rejects.toThrow(/Couldn't resolve host/);
    });

    it('without an operator allowance, a private gateway is refused', async () => {
        answering('10.20.30.40');
        await expect(assertSafeOpenAICompatibleUrl(GATEWAY)).rejects.toThrow(
            'baseURL resolves to a private or reserved address.',
        );
    });
});

describe('the self-hosted operator allows its private gateways (#2381)', () => {
    const saved = process.env.API_ALLOWED_PRIVATE_HOSTS;
    const allow = (value: string) => {
        process.env.API_ALLOWED_PRIVATE_HOSTS = value;
    };
    afterEach(() => {
        if (saved === undefined) delete process.env.API_ALLOWED_PRIVATE_HOSTS;
        else process.env.API_ALLOWED_PRIVATE_HOSTS = saved;
    });

    it('a gateway the operator named saves, over https', async () => {
        allow('gateway.example.test');
        answering('10.20.30.40');
        await expect(
            assertSafeOpenAICompatibleUrl(GATEWAY),
        ).resolves.toBeUndefined();
    });

    it('a gateway the operator named saves over plain http, on its port', async () => {
        allow('gateway.example.test:4000');
        answering('10.20.30.40');
        await expect(
            assertSafeOpenAICompatibleUrl(
                'http://gateway.example.test:4000/v1',
            ),
        ).resolves.toBeUndefined();
        await expect(
            assertSafeOpenAICompatibleUrl(
                'http://gateway.example.test:4001/v1',
            ),
        ).rejects.toThrow(/must use https/);
    });

    it('an allowed range opens its addresses over https, not plain http', async () => {
        allow('10.0.0.0/8');
        answering('10.20.30.40');
        await expect(
            assertSafeOpenAICompatibleUrl(GATEWAY),
        ).resolves.toBeUndefined();
        await expect(
            assertSafeOpenAICompatibleUrl('http://gateway.example.test/v1'),
        ).rejects.toThrow(/must use https/);
    });

    it('on cloud, a private address is refused with no hint (cloud has no such setting)', async () => {
        environment.API_CLOUD_MODE = true;
        try {
            answering('192.168.1.5');
            const err = await assertSafeOpenAICompatibleUrl(GATEWAY).catch(
                (e) => e,
            );
            expect(String(err?.message)).toMatch(
                /private or reserved address\. /,
            );
            expect(String(err?.message)).not.toMatch(
                /API_ALLOWED_PRIVATE_HOSTS/,
            );
        } finally {
            environment.API_CLOUD_MODE = false;
        }
    });

    it('an address outside the allowance is refused, and says who can allow it', async () => {
        allow('10.0.0.0/8');
        answering('192.168.1.5');
        await expect(assertSafeOpenAICompatibleUrl(GATEWAY)).rejects.toThrow(
            /private or reserved address\. .*API_ALLOWED_PRIVATE_HOSTS/,
        );
    });

    it.each([
        '169.254.169.254',
        '::ffff:169.254.169.254',
        '100.100.100.200',
        'fd00:ec2::254',
    ])(
        'the metadata address %s stays refused even when its range and host are allowed',
        async (address) => {
            allow(
                'gateway.example.test, 169.254.0.0/16, 100.64.0.0/10, fd00::/8',
            );
            answering(address);
            const err = await assertSafeOpenAICompatibleUrl(GATEWAY).catch(
                (e) => e,
            );
            expect(String(err?.message)).toMatch(/private or reserved address/);
            expect(String(err?.message)).not.toMatch(
                /API_ALLOWED_PRIVATE_HOSTS/,
            );
        },
    );

    it('a public gateway is not affected by the allowance', async () => {
        allow('10.0.0.0/8');
        answering('8.8.8.8');
        await expect(
            assertSafeOpenAICompatibleUrl(GATEWAY),
        ).resolves.toBeUndefined();
    });
});
