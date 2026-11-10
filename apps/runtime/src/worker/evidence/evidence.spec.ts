import { promises as fs } from 'fs';
import type { AddressInfo } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { RuntimeRunAccessService } from '@libs/runtime/api/application/run-access.service';
import { GetRuntimeRunEvidenceUseCase } from '@libs/runtime/api/application/use-cases/get-run-evidence.use-case';
import { evidenceKey, InvalidEvidenceKeyError, signEvidenceUrl, signUploadGrant } from '@libs/runtime/api/domain/evidence';
import { loadRuntimeApiConfig } from '@libs/runtime/api/infrastructure/runtime-api.config';
import { realAuthorization, run, storeWith, user } from '@libs/runtime/api/__tests__/fixtures';

import { shopRunRequest } from '../../e2e/fixtures';
import { FileEvidenceStore, InMemoryEvidenceStore } from '../../shared/evidence/file-evidence-store';
import { inMemoryRunDeps } from '../run/in-memory-deps';
import { runRuntimeRun } from '../run/run-orchestrator';
import { startEvidenceServer } from './evidence-server';

const SECRET = 'dev-only-runtime-evidence-signing-secret-000000';
const STEP = '0b9e6c1e-6a6f-5d2e-9c1a-1f2e3d4c5b6a';

describe('dev evidence store, server and route', () => {
    let dir: string;
    let store: FileEvidenceStore;
    let server: Awaited<ReturnType<typeof startEvidenceServer>>;
    let base: string;

    beforeAll(async () => {
        dir = await fs.mkdtemp(join(tmpdir(), 'kr-evidence-'));
        store = new FileEvidenceStore(dir);
        server = await startEvidenceServer({ store, secret: SECRET, port: 0, host: '127.0.0.1' });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((r) => server.close(r));
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('stores one 0600 file per exact key and refuses anything that is not a canonical key', async () => {
        const key = evidenceKey({ organizationId: 'org-a', runId: 'run-1', side: 'pr', stepId: STEP, type: 'output' });
        await store.put(key, '{"status":500}', 'application/json');
        expect((await store.get(key))?.body.toString()).toBe('{"status":500}');
        expect((await fs.stat(join(dir, 'org-a/run-1/pr', STEP, 'output'))).mode & 0o777).toBe(0o600);
        expect(await store.get(key.replace('output', 'trace'))).toBeNull();
        for (const bad of ['org-a/run-1/pr/../output', 'org-a/run-1/vm/' + STEP + '/output', '../../etc/passwd', `org-a/run-1/pr/${STEP.toUpperCase()}/output`]) {
            await expect(store.put(bad, 'x', 'text/plain')).rejects.toBeInstanceOf(InvalidEvidenceKeyError);
        }
    });

    it('serves only a signed, unexpired URL for the exact key, as an attachment with a sandbox CSP', async () => {
        const key = evidenceKey({ organizationId: 'org-a', runId: 'run-2', side: 'base', stepId: STEP, type: 'output' });
        await store.put(key, '<script>alert(1)</script>', 'application/json');
        const { url } = signEvidenceUrl({ baseUrl: base, key, secret: SECRET, ttlSeconds: 300 });
        const ok = await fetch(url);
        expect(ok.status).toBe(200);
        expect(ok.headers.get('content-disposition')).toBe(`attachment; filename="base-${STEP}-output.json"`);
        expect(ok.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        expect(ok.headers.get('x-content-type-options')).toBe('nosniff');
        expect(ok.headers.get('cache-control')).toBe('private, no-store');
        expect(await ok.text()).toBe('<script>alert(1)</script>');

        // The signature binds the key: another org's object with this sig is 403.
        expect((await fetch(url.replace('org-a', 'org-b'))).status).toBe(403);
        const unsigned = new URL(url);
        unsigned.searchParams.delete('sig');
        expect((await fetch(unsigned)).status).toBe(403);
        const expired = signEvidenceUrl({ baseUrl: base, key, secret: SECRET, ttlSeconds: 1, now: new Date(Date.now() - 10_000) });
        expect((await fetch(expired.url)).status).toBe(403);
        const missing = signEvidenceUrl({ baseUrl: base, key: key.replace('run-2', 'run-3'), secret: SECRET, ttlSeconds: 300 });
        expect((await fetch(missing.url)).status).toBe(404);
        expect((await fetch(`${base}/..%2F..%2Fetc%2Fpasswd?exp=1&sig=x`)).status).toBe(404);
        expect((await fetch(url, { method: 'POST' })).status).toBe(405);
    });

    it('serves a stored type outside the evidence types as bytes, and ignores any disposition asked in the URL', async () => {
        const key = evidenceKey({ organizationId: 'org-a', runId: 'run-4', side: 'pr', stepId: STEP, type: 'app_log' });
        await store.put(key, '<html><script>alert(1)</script></html>', 'text/html; charset=utf-8');
        const signed = new URL(signEvidenceUrl({ baseUrl: base, key, secret: SECRET, ttlSeconds: 300 }).url);
        signed.searchParams.set('disposition', 'inline');
        const res = await fetch(signed);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/octet-stream');
        expect(res.headers.get('content-disposition')).toBe(`attachment; filename="pr-${STEP}-app_log.bin"`);
        expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
    });

    it('lets another origin embed a screenshot or a video by its signed URL, and nothing else (ADR-071)', async () => {
        const shot = evidenceKey({ organizationId: 'org-a', runId: 'run-5', side: 'pr', stepId: STEP, type: 'screenshot-0' });
        const video = evidenceKey({ organizationId: 'org-a', runId: 'run-5', side: 'pr', stepId: STEP, type: 'video' });
        const har = evidenceKey({ organizationId: 'org-a', runId: 'run-5', side: 'pr', stepId: STEP, type: 'har' });
        await store.put(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]), 'image/png');
        await store.put(video, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'video/webm');
        await store.put(har, '{"log":{}}', 'application/json');
        const get = (key: string) => fetch(signEvidenceUrl({ baseUrl: base, key, secret: SECRET, ttlSeconds: 300 }).url);
        for (const [key, type] of [[shot, 'image/png'], [video, 'video/webm']] as const) {
            const res = await get(key);
            expect(res.headers.get('content-type')).toBe(type);
            expect(res.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
            // Still an attachment with a sandbox CSP: shown only as an <img> or a <video>, never as a page.
            expect(res.headers.get('content-disposition')).toMatch(/^attachment;/);
            expect(res.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'");
        }
        expect((await get(har)).headers.get('cross-origin-resource-policy')).toBe('same-origin');
    });

    it('GET /runtime/runs/:id/evidence/:stepId, configured as in the dev compose, mints a URL the server answers', async () => {
        const r = run();
        const key = evidenceKey({ organizationId: r.organizationId, runId: r.runId, side: 'pr', stepId: STEP, type: 'output' });
        await store.put(key, '{"probe":"ok"}', 'application/json');
        const config = loadRuntimeApiConfig({ RUNTIME_EVIDENCE_BASE_URL: base, RUNTIME_EVIDENCE_SIGNING_SECRET: SECRET } as unknown as NodeJS.ProcessEnv);
        const access = new RuntimeRunAccessService(await storeWith(r), realAuthorization());
        const useCase = new GetRuntimeRunEvidenceUseCase(access, config, () => new Date());
        const out = await useCase.execute({ user: user(Role.CONTRIBUTOR), runId: r.runId, stepId: STEP });
        expect(out.key).toBe(key);
        // Short-lived as designed: at most 5 minutes.
        expect(Date.parse(out.expiresAt) - Date.now()).toBeLessThanOrEqual(300_000);
        const res = await fetch(out.url);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('{"probe":"ok"}');
    });

    it('keeps evidence 30 days', async () => {
        const key = evidenceKey({ organizationId: 'org-old', runId: 'run-old', side: 'pr', stepId: STEP, type: 'output' });
        await store.put(key, 'old', 'text/plain');
        const p = join(dir, 'org-old/run-old/pr', STEP, 'output');
        const longAgo = new Date(Date.now() - 31 * 24 * 3_600_000);
        await fs.utimes(p, longAgo, longAgo);
        expect(await store.sweep()).toBe(1);
        expect(await store.get(key)).toBeNull();
        await expect(fs.stat(join(dir, 'org-old'))).rejects.toMatchObject({ code: 'ENOENT' });
        // Fresh evidence stays.
        expect(await store.get(evidenceKey({ organizationId: 'org-a', runId: 'run-1', side: 'pr', stepId: STEP, type: 'output' }))).not.toBeNull();
    });
});

describe('a Run writes the observer output of every replay round', () => {
    it('one output per base and PR step id, under the Run org', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const evidence = new InMemoryEvidenceStore();
        const req = shopRunRequest();
        await projection.upsert(req.runId, { attempt: 1, organizationId: req.organizationId, state: 'queued', requestedAt: req.requestedAt } as any);
        await runRuntimeRun(req, { ...deps, evidence });
        const probes = (await projection.get(req.runId))!.probes!;
        const ids = probes.flatMap((p) => [...(p.baseStepIds ?? []).map((s) => ['base', s]), ...(p.prStepIds ?? []).map((s) => ['pr', s])]);
        expect(ids.length).toBeGreaterThan(0);
        for (const [side, stepId] of ids) {
            const obj = await evidence.get(evidenceKey({ organizationId: req.organizationId, runId: req.runId, side, stepId, type: 'output' }));
            expect(JSON.parse(obj!.body.toString())).toMatchObject({ side, stepId });
        }
        // Plus one per command the agent explored with, under the base side.
        const explored = (await projection.get(req.runId))!.exploration!;
        for (const c of explored) {
            expect(await evidence.get(evidenceKey({ organizationId: req.organizationId, runId: req.runId, side: 'base', stepId: c.stepId, type: 'output' }))).not.toBeNull();
        }
        expect(evidence.objects.size).toBe(ids.length + explored.length);
    });
});

describe('evidence uploads with a grant (EVIDENCE-CAPTURE-DESIGN)', () => {
    let dir: string;
    let store: FileEvidenceStore;
    let server: Awaited<ReturnType<typeof startEvidenceServer>>;
    let base: string;
    let n = 0;
    const grant = (over: Partial<Parameters<typeof signUploadGrant>[0]> = {}) =>
        signUploadGrant({
            baseUrl: base,
            organizationId: 'org-a',
            runId: `run-up-${++n}`,
            side: 'pr',
            stepId: STEP,
            type: 'logs',
            secret: SECRET,
            ttlSeconds: 300,
            nonce: `nonce-${String(n).padStart(16, '0')}`,
            ...over,
        });
    const put = (url: string, body: string | Buffer, contentType = 'text/plain') => fetch(url, { method: 'PUT', body, headers: { 'content-type': contentType } });

    beforeAll(async () => {
        dir = await fs.mkdtemp(join(tmpdir(), 'kr-evidence-up-'));
        store = new FileEvidenceStore(dir);
        server = await startEvidenceServer({ store, secret: SECRET, port: 0, host: '127.0.0.1', uploads: true });
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
        await new Promise((r) => server.close(r));
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('stores the artifact at the grant\'s exact key, once', async () => {
        const g = grant();
        expect(g.contentType).toBe('text/plain');
        expect(g.maxBytes).toBe(256 * 1_024);
        expect((await put(g.url, 'line 1\nline 2\n')).status).toBe(201);
        const key = new URL(g.url).pathname.slice(1);
        expect(await store.get(key)).toEqual({ body: Buffer.from('line 1\nline 2\n'), contentType: 'text/plain' });
        // Single use: the same grant again is refused, and the object is not replaced.
        expect((await put(g.url, 'other')).status).toBe(409);
        expect((await store.get(key))!.body.toString()).toBe('line 1\nline 2\n');
    });

    it('refuses another content type, a type outside the allowed set, more bytes than the grant, and a tampered grant', async () => {
        expect((await put(grant().url, '{}', 'application/json')).status).toBe(403);
        expect((await put(grant().url, '<b>x</b>', 'text/html')).status).toBe(415);
        expect((await put(grant().url, 'x', 'text/plain; charset=utf-8')).status).toBe(415);
        const db = grant({ type: 'db' });
        expect(db.maxBytes).toBe(64 * 1_024);
        expect((await put(db.url, JSON.stringify({ rows: 'x'.repeat(64 * 1_024) }), 'application/json')).status).toBe(413);
        const g = new URL(grant().url);
        g.searchParams.set('max', String(20 * 1_024 * 1_024));
        expect((await put(g.toString(), 'x')).status).toBe(403);
        const other = new URL(grant().url.replace('/org-a/', '/org-b/'));
        expect((await put(other.toString(), 'x')).status).toBe(403);
        const expired = grant({ ttlSeconds: 1, now: new Date(Date.now() - 10_000) });
        expect((await put(expired.url, 'x')).status).toBe(403);
    });

    it('a read URL cannot write and a grant cannot read', async () => {
        const g = grant();
        const key = new URL(g.url).pathname.slice(1);
        const read = signEvidenceUrl({ baseUrl: base, key, secret: SECRET, ttlSeconds: 300 });
        expect((await put(read.url, 'x')).status).toBe(403);
        expect((await put(g.url, 'ok')).status).toBe(201);
        expect((await fetch(g.url)).status).toBe(403);
        expect(await (await fetch(read.url)).text()).toBe('ok');
    });

    it('an evidence server without uploads refuses every PUT', async () => {
        const off = await startEvidenceServer({ store, secret: SECRET, port: 0, host: '127.0.0.1' });
        try {
            const url = grant().url.replace(base, `http://127.0.0.1:${(off.address() as AddressInfo).port}`);
            expect((await put(url, 'x')).status).toBe(405);
        } finally {
            await new Promise((r) => off.close(r));
        }
    });
});
