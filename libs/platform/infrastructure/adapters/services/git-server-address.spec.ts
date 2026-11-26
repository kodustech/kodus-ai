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
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import {
    createServer,
    type IncomingMessage,
    type Server,
    type ServerResponse,
} from 'node:http';
import {
    createServer as createHttpsServer,
    globalAgent as httpsAgent,
} from 'node:https';
import {
    createServer as createNetServer,
    type AddressInfo,
    type Server as NetServer,
} from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import * as dns from 'dns';
import { BadRequestException } from '@nestjs/common';
import {
    GatewayAddressRefusedError,
    gitRedirectTarget,
    pinnedGitFetchConfig,
    withJudgedGitRedirects,
} from '@libs/llm/gateway-address-guard';
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

/** Each name to its own address, as the socket and promise lookups answer. */
function resolvesByHost(addresses: Record<string, string>) {
    const answer = (host: string) => {
        const address = addresses[host];
        if (!address) throw new Error(`unmocked host ${host}`);
        return { address, family: address.includes(':') ? 6 : 4 };
    };
    promiseLookup.mockImplementation(async (host: string) => [answer(host)]);
    socketLookup.mockImplementation((host, options, callback) => {
        const cb = typeof options === 'function' ? options : callback;
        const { address, family } = answer(host);
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
            /gitlab\.attacker\.test" resolves to a private or reserved address;/,
        );
    });

    it('anywhere: refuses the metadata service', async () => {
        environment.API_CLOUD_MODE = false;
        await expect(
            pinnedGitFetchConfig(
                'http://169.254.169.254/r.git',
                resolver('1.1.1.1'),
            ),
        ).rejects.toHaveProperty(
            'message',
            'Git server host "169.254.169.254" resolves to a private or reserved address (169.254.169.254); the call was not sent.',
        );
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

/** Runs a real `git fetch` of `url` with `config` in a fresh repo. */
async function gitFetch(url: string, config: Array<[string, string]>) {
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
        return await execFileAsync(
            'git',
            ['-C', dir, 'fetch', '--depth=1', url, 'HEAD'],
            { env, timeout: 20_000 },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// Review on #2709 (sartorijr92, round 2): what a pinned clone must still do.
describe('a pinned clone keeps what an unpinned one could do', () => {
    const resolver =
        (...answers: Array<[string, number]>) =>
        async () =>
            answers.map(([address, family]) => ({ address, family }));

    it('pins every judged address, so curl falls back past a dead one', async () => {
        environment.API_CLOUD_MODE = false;
        const config = await pinnedGitFetchConfig(
            `http://git.pinned.test:${port}/g/r.git`,
            // ::1 has no listener (the server is on 127.0.0.1 only).
            resolver(['::1', 6], ['127.0.0.1', 4]),
        );
        expect(config[0]).toEqual([
            'http.curloptResolve',
            `git.pinned.test:${port}:[::1],127.0.0.1`,
        ]);
        await gitFetch(`http://git.pinned.test:${port}/g/r.git`, config).catch(
            () => undefined,
        );
        // What git asks after that depends on its version (the dumb-protocol
        // fallback); the first request is what reached past the dead ::1.
        expect(reached[0]).toBe(
            'GET /g/r.git/info/refs?service=git-upload-pack',
        );
    });

    it('cloud: every answer is still judged before any is pinned', async () => {
        await expect(
            pinnedGitFetchConfig(
                'https://git.example.com/r.git',
                resolver(['140.82.112.3', 4], ['10.4.0.9', 4]),
            ),
        ).rejects.toHaveProperty(
            'message',
            'Git server host "git.example.com" resolves to a private or reserved address; the call was not sent.',
        );
    });

    describe('through a proxy curl resolves nothing, so nothing is pinned', () => {
        const noLookup = async () => {
            throw new Error('no DNS here');
        };

        it.each([
            [{ HTTPS_PROXY: 'http://proxy.corp:3128' }],
            [{ https_proxy: 'http://proxy.corp:3128' }],
            [{ ALL_PROXY: 'http://proxy.corp:3128' }],
        ])('%j: no lookup, no pin, git as before', async (env) => {
            await expect(
                pinnedGitFetchConfig(
                    'https://github.com/o/r.git',
                    noLookup,
                    'Git server',
                    env,
                ),
            ).resolves.toEqual([]);
        });

        it('a host NO_PROXY names is resolved and pinned as usual', async () => {
            await expect(
                pinnedGitFetchConfig(
                    'https://git.corp.example/o/r.git',
                    resolver(['140.82.112.3', 4]),
                    'Git server',
                    {
                        HTTPS_PROXY: 'http://proxy.corp:3128',
                        NO_PROXY: 'localhost,.corp.example',
                    },
                ),
            ).resolves.toEqual([
                ['http.curloptResolve', 'git.corp.example:443:140.82.112.3'],
                ['http.followRedirects', 'false'],
            ]);
        });

        it('http_proxy does not carry https, as in curl', async () => {
            await expect(
                pinnedGitFetchConfig(
                    'https://git.corp.example/o/r.git',
                    resolver(['140.82.112.3', 4]),
                    'Git server',
                    { http_proxy: 'http://proxy.corp:3128' },
                ),
            ).resolves.toEqual([
                ['http.curloptResolve', 'git.corp.example:443:140.82.112.3'],
                ['http.followRedirects', 'false'],
            ]);
        });

        it('the metadata address typed as the host is refused even so', async () => {
            await expect(
                pinnedGitFetchConfig(
                    'http://169.254.169.254/r.git',
                    noLookup,
                    'Git server',
                    {
                        HTTPS_PROXY: 'http://p:3128',
                        HTTP_PROXY: 'http://p:3128',
                        ALL_PROXY: 'http://p:3128',
                    },
                ),
            ).rejects.toHaveProperty(
                'message',
                'Git server host "169.254.169.254" resolves to a private or reserved address (169.254.169.254); the call was not sent.',
            );
        });
    });

    it('self-hosted: a host this process cannot resolve is left to git, which follows no redirect', async () => {
        // Kody on #2709: git resolves it its own way, so a redirect it would
        // follow is not judged; it goes through withJudgedGitRedirects.
        environment.API_CLOUD_MODE = false;
        await expect(
            pinnedGitFetchConfig('https://git.corp/r.git', async () => {
                throw Object.assign(new Error('getaddrinfo ENOTFOUND'), {
                    code: 'ENOTFOUND',
                });
            }),
        ).resolves.toEqual([['http.followRedirects', 'false']]);
    });

    it('cloud: a host that does not resolve still fails here', async () => {
        await expect(
            pinnedGitFetchConfig('https://git.corp/r.git', async () => {
                throw new Error('getaddrinfo ENOTFOUND');
            }),
        ).rejects.toHaveProperty('message', 'getaddrinfo ENOTFOUND');
    });

    describe('a redirect is followed with every hop judged', () => {
        let target: Server;
        let targetPort: number;
        let targetSeen: Array<{ url: string; ua: string; auth?: string }>;
        let redirector: Server;
        let redirectorPort: number;
        let redirectTo: (url: string) => string;
        let redirectorAuth: Array<string | undefined>;

        beforeAll(async () => {
            target = createServer((req, res) => {
                targetSeen.push({
                    url: req.url ?? '',
                    ua: String(req.headers['user-agent']),
                    auth: req.headers.authorization,
                });
                res.statusCode = 404;
                res.end();
            });
            await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
            targetPort = (target.address() as AddressInfo).port;
            redirector = createServer((req, res) => {
                redirectorAuth.push(req.headers.authorization);
                res.statusCode = 301;
                res.setHeader('location', redirectTo(req.url ?? ''));
                res.end();
            });
            await new Promise<void>((r) =>
                redirector.listen(0, '127.0.0.1', r),
            );
            redirectorPort = (redirector.address() as AddressInfo).port;
        });

        afterAll(async () => {
            await new Promise<void>((r) => target.close(() => r()));
            await new Promise<void>((r) => redirector.close(() => r()));
        });

        beforeEach(() => {
            targetSeen = [];
            redirectorAuth = [];
            environment.API_CLOUD_MODE = false;
            resolvesTo('127.0.0.1');
        });

        const run = (url: string, pin: Array<[string, string]>) =>
            gitFetch(url, pin);

        it('a server that moved (301 to another host) is fetched where it moved to', async () => {
            redirectTo = (path) =>
                `http://127.0.0.1:${targetPort}${path.replace('/g/r.git', '/moved/r.git')}`;
            await withJudgedGitRedirects(
                `http://localhost:${redirectorPort}/g/r.git`,
                'Authorization: Basic c2VjcmV0',
                run,
            ).catch(() => undefined);
            // git and the probe gave the token to the host it was given for;
            // the host it moved to was asked by both, without it.
            expect(redirectorAuth).toEqual([
                'Basic c2VjcmV0',
                'Basic c2VjcmV0',
            ]);
            expect(
                targetSeen.map((r) => ({
                    by: r.ua === 'git/kodus' ? 'probe' : 'git',
                    url: r.url,
                    auth: r.auth,
                })),
            ).toEqual([
                {
                    by: 'probe',
                    url: '/moved/r.git/info/refs?service=git-upload-pack',
                    auth: undefined,
                },
                {
                    by: 'git',
                    url: '/moved/r.git/info/refs?service=git-upload-pack',
                    auth: undefined,
                },
            ]);
        });

        it('a redirect to the metadata service is refused, git never dials it', async () => {
            redirectTo = () =>
                'http://169.254.169.254/latest/meta-data/info/refs?service=git-upload-pack';
            const err = await withJudgedGitRedirects(
                `http://localhost:${redirectorPort}/g/r.git`,
                undefined,
                run,
            ).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(GatewayAddressRefusedError);
        });

        it('a redirect to a name that resolves to the metadata service is refused at that hop', async () => {
            // The first host is reached; the name the redirect gives is
            // resolved and judged when the probe follows it.
            redirectTo = (path) =>
                `http://internal.attacker.test:${targetPort}${path}`;
            resolvesByHost({
                'localhost': '127.0.0.1',
                'internal.attacker.test': '169.254.169.254',
            });
            const err = await withJudgedGitRedirects(
                `http://localhost:${redirectorPort}/g/r.git`,
                undefined,
                run,
            ).then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(GatewayAddressRefusedError);
            expect({
                host: (err as GatewayAddressRefusedError).host,
                address: (err as GatewayAddressRefusedError).address,
            }).toEqual({
                host: 'internal.attacker.test',
                address: '169.254.169.254',
            });
            // git and then the probe asked the redirector; nothing reached
            // the target.
            expect(redirectorAuth).toEqual([undefined, undefined]);
            expect(targetSeen).toEqual([]);
        });

        it('a fetch that failed for another reason is not retried', async () => {
            const runs: string[] = [];
            await expect(
                withJudgedGitRedirects(
                    'https://git.example.com/g/r.git',
                    undefined,
                    async (url) => {
                        runs.push(url);
                        throw Object.assign(new Error('fetch failed'), {
                            stderr: 'fatal: Authentication failed',
                        });
                    },
                    async () => [],
                ),
            ).rejects.toThrow('fetch failed');
            expect(runs).toEqual(['https://git.example.com/g/r.git']);
        });
    });
});

// Review on #2709 (sartorijr92, round 2): a refusal is not a bad token.
// Review on #2709 (Kody): the redirect probe sends the token only to the
// origin it was given for, scheme included: https to http on the same host and
// port would send it in the clear.
describe('the redirect probe keeps the token off a downgrade to http', () => {
    let server: NetServer;
    let port: number;
    let seen: Array<{ scheme: string; url: string; auth?: string }>;
    let certDir: string;
    const trusted = httpsAgent.options.ca;

    beforeAll(async () => {
        certDir = mkdtempSync(join(tmpdir(), 'probe-tls-'));
        execFileSync(
            'openssl',
            [
                'req',
                '-x509',
                '-newkey',
                'rsa:2048',
                '-nodes',
                '-days',
                '1',
                '-subj',
                '/CN=127.0.0.1',
                '-addext',
                'subjectAltName=IP:127.0.0.1',
                '-keyout',
                join(certDir, 'key.pem'),
                '-out',
                join(certDir, 'cert.pem'),
            ],
            { stdio: 'ignore' },
        );
        const handler =
            (scheme: string) => (req: IncomingMessage, res: ServerResponse) => {
                seen.push({
                    scheme,
                    url: req.url ?? '',
                    auth: req.headers.authorization,
                });
                if (scheme === 'https' && req.url?.startsWith('/g/')) {
                    res.statusCode = 301;
                    res.setHeader(
                        'location',
                        `http://127.0.0.1:${port}${req.url.replace('/g/', '/moved/')}`,
                    );
                } else {
                    res.statusCode = 404;
                }
                res.end();
            };
        const plain = createServer(handler('http'));
        const tls = createHttpsServer(
            {
                key: readFileSync(join(certDir, 'key.pem')),
                cert: readFileSync(join(certDir, 'cert.pem')),
            },
            handler('https'),
        );
        // One port, both schemes: a TLS ClientHello opens on 0x16.
        server = createNetServer((socket) => {
            socket.once('data', (first) => {
                socket.pause();
                socket.unshift(first);
                (first[0] === 0x16 ? tls : plain).emit('connection', socket);
                process.nextTick(() => socket.resume());
            });
        });
        await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
        port = (server.address() as AddressInfo).port;
        // The probe uses the default agent: it trusts this test's own cert.
        httpsAgent.options.ca = readFileSync(join(certDir, 'cert.pem'));
    });

    afterAll(async () => {
        httpsAgent.options.ca = trusted;
        await new Promise<void>((r) => server.close(() => r()));
        rmSync(certDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        seen = [];
        environment.API_CLOUD_MODE = false;
        resolvesTo('127.0.0.1');
    });

    it('https to http on the same host and port: followed, without the token', async () => {
        const target = await gitRedirectTarget(
            `https://127.0.0.1:${port}/g/r.git`,
            'Authorization: Basic c2VjcmV0',
        );
        expect(target).toBe(`http://127.0.0.1:${port}/moved/r.git`);
        expect(seen).toEqual([
            {
                scheme: 'https',
                url: '/g/r.git/info/refs?service=git-upload-pack',
                auth: 'Basic c2VjcmV0',
            },
            {
                scheme: 'http',
                url: '/moved/r.git/info/refs?service=git-upload-pack',
                auth: undefined,
            },
        ]);
    }, 20_000);
});

describe('connecting a self-managed server that is refused says why', () => {
    const { GitlabService } = jest.requireActual('./gitlab.service');
    const { BitbucketDataCenterService } = jest.requireActual(
        './bitbucket/bitbucket-data-center.service',
    );
    const noDeps = [{}, {}, {}, { get: () => undefined }, {}] as any[];

    it.each([
        [
            'GitLab',
            () =>
                new GitlabService(...noDeps).authenticateWithToken({
                    token: 'glpat-x',
                    host: 'https://gitlab.attacker.test',
                    organizationAndTeamData: {
                        organizationId: 'o',
                        teamId: 't',
                    },
                }),
        ],
        [
            'Bitbucket Data Center',
            () =>
                new BitbucketDataCenterService(
                    ...noDeps.slice(0, 4),
                ).authenticateWithToken({
                    token: 'bbdc-x',
                    host: 'https://bitbucket.attacker.test',
                    organizationAndTeamData: {
                        organizationId: 'o',
                        teamId: 't',
                    },
                }),
        ],
    ])(
        '%s: cloud, the host resolves to a private address',
        async (_name, call) => {
            resolvesTo('10.0.0.7');
            const err = await call().then(
                () => undefined,
                (e: unknown) => e,
            );
            expect(err).toBeInstanceOf(BadRequestException);
            expect((err as Error).message).toBe(
                'The git server URL resolves to a private or reserved address. Point it at a server reachable on the public internet.',
            );
            expect(reached).toEqual([]);
        },
    );

    it('GitLab: a host rebound to a private address when it connects says so too', async () => {
        // Public to the save check, private to the socket.
        promiseLookup.mockResolvedValue([
            { address: '140.82.112.3', family: 4 },
        ]);
        socketLookup.mockImplementation((_h, options, callback) => {
            const cb = typeof options === 'function' ? options : callback;
            return typeof options === 'object' && options?.all
                ? cb(null, [{ address: '127.0.0.1', family: 4 }])
                : cb(null, '127.0.0.1', 4);
        });
        const err = await new GitlabService(...noDeps)
            .authenticateWithToken({
                token: 'glpat-x',
                host: `http://gitlab.attacker.test:${port}`,
                organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            })
            .then(
                () => undefined,
                (e: unknown) => e,
            );
        expect((err as Error).message).toBe(
            'Git server host "gitlab.attacker.test" resolves to a private or reserved address; the call was not sent.',
        );
        expect(reached).toEqual([]);
    });
});
