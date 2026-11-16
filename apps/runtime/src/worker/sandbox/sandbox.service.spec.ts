import { Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { AddressInfo } from 'net';

import { ENV_SESSION_SIGNATURE_HEADER, signEnvSessionRequest } from '@libs/runtime/contracts/env-session';
import { SANDBOX_ROUTES } from '@libs/runtime/contracts/sandbox';

import { claimIdFor } from '../../shared/claim-id';
import { startEnvSessionServer } from '../env-session/env-session-server';
import { SandboxError, type SandboxHub, SandboxService } from './sandbox.service';
import { InMemorySnapshotPlacements } from '../../shared/persistence/testing';

// The worker's sandbox routes (docs/runtime/sandbox.md): a sandbox is its
// org's claim on the hub, found from the org and sandboxId alone.

function fakeHub(answers: Record<string, unknown>) {
    const posts: { url: string; path: string; body: any }[] = [];
    const hub: SandboxHub = {
        hubBaseUrl: 'http://hub-any',
        async post<T>(url: string, path: string, body: unknown) {
            posts.push({ url, path, body });
            const key = Object.keys(answers).find((k) => path.endsWith(k));
            return answers[key!] as T;
        },
        async replicaForClaim() {
            return 'http://hub-1';
        },
        async reserveCell() {
            return { cellId: 'cell-a', replicaUrl: 'http://hub-1', owner: 'kodus' } as any;
        },
    };
    return { hub, posts };
}

describe('code sandbox on the worker', () => {
    const sandboxId = randomUUID();
    const claimId = claimIdFor('org-a', `sandbox:${sandboxId}`);

    it("opens the org's sandbox claim on the reserved cell and every op goes to that claim", async () => {
        const { hub, posts } = fakeHub({
            '/sandbox': { claimId, cellId: 'cell-a', leaseExpiresAt: 'L', hardExpiresAt: 'H', manifest: {}, observer: {} },
            '/sandbox-op': { ok: true, size: 3 },
        });
        const s = new SandboxService({ hub, isStopped: async () => false });
        expect(await s.open({ organizationId: 'org-a', sandboxId, egressAllow: ['github.com'] })).toEqual({ sandboxId, state: 'ready', cellId: 'cell-a', leaseExpiresAt: 'L', hardExpiresAt: 'H' });
        expect(posts[0]).toEqual({ url: 'http://hub-1', path: '/internal/cells/cell-a/sandbox', body: { organizationId: 'org-a', idempotencyKey: `sandbox:${sandboxId}`, egressAllow: ['github.com'] } });
        const stepId = randomUUID();
        expect(await s.op({ organizationId: 'org-a', sandboxId, stepId, op: { op: 'stat' } })).toEqual({ ok: true, size: 3 });
        expect(posts[1]).toEqual({ url: 'http://hub-1', path: `/internal/claims/${encodeURIComponent(claimId)}/sandbox-op`, body: { organizationId: 'org-a', runId: null, stepId, op: { op: 'stat' } } });
    });

    it('a sandbox the cell could not boot comes back blocked, and an ended one answers not found', async () => {
        const { hub } = fakeHub({
            '/sandbox': { status: 'blocked', blockers: [{ kind: 'platform', signature: 'sandbox_unsupported', message: 'this cell runs no code sandboxes' }] },
            '/sandbox-op': { code: 'lease_expired' },
        });
        const s = new SandboxService({ hub, isStopped: async () => false });
        expect(await s.open({ organizationId: 'org-a', sandboxId })).toMatchObject({ state: 'blocked', blockers: [{ signature: 'sandbox_unsupported' }] });
        await expect(s.op({ organizationId: 'org-a', sandboxId, stepId: randomUUID(), op: { op: 'stat' } })).rejects.toMatchObject({ status: 404, code: 'lease_expired' });
    });

    it("a template opens a sandbox that prepares it, runs its steps, keeps it under its key and releases the sandbox", async () => {
        const { hub, posts } = fakeHub({
            '/sandbox': { claimId, cellId: 'cell-a', leaseExpiresAt: 'L', hardExpiresAt: 'H', manifest: {}, observer: {} },
            '/sandbox-op': { ok: true, exec: { exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1 } },
            '/snapshot': { id: 'ksn-0123456789abcdef0123456789abcdef', purpose: 'template', ms: 8500 },
            '/release': { ok: true },
        });
        const s = new SandboxService({ hub, isStopped: async () => false });
        const steps = [{ op: 'exec' as const, command: 'git clone --depth 1 https://github.com/org/repo repo', timeoutMs: 60_000 }];
        expect(await s.template({ organizationId: 'org-a', sandboxId, templateKey: 'repo:org-repo', egressAllow: ['github.com'], steps })).toEqual({
            snapshotId: 'ksn-0123456789abcdef0123456789abcdef',
            purpose: 'template',
            ms: 8500,
        });
        expect(posts.map((p) => p.path.split('/').pop())).toEqual(['sandbox', 'sandbox-op', 'snapshot', 'release']);
        expect(posts[0].body).toEqual({ organizationId: 'org-a', idempotencyKey: `sandbox:${sandboxId}`, egressAllow: ['github.com'], prepares: true, templateKey: 'repo:org-repo' });
        expect(posts[2].body).toMatchObject({ organizationId: 'org-a', runId: null, purpose: 'template' });
    });

    it('a template step that fails leaves no template and still releases the sandbox', async () => {
        const { hub, posts } = fakeHub({
            '/sandbox': { claimId, cellId: 'cell-a', leaseExpiresAt: 'L', hardExpiresAt: 'H', manifest: {}, observer: {} },
            '/sandbox-op': { ok: true, exec: { exitCode: 128, stdout: '', stderr: 'fatal', truncated: false, durationMs: 1 } },
            '/release': { ok: true },
        });
        const s = new SandboxService({ hub, isStopped: async () => false });
        await expect(s.template({ organizationId: 'org-a', sandboxId, templateKey: 'repo:a', steps: [{ op: 'exec', command: 'false', timeoutMs: 1000 }] })).rejects.toMatchObject({ code: 'template_step_failed' });
        expect(posts.map((p) => p.path.split('/').pop())).toEqual(['sandbox', 'sandbox-op', 'release']);
    });

    it("a sandbox starts from its key's template and keeps sessions and rounds, never a template of its own", async () => {
        const { hub, posts } = fakeHub({
            '/sandbox': { claimId, cellId: 'cell-a', leaseExpiresAt: 'L', hardExpiresAt: 'H', manifest: {}, observer: {} },
            '/snapshot': { id: 'ksn-0123456789abcdef0123456789abcdef', purpose: 'session', ms: 300 },
        });
        const s = new SandboxService({ hub, isStopped: async () => false });
        await s.open({ organizationId: 'org-a', sandboxId, templateKey: 'repo:a' });
        expect(posts[0].body).toMatchObject({ templateKey: 'repo:a' });
        expect(posts[0].body).not.toHaveProperty('prepares');
        expect(await s.snapshot({ organizationId: 'org-a', sandboxId, stepId: randomUUID(), purpose: 'session' })).toMatchObject({ purpose: 'session' });
        await expect(s.snapshot({ organizationId: 'org-a', sandboxId, stepId: randomUUID(), purpose: 'template' })).rejects.toMatchObject({ code: 'not_template_source' });
    });

    it('no sandbox opens while the org is stopped', async () => {
        const { hub, posts } = fakeHub({});
        const s = new SandboxService({ hub, isStopped: async () => true });
        await expect(s.open({ organizationId: 'org-a', sandboxId })).rejects.toBeInstanceOf(SandboxError);
        expect(posts).toHaveLength(0);
    });

    it('the listener serves a signed sandbox write of a whole chunk, and refuses an unsigned one', async () => {
        const key = Buffer.alloc(32, 7);
        const ops: unknown[] = [];
        const server = await startEnvSessionServer({
            port: 0,
            host: '127.0.0.1',
            key,
            service: {} as any,
            sandboxes: { open: jest.fn(), renew: jest.fn(), release: jest.fn(), snapshot: jest.fn(), template: jest.fn(), op: async (r) => (ops.push(r), { ok: true, written: 524_288 }) },
        });
        try {
            const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${SANDBOX_ROUTES.op}`;
            const body = JSON.stringify({ organizationId: 'org-a', sandboxId, stepId: randomUUID(), op: { op: 'write', path: 'repo/big.bin', content: Buffer.alloc(524_288, 1).toString('base64') } });
            const signed = await fetch(url, { method: 'POST', body, headers: { [ENV_SESSION_SIGNATURE_HEADER]: signEnvSessionRequest(key, { method: 'POST', path: SANDBOX_ROUTES.op, body, at: Date.now() }) } });
            expect(signed.status).toBe(200);
            expect(await signed.json()).toEqual({ ok: true, written: 524_288 });
            const unsigned = await fetch(url, { method: 'POST', body });
            expect(unsigned.status).toBe(401);
            expect(ops).toHaveLength(1);
        } finally {
            await new Promise((r) => server.close(r));
        }
    });
});

describe('where a sandbox that starts from a memory snapshot is reserved', () => {
    const key = 'deps-node-22';
    function hubOn(cellOfSnapshot: string) {
        const reserved: Array<{ prefer?: string }> = [];
        const hub: SandboxHub = {
            hubBaseUrl: 'http://hub-any',
            async post<T>(_url: string, path: string, body: any) {
                if (path.endsWith('/sandbox')) return { claimId: 'c', cellId: 'cell-b', leaseExpiresAt: 'L', hardExpiresAt: 'H', manifest: {}, observer: {} } as T;
                if (path.endsWith('/snapshot')) return { id: 'ksn-0123456789abcdef0123456789abcdef', purpose: body.purpose, ms: 5, cellId: cellOfSnapshot } as T;
                return { ok: true } as T;
            },
            async replicaForClaim() {
                return 'http://hub-1';
            },
            async reserveCell(_org, want) {
                reserved.push({ ...(want?.prefer ? { prefer: want.prefer } : {}) });
                return { cellId: 'cell-b', replicaUrl: 'http://hub-1', owner: 'kodus' } as any;
            },
        };
        return { hub, reserved };
    }

    it('prefers the cell that made the template for a sandbox of its key, and never for the sandbox that makes it', async () => {
        const { hub, reserved } = hubOn('cell-t');
        const placements = new InMemorySnapshotPlacements();
        const s = new SandboxService({ hub, isStopped: async () => false, placements });
        await s.template({ organizationId: 'org-a', sandboxId: randomUUID(), templateKey: key, steps: [] });
        await s.open({ organizationId: 'org-a', sandboxId: randomUUID(), templateKey: key });
        await s.open({ organizationId: 'org-b', sandboxId: randomUUID(), templateKey: key });
        expect(reserved).toEqual([{}, { prefer: 'cell-t' }, {}]);
    });

    it('prefers the cell that took a session for the sandbox that resumes it', async () => {
        const { hub, reserved } = hubOn('cell-s');
        const placements = new InMemorySnapshotPlacements();
        const s = new SandboxService({ hub, isStopped: async () => false, placements });
        const view = await s.snapshot({ organizationId: 'org-a', sandboxId: randomUUID(), stepId: randomUUID(), purpose: 'session' });
        await s.open({ organizationId: 'org-a', sandboxId: randomUUID(), resumeFrom: view.snapshotId });
        expect(reserved).toEqual([{ prefer: 'cell-s' }]);
    });

    it('reserves any cell when the placement store fails', async () => {
        const { hub, reserved } = hubOn('cell-t');
        const broken = { record: async () => Promise.reject(new Error('db down')), cellOf: async () => Promise.reject(new Error('db down')) };
        const s = new SandboxService({ hub, isStopped: async () => false, placements: broken });
        await s.template({ organizationId: 'org-a', sandboxId: randomUUID(), templateKey: key, steps: [] });
        await s.open({ organizationId: 'org-a', sandboxId: randomUUID(), templateKey: key });
        expect(reserved).toEqual([{}, {}]);
    });

    it("warns when a PR session's cell cannot be recorded, since the PR's close would not find it, and still answers the session", async () => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        try {
            const { hub } = hubOn('cell-s');
            const sandboxId = randomUUID();
            const broken = { record: async () => Promise.reject(Object.assign(new Error('postgres://user:pw@db down'), { code: 'ECONNREFUSED' })), cellOf: async () => undefined };
            const s = new SandboxService({ hub, isStopped: async () => false, placements: broken });
            const view = await s.snapshot({ organizationId: 'org-a', sandboxId, stepId: randomUUID(), purpose: 'session', pullRequest: { repositoryId: 'repo-1', prNumber: 7 } });
            expect(view.purpose).toBe('session');
            expect(warn).toHaveBeenCalledWith(expect.objectContaining({ msg: 'sandbox.placement_record_failed', organizationId: 'org-a', sandboxId, error: { kind: 'network', code: 'ECONNREFUSED' } }));
            expect(JSON.stringify(warn.mock.calls)).not.toContain('pw@');
        } finally {
            warn.mockRestore();
        }
    });
});
