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
    RuntimeSandboxService,
    toGuestPath,
} from '@libs/sandbox/infrastructure/providers/runtime-sandbox.service';
import {
    deleteImmediateSandbox,
    isImmediateCleanupSandbox,
    runtimeSandboxId,
    setRuntimeSandboxReleaser,
} from '@libs/sandbox/infrastructure/services/immediate-sandbox-cleanup';
import { selectSandboxProvider } from '@libs/sandbox/modules/sandbox.module';

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
