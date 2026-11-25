/**
 * A self-hosted git server URL an org typed (GitLab self-managed, GitHub
 * Enterprise, Bitbucket Data Center, Forgejo) may not lead the platform into
 * its own network on cloud, nor to the metadata service anywhere:
 *  - refused when saved (`assertGitServerUrlAllowed`);
 *  - judged again on every API connection (the GitLab requester shown here;
 *    the other clients use the same dispatcher or axios guard, covered in
 *    libs/llm/gateway-address-guard*.spec.ts);
 *  - a clone is pinned to the address that was judged (`pinnedGitFetchConfig`),
 *    proven against the real git binary.
 * On a self-hosted install the git server lives on the operator's network,
 * which it reached before this check: there only metadata is refused.
 *
 * No external network: the resolvers are replaced, the listener is local.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as dns from 'dns';
import { BadRequestException } from '@nestjs/common';
import { pinnedGitFetchConfig } from '@libs/llm/gateway-address-guard';
import { assertGitServerUrlAllowed } from './git-server-url.guard';
import { gitlabRequestHandler } from './gitlab-request-handler';

jest.mock('dns', () => {
    const actual = jest.requireActual('dns');
    return {
        ...actual,
        lookup: jest.fn(),
        promises: { ...actual.promises, lookup: jest.fn() },
    };
});
jest.mock('@libs/ee/configs/environment', () => ({
    environment: { API_CLOUD_MODE: true },
}));

const { environment } = jest.requireMock('@libs/ee/configs/environment');
const socketLookup = dns.lookup as unknown as jest.Mock;
const promiseLookup = dns.promises.lookup as unknown as jest.Mock;
const execFileAsync = promisify(execFile);

function resolvesTo(address: string) {
    const family = address.includes(':') ? 6 : 4;
    promiseLookup.mockResolvedValue([{ address, family }]);
    socketLookup.mockImplementation((_host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
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
        res.setHeader('content-type', 'application/json');
        res.end('{"id":1}');
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
    promiseLookup.mockReset();
    environment.API_CLOUD_MODE = true;
});

describe('a git server URL on save', () => {
    it('cloud: a host that resolves to a private address is refused', async () => {
        resolvesTo('10.4.0.9');
        await expect(
            assertGitServerUrlAllowed('gitlab.attacker.test'),
        ).rejects.toThrow(BadRequestException);
    });

    it('cloud: a public git server is accepted', async () => {
        resolvesTo('140.82.112.3');
        await expect(
            assertGitServerUrlAllowed('https://git.example.com'),
        ).resolves.toBeUndefined();
    });

    it('no host (the provider SaaS) has nothing to check', async () => {
        await expect(
            assertGitServerUrlAllowed(undefined),
        ).resolves.toBeUndefined();
        expect(promiseLookup).not.toHaveBeenCalled();
    });

    it('self-hosted: a git server on the operator network is accepted, as before', async () => {
        environment.API_CLOUD_MODE = false;
        resolvesTo('10.4.0.9');
        await expect(
            assertGitServerUrlAllowed('https://gitlab.internal'),
        ).resolves.toBeUndefined();
    });

    it.each([true, false])(
        'cloud=%s: the metadata service is refused',
        async (cloud) => {
            environment.API_CLOUD_MODE = cloud;
            await expect(
                assertGitServerUrlAllowed('http://169.254.169.254'),
            ).rejects.toThrow(
                /private or reserved address \(169\.254\.169\.254\)/,
            );
        },
    );
});

describe('the GitLab requester judges every connection', () => {
    const call = () =>
        (gitlabRequestHandler as any)('user', {
            prefixUrl: `http://gitlab.attacker.test:${port}/api/v4/`,
            method: 'GET',
            headers: {},
            rateLimiters: {},
        }).then(
            (r: unknown) => ({ r, err: undefined as any }),
            (err: unknown) => ({ r: undefined, err }),
        );

    it('cloud: a host that now resolves to a private address is refused, nothing sent', async () => {
        resolvesTo('127.0.0.1');
        const out = await call();
        expect(reached).toEqual([]);
        expect(String(out.err?.cause?.message ?? out.err?.message)).toMatch(
            /Git server host "gitlab\.attacker\.test" resolves to a private or reserved address/,
        );
    });

    it('self-hosted: a server on the operator network is reached', async () => {
        environment.API_CLOUD_MODE = false;
        resolvesTo('127.0.0.1');
        const out = await call();
        expect(out.err).toBeUndefined();
        expect(reached).toEqual(['GET /api/v4/user']);
    });
});

describe('a clone is pinned to the address that was judged', () => {
    const resolver =
        (address: string, family = 4) =>
        async () => [{ address, family }];

    it('pins host:port to the judged address and turns redirects off', async () => {
        environment.API_CLOUD_MODE = false;
        await expect(
            pinnedGitFetchConfig(
                'https://gitlab.internal/group/repo.git',
                resolver('10.4.0.9'),
            ),
        ).resolves.toEqual([
            ['http.curloptResolve', 'gitlab.internal:443:10.4.0.9'],
            ['http.followRedirects', 'false'],
        ]);
        await expect(
            pinnedGitFetchConfig(
                'http://gitlab.internal:8080/r.git',
                resolver('fd00::9', 6),
            ),
        ).resolves.toEqual([
            ['http.curloptResolve', 'gitlab.internal:8080:[fd00::9]'],
            ['http.followRedirects', 'false'],
        ]);
    });

    it('cloud: refuses a host that resolves to a private address', async () => {
        await expect(
            pinnedGitFetchConfig(
                'https://gitlab.attacker.test/r.git',
                resolver('10.4.0.9'),
            ),
        ).rejects.toThrow(
            /resolves to a private or reserved address \(10\.4\.0\.9\)/,
        );
    });

    it('anywhere: refuses the metadata service', async () => {
        environment.API_CLOUD_MODE = false;
        await expect(
            pinnedGitFetchConfig(
                'http://169.254.169.254/r.git',
                resolver('1.1.1.1'),
            ),
        ).rejects.toThrow(/169\.254\.169\.254/);
    });

    it('a URL git does not fetch over http(s) has nothing to pin', async () => {
        await expect(
            pinnedGitFetchConfig('git@gitlab.com:g/r.git'),
        ).resolves.toEqual([]);
        await expect(
            pinnedGitFetchConfig('ssh://git@gitlab.com/g/r.git'),
        ).resolves.toEqual([]);
    });

    it('the real git dials the pinned address, whatever the name resolves to', async () => {
        environment.API_CLOUD_MODE = false;
        const config = await pinnedGitFetchConfig(
            `http://git.pinned.test:${port}/g/r.git`,
            resolver('127.0.0.1'),
        );
        const dir = mkdtempSync(join(tmpdir(), 'pin-'));
        try {
            await execFileAsync('git', ['init', '-q', dir]);
            const env: Record<string, string> = {
                ...(process.env as Record<string, string>),
                GIT_TERMINAL_PROMPT: '0',
                GIT_CONFIG_COUNT: String(config.length),
            };
            config.forEach(([k, v], i) => {
                env[`GIT_CONFIG_KEY_${i}`] = k;
                env[`GIT_CONFIG_VALUE_${i}`] = v;
            });
            // `git.pinned.test` resolves nowhere; only the pin can take it here.
            await execFileAsync(
                'git',
                [
                    '-C',
                    dir,
                    'fetch',
                    '--depth=1',
                    `http://git.pinned.test:${port}/g/r.git`,
                    'HEAD',
                ],
                { env, timeout: 20_000 },
            ).catch(() => undefined);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(
            reached.some((r) => r.startsWith('GET /g/r.git/info/refs')),
        ).toBe(true);
    });
});
