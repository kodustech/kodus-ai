import type { AddressInfo } from 'net';

import {
    ENV_SESSION_MAX_LIVE_PER_KEY,
    ENV_SESSION_SIGNATURE_HEADER,
    envSessionKeyFrom,
    envSessionTokenBinding,
    signEnvSessionRequest,
    verifyEnvSessionRequest,
} from '@libs/runtime/contracts/env-session';
import type { AcquireRequest, Blocked, Claim, EnvironmentRuntime, ExecRequest, StepResult } from '@libs/runtime/environment';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { startEnvSessionServer } from './env-session-server';
import { EnvSessionError, EnvSessionService } from './env-session.service';
import { InMemoryEnvSessionStore } from './env-session.store';

const ORG = 'org-a';
const OWNER = { organizationId: ORG, teamId: 'team-a', keyId: 'key-a', repositoryIds: ['repo-a'] };
const SHA = 'a'.repeat(40);
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const STEP = '33333333-3333-4333-8333-333333333333';

const setup = (over: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
    environmentId: 'env-a',
    organizationId: ORG,
    repositoryId: 'repo-a',
    key: 'k',
    state: 'active',
    refSource: 'default_branch',
    sha: SHA,
    steps: [],
    blockers: [],
    imageId: 'img-1',
    expose: [{ service: 'web', port: 3000, kind: 'http' }] as any,
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content: 'services: {}' } as any,
    requestedAt: '2026-11-03T10:00:00.000Z',
    updatedAt: '2026-11-03T10:00:00.000Z',
    ...over,
});

const claim: Claim = {
    claimId: 'claim-1',
    cellId: 'cell-1',
    cellOwner: 'kodus',
    leaseExpiresAt: '2026-11-03T14:00:00.000Z',
    hardExpiresAt: '2026-11-03T16:00:00.000Z',
    observer: { id: 'o', state: 'ready' },
    manifest: { services: [{ name: 'web', health: 'ok' }], expose: [], imageId: 'img-1', seedSha: SHA },
};

function harness(opts: { acquire?: (r: AcquireRequest) => Promise<Claim | Blocked>; setup?: EnvironmentSetupRecord | null; stopped?: boolean; execError?: string } = {}) {
    let now = new Date('2026-11-03T12:00:00.000Z');
    const warnings: Array<Record<string,unknown>> = [];
    const calls = { acquire: [] as AcquireRequest[], exec: [] as ExecRequest[], release: [] as string[], envInputs: [] as any[] };
    const env: EnvironmentRuntime = {
        acquire: async (r) => (calls.acquire.push(r), opts.acquire ? opts.acquire(r) : claim),
        exec: async (_c, r): Promise<StepResult> => {
            calls.exec.push(r);
            if (opts.execError) throw new Error(opts.execError);
            return { stepId: r.stepId, exitCode: 0, stdout: 'v22.1.0\n', stderr: '', truncated: false, durationMs: 12, transport: 'ok' };
        },
        probe: async () => ({}) as any,
        reset: async () => undefined,
        release: async (id) => void calls.release.push(id),
    };
    const store = new InMemoryEnvSessionStore();
    const service = new EnvSessionService({
        store,
        setups: { get: async () => (opts.setup === undefined ? setup() : opts.setup) },
        environment: (input) => (calls.envInputs.push(input), env),
        isStopped: async () => !!opts.stopped,
        now: () => now,
        openWaitMs: 50,
        onWarn: (msg,meta) => warnings.push({msg,...meta}),
    });
    return { service, store, calls, warnings, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

const open = (over: Record<string, unknown> = {}) => ({
    ...OWNER,
    repositoryId: 'repo-a',
    environmentId: 'env-a',
    sessionId: S1,
    sha: SHA,
    repositoryFullName: 'acme/shop',
    sealedRepoToken: 'sealed:v1:x',
    correlationId: 'c1',
    ...over,
});

describe('EnvSessionService (consumer mcp)', () => {
    it('acquires with consumer mcp, the setup recipe and the PR side, and the token sealed to the session', async () => {
        const h = harness();
        const view = await h.service.open(open());
        expect(view).toMatchObject({ sessionId: S1, state: 'ready', services: [{ name: 'web', health: 'ok' }], leaseExpiresAt: claim.leaseExpiresAt });
        expect(view).not.toHaveProperty('claimId');
        expect(h.calls.acquire[0]).toMatchObject({
            consumer: 'mcp',
            ref: { side: 'pr', sha: SHA },
            idempotencyKey: `mcp:${S1}`,
            imageId: 'img-1',
            recipe: { content: 'services: {}' },
        });
        expect(h.calls.envInputs[0]).toMatchObject({ tokenBinding: envSessionTokenBinding(S1), sealedRepoToken: 'sealed:v1:x', expose: setup().expose });
    });

    it('acquires at the machine size the setup booted with, and none when it recorded none', async () => {
        const sized = harness({ setup: setup({ machineSize: { memoryMb: 16_384, cpus: 8 } }) });
        await sized.service.open(open());
        expect(sized.calls.acquire[0].size).toEqual({ memoryMb: 16_384, cpus: 8 });
        const plain = harness();
        await plain.service.open(open());
        expect(plain.calls.acquire[0]).not.toHaveProperty('size');
    });

    it('answers blocked with the setup blockers when the environment is not active, and acquires nothing', async () => {
        const h = harness({
            setup: setup({
                state: 'blocked',
                blockers: [{ kind: 'toolchain', signature: 'toolchain:node', message: 'node 18 found, 22 needed', at: 'x' } as any],
            }),
        });
        const view = await h.service.open(open());
        expect(view.state).toBe('blocked');
        expect(view.blockers).toEqual([{ kind: 'toolchain', signature: 'toolchain:node', message: 'node 18 found, 22 needed' }]);
        expect(h.calls.acquire).toHaveLength(0);
    });

    it("refuses a setup of another org's environment as never set up", async () => {
        const h = harness({ setup: setup({ organizationId: 'org-b' }) });
        expect((await h.service.open(open())).blockers?.[0].signature).toBe('no_setup');
        expect(h.calls.acquire).toHaveLength(0);
    });

    it('opens nothing for a repo outside the key list', async () => {
        const h = harness();
        await expect(h.service.open(open({ repositoryIds: ['repo-b'] }))).rejects.toMatchObject({ status: 404 });
        expect(h.calls.acquire).toHaveLength(0);
    });

    it('opens nothing while the Runtime is stopped for the org', async () => {
        const h = harness({ stopped: true });
        await expect(h.service.open(open())).rejects.toMatchObject({ status: 409, code: 'runtime_stopped' });
    });

    it('caps live sessions per key', async () => {
        const h = harness();
        for (let i = 0; i < ENV_SESSION_MAX_LIVE_PER_KEY; i++) await h.service.open(open({ sessionId: `${i}1111111-1111-4111-8111-111111111111` }));
        await expect(h.service.open(open({ sessionId: S2 }))).rejects.toMatchObject({ status: 429, code: 'key_session_quota' });
    });

    it('exec answers the stepId at once and env_step reads the result later', async () => {
        const h = harness();
        await h.service.open(open());
        const started = await h.service.exec({ ...OWNER, sessionId: S1, stepId: STEP, command: 'node -v', timeoutMs: 30_000 });
        expect(started).toMatchObject({ stepId: STEP, state: 'running' });
        await h.service.settle();
        expect(await h.service.step(OWNER, STEP)).toMatchObject({ state: 'done', exitCode: 0, stdout: 'v22.1.0\n' });
        expect(h.calls.exec).toEqual([{ stepId: STEP, command: 'node -v', timeoutMs: 30_000 }]);
    });

    it.each([
        ['another org', { organizationId: 'org-b' }],
        ['another team', { teamId: 'team-b' }],
        ['a key that no longer reaches the repo', { repositoryIds: ['repo-b'] }],
        ['another key', { keyId: 'key-b' }],
    ])('S-46: %s gets 404 on exec, step and release, and nothing reaches the cell', async (_name, other) => {
        const h = harness();
        await h.service.open(open());
        await h.service.exec({ ...OWNER, sessionId: S1, stepId: STEP, command: 'true', timeoutMs: 5_000 });
        await h.service.settle();
        const foreign = { ...OWNER, ...other };
        const execCalls = h.calls.exec.length;
        await expect(h.service.exec({ ...foreign, sessionId: S1, stepId: S2, command: 'cat /etc/passwd', timeoutMs: 5_000 })).rejects.toMatchObject({
            status: 404,
        });
        await expect(h.service.step(foreign, STEP)).rejects.toMatchObject({ status: 404 });
        await expect(h.service.close(foreign, S1)).rejects.toMatchObject({ status: 404 });
        await expect(h.service.get(foreign, S1)).rejects.toMatchObject({ status: 404 });
        expect(h.calls.exec).toHaveLength(execCalls);
        expect(h.calls.release).toHaveLength(0);
    });

    it('releases an idle session on the next call and refuses exec on it', async () => {
        const h = harness();
        await h.service.open(open());
        h.advance(11 * 60_000);
        await expect(h.service.exec({ ...OWNER, sessionId: S1, stepId: STEP, command: 'true', timeoutMs: 5_000 })).rejects.toBeInstanceOf(EnvSessionError);
        expect((await h.service.get(OWNER, S1)).state).toBe('expired');
        expect(h.calls.release).toEqual(['claim-1']);
        expect(h.calls.exec).toHaveLength(0);
    });

    it('the sweep releases idle sessions of any org', async () => {
        const h = harness();
        await h.service.open(open());
        h.advance(11 * 60_000);
        expect(await h.service.sweep()).toBe(1);
        expect(h.calls.release).toEqual(['claim-1']);
    });

    it('env_down releases the claim once; a second call is a no-op', async () => {
        const h = harness();
        await h.service.open(open());
        expect((await h.service.close(OWNER, S1)).state).toBe('released');
        expect((await h.service.close(OWNER, S1)).state).toBe('released');
        expect(h.calls.release).toEqual(['claim-1']);
    });

    it('a session released while it was booting gives the claim back when it arrives', async () => {
        let resolve!: (c: Claim) => void;
        const h = harness({ acquire: () => new Promise((r) => (resolve = r)) });
        expect((await h.service.open(open())).state).toBe('acquiring');
        await h.service.close(OWNER, S1);
        resolve(claim);
        await h.service.settle();
        expect(h.calls.release).toEqual(['claim-1']);
        expect((await h.service.get(OWNER, S1)).state).toBe('released');
    });

    it('a step that stops reporting past its timeout is lost', async () => {
        const h = harness();
        await h.service.open(open());
        await h.store.insertStep({
            stepId: STEP,
            sessionId: S1,
            organizationId: ORG,
            command: 'sleep 1',
            timeoutMs: 1_000,
            state: 'running',
            startedAt: '2026-11-03T12:00:00.000Z',
        });
        h.advance(2 * 60_000);
        expect((await h.service.step(OWNER, STEP)).state).toBe('lost');
    });
});

describe('env-session listener', () => {
    const key = envSessionKeyFrom(Buffer.alloc(32, 7));
    let server: Awaited<ReturnType<typeof startEnvSessionServer>>;
    let base: string;
    const h = harness();

    beforeAll(async () => {
        server = await startEnvSessionServer({ service: h.service, key, port: 0, host: '127.0.0.1' });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => {
        await new Promise((r) => server.close(r));
    });

    const post = (path: string, body: unknown, sign: Buffer | null = key, at = Date.now()) => {
        const raw = JSON.stringify(body);
        return fetch(`${base}${path}`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                ...(sign ? { [ENV_SESSION_SIGNATURE_HEADER]: signEnvSessionRequest(sign, { method: 'POST', path, body: raw, at }) } : {}),
            },
            body: raw,
        });
    };

    it('refuses an unsigned, wrongly signed or stale request', async () => {
        expect((await post('/env/sessions', open(), null)).status).toBe(401);
        expect((await post('/env/sessions', open(), envSessionKeyFrom(Buffer.alloc(32, 8)))).status).toBe(401);
        expect((await post('/env/sessions', open(), key, Date.now() - 5 * 60_000)).status).toBe(401);
    });

    it('opens, execs and reads a step over signed calls; a foreign owner is 404', async () => {
        const opened = await post('/env/sessions', open());
        expect(opened.status).toBe(200);
        expect(((await opened.json()) as any).state).toBe('ready');
        const exec = await post(`/env/sessions/${S1}/exec`, { ...OWNER, stepId: STEP, command: 'node -v', timeoutMs: 30_000 });
        expect(((await exec.json()) as any).state).toBe('running');
        await h.service.settle();
        expect(((await (await post(`/env/steps/${STEP}`, OWNER)).json()) as any).exitCode).toBe(0);
        expect((await post(`/env/steps/${STEP}`, { ...OWNER, keyId: 'key-b' })).status).toBe(404);
        expect((await post(`/env/sessions/${S1}/exec`, { ...OWNER, stepId: STEP, command: 'x', timeoutMs: 999_999 })).status).toBe(400);
    });

    it('a signature covers the path: replaying a body on another route fails', () => {
        const raw = JSON.stringify(OWNER);
        const sig = signEnvSessionRequest(key, { method: 'POST', path: `/env/steps/${STEP}`, body: raw, at: 1_000 });
        expect(verifyEnvSessionRequest(key, sig, { method: 'POST', path: `/env/sessions/${S1}/release`, body: raw, now: 1_000 })).toBe(false);
        expect(verifyEnvSessionRequest(key, sig, { method: 'POST', path: `/env/steps/${STEP}`, body: raw, now: 1_000 })).toBe(true);
    });
});


describe('explicit pinned recipe validation', () => {
    const content = 'version: 1\nvalidate: [{name: Unit tests, run: pnpm test}]\n';
    it('pins the default-branch check, not a later setup or guest command', async () => {
        const record = setup({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content } as any });
        const h = harness({ setup: record });
        await h.service.open(open());
        record.recipe = {
            path: '.kodus/workspace.yaml',
            sha: 'b'.repeat(40),
            state: 'found',
            content: content.replace('pnpm test', 'malicious command'),
        } as any;
        const resolved = await h.service.validation(OWNER, S1, 'Unit tests');
        expect(resolved).toMatchObject({ session: { sessionId: S1 }, name: 'Unit tests', command: 'pnpm test', recipeSha: SHA });
        expect(resolved.recipeDigest).toMatch(/^[0-9a-f]{64}$/);
        await h.service.exec({
            ...OWNER,
            sessionId: S1,
            stepId: STEP,
            command: resolved.command,
            timeoutMs: 1000,
            validationName: resolved.name,
            executionScope: 'workload',
        });
        await h.service.settle();
        expect(h.calls.exec[0]).toMatchObject({ command: 'pnpm test', executionScope: 'workload' });
        expect((await h.service.get(OWNER, S1)).state).toBe('ready');
    });
    it.each([
        ['development override', { refSource: 'dev_override' as const }],
        ['missing provenance', { refSource: undefined }],
        ['mismatched recipe SHA', { sha: 'b'.repeat(40) }],
    ])('refuses validation authority from %s', async (_label, provenance) => {
        const h = harness({
            setup: setup({
                recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content } as any,
                ...provenance,
            }),
        });
        await h.service.open(open());
        expect((await h.service.get(OWNER, S1)).state).toBe('ready');
        expect((await h.store.get(ORG, S1))?.validationSnapshot).toBeUndefined();
        await expect(h.service.validation(OWNER, S1, 'Unit tests')).rejects.toMatchObject({
            code: 'validation_snapshot_unavailable',
        });
        await expect(
            h.service.exec({
                ...OWNER,
                sessionId: S1,
                stepId: STEP,
                command: 'pnpm test',
                timeoutMs: 1000,
                validationName: 'Unit tests',
                executionScope: 'workload',
            }),
        ).rejects.toMatchObject({ code: 'validation_snapshot_unavailable' });
        expect(h.calls.exec).toEqual([]);
    });
    it('refuses unknown, missing-snapshot and foreign checks without dispatch', async () => {
        const h = harness({ setup: setup({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content } as any }) });
        await h.service.open(open());
        await expect(h.service.validation(OWNER, S1, 'unknown')).rejects.toMatchObject({ code: 'validation_not_found' });
        await expect(h.service.validation({ ...OWNER, keyId: 'other' }, S1, 'Unit tests')).rejects.toMatchObject({ status: 404 });
        await h.store.update(ORG, S1, { validationSnapshot: undefined } as any);
        const row = h.store.sessions.get(S1)!;
        delete (row as any).validationSnapshot;
        await expect(h.service.validation(OWNER, S1, 'Unit tests')).rejects.toMatchObject({ code: 'validation_snapshot_unavailable' });
        expect(h.calls.exec).toEqual([]);
    });
    it('never logs raw execution exceptions from validation', async () => {
        const h = harness({
            execError: 'PRIVATE command or connection detail',
            setup: setup({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content } as any }),
        });
        await h.service.open(open());
        await h.service.exec({
            ...OWNER,
            sessionId: S1,
            stepId: STEP,
            command: 'pnpm test',
            timeoutMs: 1000,
            validationName: 'Unit tests',
            executionScope: 'workload',
        });
        await h.service.settle();
        expect(h.warnings).toMatchObject([{ msg: 'env_session.exec_failed', error: 'execution_unavailable' }]);
        expect(JSON.stringify(h.warnings)).not.toContain('PRIVATE');
        expect(await h.service.step(OWNER, STEP)).toMatchObject({ state: 'done', error: 'cell_unavailable' });
    });
    it('opens one canonical claim when the same session is delivered concurrently', async () => {
        const h = harness({ setup: setup({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content } as any }) });
        await Promise.all([h.service.open(open()), h.service.open(open())]);
        await h.service.settle();
        expect(h.calls.acquire).toHaveLength(1);
        expect((await h.service.validation(OWNER, S1, 'Unit tests')).command).toBe('pnpm test');
    });
    it('refuses a released lease without returning command authority', async () => {
        const h = harness({ setup: setup({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content } as any }) });
        await h.service.open(open());
        await h.service.close(OWNER, S1);
        await expect(h.service.validation(OWNER, S1, 'Unit tests')).rejects.toMatchObject({ code: 'session_not_ready' });
        expect(h.calls.exec).toEqual([]);
    });
    it('refuses a caller replacing pinned command/cwd or omitting workload scope', async () => {
        const h = harness({ setup: setup({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content } as any }) });
        await h.service.open(open());
        for (const extra of [
            { command: 'other', executionScope: 'workload' },
            { command: 'pnpm test', cwd: '/tmp', executionScope: 'workload' },
            { command: 'pnpm test' },
        ]) {
            await expect(
                h.service.exec({ ...OWNER, sessionId: S1, stepId: STEP, timeoutMs: 1000, validationName: 'Unit tests', ...extra } as any),
            ).rejects.toMatchObject({ code: 'validation_mismatch' });
        }
        expect(h.calls.exec).toEqual([]);
    });
});
