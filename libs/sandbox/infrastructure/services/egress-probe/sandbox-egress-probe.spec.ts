import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import {
    classifyDirectProbe,
    repositoryHost,
    sanitizeProbeDetail,
} from './egress-probe';
import {
    EgressProbeRecord,
    EgressProbeRequest,
    EgressProbeStore,
    ProbeSandbox,
    SandboxEgressProbeService,
} from './sandbox-egress-probe.service';

const GITHUB_IP_BLOCK =
    "remote: Although you appear to have the correct authorization credentials, the `acme` organization has an IP allow list enabled, and your IP address is not permitted to access this resource.\nfatal: unable to access 'https://github.com/acme/api.git/': The requested URL returned error: 403";

describe('classifyDirectProbe', () => {
    it('reads a direct listing that worked as "the org does not need the fixed IP"', () => {
        expect(classifyDirectProbe(0, '')).toEqual({ outcome: 'direct_ok' });
    });

    it('reads a GitHub IP allow list refusal as blocked by the allow list', () => {
        expect(classifyDirectProbe(128, GITHUB_IP_BLOCK)).toEqual(
            expect.objectContaining({
                outcome: 'direct_blocked',
                reason: 'ip_allow_list',
            }),
        );
    });

    it('reads a listing that ran out of time as blocked by a timeout (firewall dropping packets)', () => {
        expect(classifyDirectProbe(124, '')).toEqual(
            expect.objectContaining({
                outcome: 'direct_blocked',
                reason: 'timeout',
            }),
        );
    });

    it('reads a refused or unreachable connection as blocked by the network', () => {
        expect(
            classifyDirectProbe(
                128,
                "fatal: unable to access 'https://git.acme.test/x.git/': Failed to connect to git.acme.test port 443: Connection refused",
            ),
        ).toEqual(
            expect.objectContaining({
                outcome: 'direct_blocked',
                reason: 'network',
            }),
        );
    });

    it('keeps a 403 without an allow list message apart, as forbidden', () => {
        expect(
            classifyDirectProbe(
                128,
                "fatal: unable to access 'https://gitlab.com/acme/x.git/': The requested URL returned error: 403",
            ),
        ).toEqual(
            expect.objectContaining({
                outcome: 'direct_blocked',
                reason: 'forbidden',
            }),
        );
    });
});

describe('sanitizeProbeDetail', () => {
    it('never keeps the token, the auth header or credentials in a URL', () => {
        const token = 'ghs_SECRETTOKEN123';
        const header = `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        const detail = sanitizeProbeDetail(
            `fatal: could not read from https://user:${token}@github.com/acme/api.git: ${header}`,
            [token, header],
        );
        expect(detail).not.toContain(token);
        expect(detail).not.toContain(
            Buffer.from(`x-access-token:${token}`).toString('base64'),
        );
        expect(detail).not.toContain(`user:${token}@`);
    });

    it('keeps the line that explains the failure, capped in size', () => {
        const detail = sanitizeProbeDetail(GITHUB_IP_BLOCK, []);
        expect(detail).toContain('IP allow list');
        expect(detail.length).toBeLessThanOrEqual(300);
    });
});

describe('repositoryHost', () => {
    it('is the lower-cased host of the clone URL', () => {
        expect(repositoryHost('https://GitLab.Acme.test:8443/a/b.git')).toBe(
            'gitlab.acme.test:8443',
        );
    });

    it('is null for a URL it cannot read', () => {
        expect(repositoryHost('not a url')).toBeNull();
    });
});

describe('SandboxEgressProbeService', () => {
    const request: EgressProbeRequest = {
        organizationId: '11111111-1111-4111-8111-111111111111',
        teamId: '22222222-2222-4222-8222-222222222222',
        platform: PlatformType.GITHUB,
        cloneUrl: 'https://github.com/acme/api.git',
        authToken: 'ghs_SECRETTOKEN123',
    };

    const fakeStore = (claimable = true) => {
        const records: EgressProbeRecord[] = [];
        const store: EgressProbeStore = {
            claim: jest.fn(async () => claimable),
            record: jest.fn(async (r: EgressProbeRecord) => {
                records.push(r);
            }),
        };
        return { store, records };
    };

    const fakeSandbox = (exitCode: number, stderr = ''): ProbeSandbox => ({
        run: jest.fn(async () => ({ exitCode, stdout: '', stderr })),
        kill: jest.fn(async () => undefined),
    });

    const build = (opts: {
        enabled?: boolean;
        store: EgressProbeStore;
        sandbox?: ProbeSandbox | Error;
    }) => {
        const createSandbox = jest.fn(async () => {
            if (opts.sandbox instanceof Error) throw opts.sandbox;
            return opts.sandbox ?? fakeSandbox(0);
        });
        const service = new SandboxEgressProbeService({
            store: opts.store,
            createSandbox,
            isEnabled: async () => opts.enabled ?? true,
            now: () => new Date('2026-11-14T12:00:00Z'),
        });
        return { service, createSandbox };
    };

    it('does nothing while the rollout flag is off for the org', async () => {
        const { store, records } = fakeStore();
        const { service, createSandbox } = build({ enabled: false, store });
        await service.probe(request);
        expect(createSandbox).not.toHaveBeenCalled();
        expect(records).toHaveLength(0);
    });

    it('probes an org and host at most once per day', async () => {
        const { store, records } = fakeStore(false);
        const { service, createSandbox } = build({ store });
        await service.probe(request);
        expect(createSandbox).not.toHaveBeenCalled();
        expect(records).toHaveLength(0);
    });

    it('records that the org needs the fixed IP when the direct listing is refused', async () => {
        const { store, records } = fakeStore();
        const sandbox = fakeSandbox(128, GITHUB_IP_BLOCK);
        const { service } = build({ store, sandbox });
        await service.probe(request);
        expect(records).toEqual([
            expect.objectContaining({
                organizationId: request.organizationId,
                host: 'github.com',
                platform: PlatformType.GITHUB,
                outcome: 'direct_blocked',
                reason: 'ip_allow_list',
            }),
        ]);
        expect(sandbox.kill).toHaveBeenCalled();
    });

    it('records that the org does not need the fixed IP when the direct listing works', async () => {
        const { store, records } = fakeStore();
        const { service } = build({ store, sandbox: fakeSandbox(0) });
        await service.probe(request);
        expect(records).toEqual([
            expect.objectContaining({ outcome: 'direct_ok' }),
        ]);
    });

    it('never stores the token anywhere in the record', async () => {
        const { store, records } = fakeStore();
        const sandbox = fakeSandbox(
            128,
            `fatal: https://x:${request.authToken}@github.com/acme/api.git denied`,
        );
        const { service } = build({ store, sandbox });
        await service.probe(request);
        expect(JSON.stringify(records)).not.toContain(request.authToken);
    });

    it('lists the repository without ever putting the token on the command line', async () => {
        const { store } = fakeStore();
        const sandbox = fakeSandbox(0);
        const { service } = build({ store, sandbox });
        await service.probe(request);
        const [cmd, opts] = (sandbox.run as jest.Mock).mock.calls.find(
            ([c]: [string]) => c.includes('ls-remote'),
        );
        expect(cmd).not.toContain(request.authToken);
        expect(cmd).toContain('ls-remote --heads');
        expect(JSON.stringify(opts.envs)).toContain('GIT_AUTH_HEADER');
    });

    it('records nothing and does not throw when the probe sandbox cannot be created', async () => {
        const { store, records } = fakeStore();
        const { service } = build({
            store,
            sandbox: new Error('E2B capacity'),
        });
        await expect(service.probe(request)).resolves.toBeUndefined();
        expect(records).toHaveLength(0);
    });

    it('skips a repository without a token: an anonymous clone needs no allow list', async () => {
        const { store } = fakeStore();
        const { service, createSandbox } = build({ store });
        await service.probe({ ...request, authToken: '' });
        expect(createSandbox).not.toHaveBeenCalled();
    });

    it('runs one probe at a time per worker and drops the rest, so reviews keep the sandbox capacity', async () => {
        const { store } = fakeStore();
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const slow: ProbeSandbox = {
            run: jest.fn(async () => {
                await gate;
                return { exitCode: 0, stdout: '', stderr: '' };
            }),
            kill: jest.fn(async () => undefined),
        };
        const { service, createSandbox } = build({ store, sandbox: slow });
        const runs = [
            service.probe({ ...request, organizationId: 'a' }),
            service.probe({ ...request, organizationId: 'b' }),
            service.probe({ ...request, organizationId: 'c' }),
        ];
        await new Promise((r) => setImmediate(r));
        release();
        await Promise.all(runs);
        expect(createSandbox).toHaveBeenCalledTimes(1);
    });
});
