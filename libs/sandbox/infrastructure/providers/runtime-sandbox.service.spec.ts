import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { E2BSandboxService } from '@libs/sandbox/infrastructure/providers/e2b-sandbox.service';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';
import { RuntimeSandboxError } from '@libs/sandbox/infrastructure/providers/runtime-sandbox.client';
import { NullSandboxProvider } from '@libs/sandbox/infrastructure/providers/null-sandbox.service';
import {
    cloneHost,
    lineRange,
    RuntimeSandbox,
    RuntimeSandboxService,
    toGuestPath,
    toolLayerPlans,
} from '@libs/sandbox/infrastructure/providers/runtime-sandbox.service';
import {
    deleteImmediateSandbox,
    isImmediateCleanupSandbox,
    runtimeSandboxId,
    setRuntimeSandboxReleaser,
} from '@libs/sandbox/infrastructure/services/immediate-sandbox-cleanup';
import { SandboxReadBudget } from '@libs/sandbox/infrastructure/providers/sandbox-read-budget';
import { selectSandboxProvider } from '@libs/sandbox/modules/select-sandbox-provider';

const SEAL = 'ab'.repeat(32);
const conf = (env: Record<string, string>) =>
    ({ get: (k: string) => env[k] }) as any;

describe('which sandbox a deployment runs', () => {
    it.each([
        [
            'an E2B key, in auto',
            {
                API_E2B_KEY: 'k',
                RUNTIME_SANDBOX_URL: 'http://rt:7000',
                RUNTIME_SECRET_SEAL_KEY: SEAL,
            },
            E2BSandboxService,
        ],
        [
            // The cell serves the Runtime's release track only: auto never moves every org's review onto it.
            'the runtime sandbox URL and the seal key, in auto, stays local',
            {
                RUNTIME_SANDBOX_URL: 'http://rt:7000',
                RUNTIME_SECRET_SEAL_KEY: SEAL,
            },
            LocalSandboxService,
        ],
        [
            'runtime by name, through the runtime sandbox URL',
            {
                SANDBOX_PROVIDER: 'runtime',
                RUNTIME_SANDBOX_URL: 'http://rt:7000',
                RUNTIME_SECRET_SEAL_KEY: SEAL,
            },
            RuntimeSandboxService,
        ],
        [
            'only the env-session URL, in auto (it says nothing about sandboxes)',
            {
                RUNTIME_ENV_SESSION_URL: 'http://rt:7000',
                RUNTIME_SECRET_SEAL_KEY: SEAL,
            },
            LocalSandboxService,
        ],
        ['nothing, in auto', {}, LocalSandboxService],
        [
            'local by name, with the runtime configured',
            {
                SANDBOX_PROVIDER: 'local',
                RUNTIME_SANDBOX_URL: 'http://rt:7000',
                RUNTIME_SECRET_SEAL_KEY: SEAL,
            },
            LocalSandboxService,
        ],
        [
            'runtime by name, reached through the env-session URL',
            {
                SANDBOX_PROVIDER: 'runtime',
                RUNTIME_ENV_SESSION_URL: 'http://rt:7000',
                RUNTIME_SECRET_SEAL_KEY: SEAL,
            },
            RuntimeSandboxService,
        ],
        [
            'null by name',
            { SANDBOX_PROVIDER: 'null', API_E2B_KEY: 'k' },
            NullSandboxProvider,
        ],
    ])('%s', (_name, env, kind) => {
        const p = selectSandboxProvider(conf(env));
        expect(p).toBeInstanceOf(kind);
        if (p instanceof RuntimeSandboxService)
            expect(p.isAvailable()).toBe(true);
    });
});

describe('a runtime sandbox ends with its last lease', () => {
    it('is released on its cell, by org and sandbox, never idle-killed through E2B', async () => {
        const released: unknown[] = [];
        setRuntimeSandboxReleaser(async (ref) => void released.push(ref));
        const id = runtimeSandboxId(
            'org-a',
            '0b6f2c1e-8d3a-4f5b-9c7e-1a2b3c4d5e6f',
        );
        expect(isImmediateCleanupSandbox(id)).toBe(true);
        await deleteImmediateSandbox(id);
        expect(released).toEqual([
            {
                organizationId: 'org-a',
                sandboxId: '0b6f2c1e-8d3a-4f5b-9c7e-1a2b3c4d5e6f',
            },
        ]);
        // An E2B id is still the E2B path's.
        expect(isImmediateCleanupSandbox('ihx7m3k2p0abc')).toBe(false);
        setRuntimeSandboxReleaser(undefined);
    });
});

describe('what the runtime sandbox reads', () => {
    it('cuts a line range exactly as the other providers’ sed does', () => {
        const dir = mkdtempSync(join(tmpdir(), 'kr-sed-'));
        for (const text of ['a\nb\nc\n', 'a\nb\nc', 'only', '', '\n\n']) {
            writeFileSync(join(dir, 'f'), text);
            for (const [s, e] of [
                [0, 0],
                [1, 1],
                [2, 3],
                [0, 2],
                [3, 9],
                [5, 6],
            ]) {
                const sed =
                    s === 0 && e === 0
                        ? text
                        : execFileSync('sed', [
                              '-n',
                              `${Math.max(s, 1)},${e}p`,
                              join(dir, 'f'),
                          ]).toString();
                expect([text, s, e, lineRange(text, s, e)]).toEqual([
                    text,
                    s,
                    e,
                    sed,
                ]);
            }
        }
        expect(() => lineRange('a', 1.5, 2)).toThrow('Invalid line range');
    });

    it('reaches files under /workspace only', () => {
        expect(toGuestPath('/workspace/repo/a.ts')).toBe('repo/a.ts');
        expect(toGuestPath('repo/a.ts')).toBe('repo/a.ts');
        for (const p of [
            '/etc/passwd',
            '/workspace/../etc/passwd',
            '/workspace',
            'repo/../../x',
            '/workspacex/a',
        ])
            expect(() => toGuestPath(p)).toThrow('outside the sandbox root');
    });

    it('lets the sandbox reach the git host of the clone and no other', () => {
        expect(cloneHost('https://github.com/acme/app.git')).toBe('github.com');
        expect(cloneHost('https://GitLab.Example.com:8443/g/r.git')).toBe(
            'gitlab.example.com',
        );
        expect(cloneHost('file:///tmp/repo.git')).toBeUndefined();
    });
});

describe('the lease of a runtime sandbox', () => {
    const TEN_MINUTES = 10 * 60_000;
    const fakeClient = () => {
        const calls: string[] = [];
        const client = {
            configured: true,
            open: jest.fn(async () => ({ state: 'ready' })),
            op: jest.fn(async (_ref: unknown, _step: string, op: any) =>
                op.op === 'exec'
                    ? { ok: true, exec: { stdout: '', stderr: '', exitCode: 0 } }
                    : { ok: true, content: '', eof: true },
            ),
            renew: jest.fn(async () => void calls.push('renew')),
            release: jest.fn(async () => void calls.push('release')),
            seal: jest.fn(async () => ({ sealed: true })),
        };
        return { client, calls };
    };
    const params = {
        organizationId: 'org-a',
        cloneUrl: 'https://github.com/acme/app.git',
        branch: 'main',
        platform: 'github',
    } as any;

    beforeEach(() => jest.useFakeTimers());
    afterEach(() => {
        jest.useRealTimers();
        setRuntimeSandboxReleaser(undefined);
    });

    it('stops renewing once the lease manager ends the sandbox, not only through its own cleanup', async () => {
        const { client } = fakeClient();
        const provider = new RuntimeSandboxService(conf({}), client as any);
        const sandbox = await provider.createSandboxWithRepo(params);

        await jest.advanceTimersByTimeAsync(TEN_MINUTES);
        expect(client.renew).toHaveBeenCalledTimes(1);

        // The lease manager and the review stage replace cleanup: the last release goes through here.
        await deleteImmediateSandbox(sandbox.sandboxId!);
        expect(client.release).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(5 * TEN_MINUTES);
        expect(client.renew).toHaveBeenCalledTimes(1);
    });

    it("returns a command's own output that reads like the spill notice, instead of reading spill files that were never kept", async () => {
        const { client } = fakeClient();
        client.op.mockImplementation(async (_ref: unknown, _step: string, op: any) =>
            op.op === 'exec'
                ? op.command.includes('grep-the-marker')
                    ? { ok: true, exec: { stdout: 'KODY-RUNTIME-SANDBOX-SPILLED\n', stderr: '', exitCode: 0 } }
                    : { ok: true, exec: { stdout: '', stderr: '', exitCode: 0 } }
                : { ok: true, content: '', eof: true },
        );
        const provider = new RuntimeSandboxService(conf({}), client as any);
        const sandbox = await provider.createSandboxWithRepo(params);
        const reads = client.op.mock.calls.filter(([, , op]: any) => op.op === 'read').length;

        await expect(sandbox.run!('grep-the-marker')).resolves.toEqual({
            stdout: 'KODY-RUNTIME-SANDBOX-SPILLED\n',
            stderr: '',
            exitCode: 0,
        });
        expect(client.op.mock.calls.filter(([, , op]: any) => op.op === 'read')).toHaveLength(reads);
    });

    it('stops renewing a sandbox the cell no longer has', async () => {
        const { client } = fakeClient();
        client.renew.mockRejectedValue(
            new RuntimeSandboxError(404, 'not_found', 'no such sandbox'),
        );
        const provider = new RuntimeSandboxService(conf({}), client as any);
        await provider.createSandboxWithRepo(params);

        await jest.advanceTimersByTimeAsync(TEN_MINUTES);
        await jest.advanceTimersByTimeAsync(3 * TEN_MINUTES);
        expect(client.renew).toHaveBeenCalledTimes(1);
    });
});

describe('the egress of a runtime sandbox for a review', () => {
    const params = {
        organizationId: 'org-a',
        cloneUrl: 'https://github.com/acme/app.git',
        branch: 'feature',
        baseBranch: 'main',
        prNumber: 7,
        platform: 'github',
        authToken: 'ghs_token',
    } as any;
    const recording = () => {
        const events: string[] = [];
        const client = {
            configured: true,
            open: jest.fn(async () => (events.push('open'), { state: 'ready' })),
            op: jest.fn(async (_ref: unknown, _step: string, op: any) => {
                events.push(op.op === 'exec' ? `exec:${String(op.command)}` : op.op);
                return op.op === 'exec'
                    ? { ok: true, exec: { stdout: '', stderr: '', exitCode: 0 } }
                    : { ok: true, content: '', eof: true };
            }),
            renew: jest.fn(async () => undefined),
            release: jest.fn(async () => void events.push('release')),
            seal: jest.fn(async () => (events.push('seal'), { sealed: true })),
        };
        return { client, events };
    };

    it('is sealed right after the clone, the base fetch and the submodules, and not before', async () => {
        const { client, events } = recording();
        const sandbox = await new RuntimeSandboxService(conf({}), client as any).createSandboxWithRepo(params);
        expect(client.seal).toHaveBeenCalledTimes(1);
        expect(client.seal).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a' }));
        const at = events.indexOf('seal');
        const before = events.slice(0, at);
        expect(before.some((e) => e.includes('git init'))).toBe(true);
        expect(before.some((e) => e.includes('refs/remotes/origin/'))).toBe(true);
        // Nothing the checkout needs comes after the seal; the sandbox is handed out sealed.
        expect(events.slice(at + 1)).toEqual([]);
        expect(sandbox.type).toBe('runtime');
        await sandbox.cleanup();
    });

    it('is never handed out when the seal fails: it is released and the review runs without a sandbox', async () => {
        const { client, events } = recording();
        client.seal.mockRejectedValue(new RuntimeSandboxError(409, 'cell_unavailable', 'the cell did not seal it'));
        await expect(new RuntimeSandboxService(conf({}), client as any).createSandboxWithRepo(params)).rejects.toMatchObject({ code: 'cell_unavailable' });
        expect(client.release).toHaveBeenCalledTimes(1);
        expect(events.at(-1)).toBe('release');
    });

    it('is not confirmed by an answer that is not the seal', async () => {
        const { RuntimeSandboxClient } = await import('@libs/sandbox/infrastructure/providers/runtime-sandbox.client');
        const answer = (body: unknown, status = 200) => jest.fn(async () => ({ status, text: async () => JSON.stringify(body) }));
        const client = (fetchImpl: any) => new RuntimeSandboxClient({ baseUrl: 'http://worker', secretSealKey: SEAL }, fetchImpl);
        const ref = { organizationId: 'org-a', sandboxId: '4c9c4d2a-1b7f-4d50-9d5b-0d1f3a6e8b11' };
        await expect(client(answer({ sealed: true })).seal(ref)).resolves.toEqual({ sealed: true });
        await expect(client(answer({ ok: true })).seal(ref)).rejects.toMatchObject({ code: 'seal_unconfirmed' });
        await expect(client(answer({ code: 'cell_unavailable' }, 409)).seal(ref)).rejects.toMatchObject({ status: 409, code: 'cell_unavailable' });
        await expect(client(jest.fn(async () => Promise.reject(new Error('down')))).seal(ref)).rejects.toMatchObject({ code: 'runtime_unreachable' });
        const sent = answer({ sealed: true });
        await client(sent).seal(ref);
        expect(sent.mock.calls[0] as unknown[]).toEqual([expect.stringMatching(/\/sandbox\/seal$/), expect.objectContaining({ body: JSON.stringify(ref), headers: expect.objectContaining({ 'content-type': 'application/json' }) })]);
    });

    it('sends no op, and no seal, when the sandbox did not start', async () => {
        const { client } = recording();
        client.open.mockResolvedValue({ state: 'blocked', blockers: [{ signature: 'no_capacity', message: 'full' }] } as any);
        await expect(new RuntimeSandboxService(conf({}), client as any).createSandboxWithRepo(params)).rejects.toMatchObject({ code: 'no_capacity' });
        expect(client.op).not.toHaveBeenCalled();
        expect(client.seal).not.toHaveBeenCalled();
    });

    it('is not sealed when the checkout fails, and the sandbox is released', async () => {
        const { client } = recording();
        client.op.mockImplementation(async (_r: unknown, _s: string, op: any) =>
            op.op === 'exec' && String(op.command).includes('git init') ? { ok: true, exec: { stdout: '', stderr: 'boom', exitCode: 128 } } : { ok: true, exec: { stdout: '', stderr: '', exitCode: 0 } },
        );
        await expect(new RuntimeSandboxService(conf({}), client as any).createSandboxWithRepo(params)).rejects.toBeDefined();
        expect(client.seal).not.toHaveBeenCalled();
        expect(client.release).toHaveBeenCalledTimes(1);
    });
});

describe('what the worker holds of a runtime sandbox’s answers (a shared worker, 2026-11-20 OOM)', () => {
    const CHUNK = 512 * 1024;
    /** A sandbox whose every file is `size` bytes of the letter a, one chunk per op. */
    const sandboxOf = (size: number, budget = new SandboxReadBudget(64 * 1024 * 1024)) => {
        let peak = 0;
        const client = {
            op: jest.fn(async (_ref: unknown, _id: string, op: any) => {
                peak = Math.max(peak, budget.inUse);
                const length = Math.max(0, Math.min(op.length, size - op.offset));
                return { ok: true, content: Buffer.alloc(length, 'a').toString('base64'), eof: op.offset + length >= size };
            }),
        };
        const sb = new RuntimeSandbox(client as any, { organizationId: 'o', sandboxId: 's' }, budget);
        return { sb, client, peak: () => peak, budget };
    };

    it("the agent's read pulls at most 4 MiB of a huge file and says the rest was not read", async () => {
        const { sb, client } = sandboxOf(900 * 1024 * 1024);
        const out = await sb.remoteCommands().read('big.txt', 0, 0);
        expect(client.op.mock.calls.length).toBeLessThanOrEqual((4 * 1024 * 1024) / CHUNK + 1);
        expect(out.length).toBeLessThanOrEqual(4 * 1024 * 1024 + 300);
        expect(out).toContain('only its first 4 MiB were read');
    });

    it('a small file reads whole, with no note', async () => {
        const { sb } = sandboxOf(1000);
        expect(await sb.remoteCommands().read('a.txt', 0, 0)).toBe('a'.repeat(1000));
    });

    it('parallel reads never hold more than the budget at once, and all finish', async () => {
        const budget = new SandboxReadBudget(8 * 1024 * 1024);
        const { sb, peak } = sandboxOf(3 * 1024 * 1024, budget);
        const reads = await Promise.all(Array.from({ length: 6 }, (_, i) => sb.readBytes(`f${i}`, 4 * 1024 * 1024)));
        expect(reads.every((r) => r.data.length === 3 * 1024 * 1024)).toBe(true);
        expect(peak()).toBeLessThanOrEqual(8 * 1024 * 1024);
        expect(budget.inUse).toBe(0);
    });

    it('gives its bytes back when a read fails', async () => {
        const budget = new SandboxReadBudget(8 * 1024 * 1024);
        const client = { op: jest.fn(async () => ({ ok: false, error: { code: 'not_found' } })) };
        const sb = new RuntimeSandbox(client as any, { organizationId: 'o', sandboxId: 's' }, budget);
        await expect(sb.readBytes('gone')).rejects.toThrow('read gone');
        expect(budget.inUse).toBe(0);
    });
});

describe('team CLIs installed into a runtime sandbox before its seal', () => {
    const params = {
        organizationId: 'org-a',
        cloneUrl: 'https://github.com/acme/app.git',
        branch: 'main',
        platform: 'github',
        cliInstalls: [
            {
                id: 'kcliabc',
                argv: ['npm', 'install', 'left-pad@1.3.0'],
                binary: 'left-pad',
                egressAllow: ['registry.npmjs.org'],
            },
        ],
    } as any;
    const make = (installStdout: string, exitCode = 0) => {
        const order: string[] = [];
        const client = {
            configured: true,
            open: jest.fn(async () => ({ state: 'ready' })),
            op: jest.fn(async (_r: unknown, _s: string, op: any) => {
                if (op.op !== 'exec')
                    return { ok: true, content: '', eof: true };
                const isInstall = op.command.includes('KODUS_CLI_BINARY');
                if (isInstall) order.push('install');
                return {
                    ok: true,
                    exec: {
                        stdout: isInstall ? installStdout : '',
                        stderr: '',
                        exitCode: isInstall ? exitCode : 0,
                    },
                };
            }),
            renew: jest.fn(async () => undefined),
            release: jest.fn(async () => undefined),
            seal: jest.fn(async () => {
                order.push('seal');
                return { sealed: true };
            }),
        };
        return { client, order };
    };

    it('opens the sandbox to the install hosts, installs as the review user into /workspace, then seals', async () => {
        const home = '/workspace/.kcli/kcliabc';
        const { client, order } = make(
            `KODUS_CLI_BINARY=${home}/node_modules/left-pad/cli.js\nKODUS_CLI_INTERPRETER=node\n`,
        );
        const sandbox = await new RuntimeSandboxService(
            conf({}),
            client as any,
        ).createSandboxWithRepo(params);

        expect(client.open.mock.calls[0][0].egressAllow).toEqual([
            'github.com',
            'registry.npmjs.org',
        ]);
        expect(order).toEqual(['install', 'seal']);
        expect(sandbox.cliInstalls).toEqual({
            kcliabc: {
                home,
                binaryPath: `${home}/node_modules/left-pad/cli.js`,
                interpreter: 'node',
            },
        });
    });

    it('keeps the sandbox, still sealed, when an install fails', async () => {
        const { client, order } = make('', 3);
        const sandbox = await new RuntimeSandboxService(
            conf({}),
            client as any,
        ).createSandboxWithRepo(params);

        expect(order).toEqual(['install', 'seal']);
        expect(sandbox.cliInstalls!.kcliabc.binaryPath).toBeUndefined();
        expect(sandbox.cliInstalls!.kcliabc.error).toMatch(/install failed/);
    });

    it('ignores a binary path outside its prefix', async () => {
        const { client } = make('KODUS_CLI_BINARY=/usr/bin/evil\n');
        const sandbox = await new RuntimeSandboxService(
            conf({}),
            client as any,
        ).createSandboxWithRepo(params);
        expect(sandbox.cliInstalls!.kcliabc.binaryPath).toBeUndefined();
    });

    it('adds nothing to the egress when no CLI is asked for', async () => {
        const { client } = make('');
        await new RuntimeSandboxService(conf({}), client as any).createSandboxWithRepo({
            ...params,
            cliInstalls: undefined,
        });
        expect(client.open.mock.calls[0][0].egressAllow).toEqual(['github.com']);
    });
});

describe('team CLIs from tool layers of the cell (docs/runtime/persistent-state.md section 4)', () => {
    const install = (id: string, over: Record<string, unknown> = {}) => ({
        id,
        argv: ['npm', 'install', '--ignore-scripts', '-g', `${id}@1.2.3`],
        binary: id,
        egressAllow: ['registry.npmjs.org'],
        ...over,
    });
    const params = (...ids: string[]) =>
        ({
            organizationId: 'org-a',
            cloneUrl: 'https://github.com/acme/app.git',
            branch: 'main',
            platform: 'github',
            cliInstalls: ids.map((id) => install(id)),
        }) as any;
    const hit = (id: string, over: Record<string, unknown> = {}) => ({
        id,
        state: 'hit',
        binaryPath: `/opt/kcli/${id}/.local/bin/${id}`,
        interpreter: 'node',
        ...over,
    });
    const miss = (id: string) => ({ id, state: 'miss' });
    /** A client whose open answers `toolLayers`; the install script prints a binary under the workspace prefix. */
    const make = (toolLayers?: unknown[], opts: { mkdirExit?: number } = {}) => {
        const commands: string[] = [];
        const client = {
            configured: true,
            open: jest.fn(async () => ({ state: 'ready', ...(toolLayers ? { toolLayers } : {}) })),
            op: jest.fn(async (_r: unknown, _s: string, op: any) => {
                if (op.op !== 'exec') return { ok: true, content: '', eof: true };
                commands.push(op.command);
                if (op.command.includes('KODUS_CLI_BINARY')) {
                    const id = /\/workspace\/\.kcli\/([a-z0-9]+)/.exec(op.command)![1];
                    const home = `/workspace/.kcli/${id}`;
                    return { ok: true, exec: { stdout: `KODUS_CLI_BINARY=${home}/node_modules/.bin/${id}\nKODUS_CLI_INTERPRETER=node\n`, stderr: '', exitCode: 0 } };
                }
                if (op.command.includes("mkdir -p '/workspace/.kcli/")) return { ok: true, exec: { stdout: '', stderr: '', exitCode: opts.mkdirExit ?? 0 } };
                return { ok: true, exec: { stdout: '', stderr: '', exitCode: 0 } };
            }),
            renew: jest.fn(async () => undefined),
            release: jest.fn(async () => undefined),
            seal: jest.fn(async () => ({ sealed: true })),
        };
        const installs = () => commands.filter((c) => c.includes('KODUS_CLI_BINARY'));
        return { client, commands, installs };
    };
    const create = (client: unknown, p: unknown) => new RuntimeSandboxService(conf({}), client as any).createSandboxWithRepo(p as any);

    it('plans the npm and pnpm installs of one registry and asks the sandbox for them, the registry still in egressAllow', async () => {
        const { client } = make();
        await create(client, params('kcliabc'));
        const open = client.open.mock.calls[0][0] as any;
        expect(open.toolLayers).toEqual([{ id: 'kcliabc', installer: 'npm', argv: ['npm', 'install', '--ignore-scripts', '-g', 'kcliabc@1.2.3'], binary: 'kcliabc', registry: 'registry.npmjs.org' }]);
        // The hub takes a held layer's registry out of the egress; the provider asks for it as it always did.
        expect(open.egressAllow).toEqual(['github.com', 'registry.npmjs.org']);
    });

    it('skips the install of a held layer and runs its CLI from the mount, with a throwaway home', async () => {
        const { client, installs, commands } = make([hit('kcliabc')]);
        const sandbox = await create(client, params('kcliabc'));
        expect(installs()).toEqual([]);
        expect(commands.some((c) => c.includes("mkdir -p '/workspace/.kcli/kcliabc/.cache/npm'"))).toBe(true);
        expect(client.seal).toHaveBeenCalledTimes(1);
        expect(sandbox.cliInstalls).toEqual({
            kcliabc: {
                home: '/workspace/.kcli/kcliabc',
                prefix: '/opt/kcli/kcliabc',
                binaryPath: '/opt/kcli/kcliabc/.local/bin/kcliabc',
                interpreter: 'node',
            },
        });
    });

    it('installs a layer that missed exactly as today, into the workspace prefix', async () => {
        const { client, installs } = make([miss('kcliabc')]);
        const sandbox = await create(client, params('kcliabc'));
        expect(installs()).toHaveLength(1);
        expect(sandbox.cliInstalls).toEqual({
            kcliabc: { home: '/workspace/.kcli/kcliabc', binaryPath: '/workspace/.kcli/kcliabc/node_modules/.bin/kcliabc', interpreter: 'node' },
        });
        expect(sandbox.cliInstalls!.kcliabc.prefix).toBeUndefined();
    });

    it('works per CLI: a held one is mounted and the one that missed is installed', async () => {
        const { client, installs } = make([hit('kclihit'), miss('kclimiss')]);
        const sandbox = await create(client, params('kclihit', 'kclimiss'));
        expect(installs()).toHaveLength(1);
        expect(installs()[0]).toContain('kclimiss@1.2.3');
        expect(installs()[0]).not.toContain('kclihit@1.2.3');
        expect(sandbox.cliInstalls!.kclihit.prefix).toBe('/opt/kcli/kclihit');
        expect(sandbox.cliInstalls!.kclimiss.prefix).toBeUndefined();
    });

    it('opens again without toolLayers when an older runtime refuses the field, and installs as today', async () => {
        const { client, installs } = make(undefined);
        client.open
            .mockImplementationOnce(async () => {
                throw new RuntimeSandboxError(400, 'invalid_body', 'The runtime answered 400');
            });
        const sandbox = await create(client, params('kcliabc'));
        expect(client.open).toHaveBeenCalledTimes(2);
        expect((client.open.mock.calls[1][0] as any).toolLayers).toBeUndefined();
        expect((client.open.mock.calls[1][0] as any).egressAllow).toEqual(['github.com', 'registry.npmjs.org']);
        expect(installs()).toHaveLength(1);
        expect(sandbox.cliInstalls!.kcliabc.binaryPath).toBe('/workspace/.kcli/kcliabc/node_modules/.bin/kcliabc');
    });

    it('does not open again when a body without toolLayers is refused', async () => {
        const { client } = make(undefined);
        client.open.mockImplementation(async () => {
            throw new RuntimeSandboxError(400, 'invalid_body', 'The runtime answered 400');
        });
        await expect(create(client, { ...params(), cliInstalls: [] })).rejects.toThrow('400');
        expect(client.open).toHaveBeenCalledTimes(1);
    });

    it('installs everything as today when the cell answers no layer (an older cell or no digest)', async () => {
        const { client, installs } = make(undefined);
        const sandbox = await create(client, params('kcliabc'));
        expect(installs()).toHaveLength(1);
        expect(sandbox.cliInstalls!.kcliabc.binaryPath).toBe('/workspace/.kcli/kcliabc/node_modules/.bin/kcliabc');
    });

    it.each([
        ['a path outside its own mount', hit('kcliabc', { binaryPath: '/opt/kcli/other/bin/x' })],
        ['a path that climbs out of it', hit('kcliabc', { binaryPath: '/opt/kcli/kcliabc/../x' })],
        ['an interpreter it does not know', hit('kcliabc', { interpreter: 'perl' })],
        ['no path', hit('kcliabc', { binaryPath: undefined })],
    ])('does not trust a hit with %s, so the CLI is installed', async (_name, answer) => {
        const { client, installs } = make([answer]);
        const sandbox = await create(client, params('kcliabc'));
        expect(installs()).toHaveLength(1);
        expect(sandbox.cliInstalls!.kcliabc.prefix).toBeUndefined();
    });

    it('installs the CLI when the throwaway home cannot be made', async () => {
        const { client, installs } = make([hit('kcliabc')], { mkdirExit: 1 });
        const sandbox = await create(client, params('kcliabc'));
        expect(installs()).toHaveLength(1);
        expect(sandbox.cliInstalls!.kcliabc.prefix).toBeUndefined();
    });

    it('seals after a held layer, as after an install', async () => {
        const { client } = make([hit('kcliabc')]);
        await create(client, params('kcliabc'));
        expect(client.seal).toHaveBeenCalledTimes(1);
    });

    describe('toolLayerPlans', () => {
        it('plans only what a layer can hold: npm or pnpm, one registry, not the git host, a valid mount name', () => {
            const plans = toolLayerPlans(
                [
                    install('kcliok'),
                    install('kclipnpm', { argv: ['pnpm', 'add', '-g', 'x@1.0.0'] }),
                    install('kclipip', { argv: ['pip', 'install', 'x==1.0.0'] }),
                    install('kcliso', { egressAllow: ['a.example.com', 'b.example.com'] }),
                    install('kclino', { egressAllow: [] }),
                    install('kcligit', { egressAllow: ['github.com'] }),
                    install('Bad_Id'),
                    install('kcliok'),
                ],
                'github.com',
            );
            expect(plans.map((p) => `${p.id}:${p.installer}`)).toEqual(['kcliok:npm', 'kclipnpm:pnpm']);
        });

        it('plans at most the layers one sandbox mounts', () => {
            const many = Array.from({ length: 12 }, (_, i) => install(`kcli${i}`));
            expect(toolLayerPlans(many, 'github.com')).toHaveLength(8);
        });

        it('plans nothing without installs', () => {
            expect(toolLayerPlans(undefined, 'github.com')).toEqual([]);
        });
    });
});
