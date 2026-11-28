import { randomUUID } from 'crypto';

import { evidenceKey } from '@libs/runtime/contracts/evidence';
import { loadS3EvidenceConfig, presignEvidenceRead } from '@libs/runtime/contracts/evidence-s3';
import type { EvidenceRef } from '@libs/runtime/probe';

import { checkUploadedRefs, evidenceRequestOf, type RunEvidence } from '../../worker/run/run-evidence';
import { S3EvidenceStore } from './s3-evidence-store';
import { S3ObjectClient } from './s3-object-client';

// Opt-in: runs against the S3-compatible store RUNTIME_IT_S3_ENDPOINT names
// (the MinIO of `docker compose -f docker-compose.dev.yml --profile evidence-s3 up -d runtime-minio`:
// http://localhost:9000, keys RUNTIME_IT_S3_ACCESS_KEY_ID/SECRET_ACCESS_KEY, default minioadmin),
// and skips when none is named. It does what a cell and a browser do: a
// plain PUT to the grant URL with Content-Type and Content-Length, no redirect,
// and a plain GET of the read URL.

const endpoint = process.env.RUNTIME_IT_S3_ENDPOINT ?? '';
const skip = !endpoint || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('S3 evidence store (integration, real S3-compatible store)', () => {
    const cfg = loadS3EvidenceConfig({
        RUNTIME_EVIDENCE_S3_BUCKET: process.env.RUNTIME_IT_S3_BUCKET ?? 'kody-runtime-evidence-it',
        RUNTIME_EVIDENCE_S3_REGION: process.env.RUNTIME_IT_S3_REGION ?? 'us-east-1',
        RUNTIME_EVIDENCE_S3_ENDPOINT: endpoint,
        RUNTIME_EVIDENCE_S3_FORCE_PATH_STYLE: process.env.RUNTIME_IT_S3_FORCE_PATH_STYLE ?? 'true',
        RUNTIME_EVIDENCE_S3_PREFIX: `it-${randomUUID().slice(0, 8)}`,
        RUNTIME_EVIDENCE_S3_ACCESS_KEY_ID: process.env.RUNTIME_IT_S3_ACCESS_KEY_ID ?? 'minioadmin',
        RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY: process.env.RUNTIME_IT_S3_SECRET_ACCESS_KEY ?? 'minioadmin',
    });
    const s3 = new S3ObjectClient(cfg);
    const store = new S3EvidenceStore(cfg, s3);
    const ev: RunEvidence = { organizationId: 'org-it', store, uploads: { presigner: store } };
    const at = { runId: `run-${randomUUID().slice(0, 8)}`, side: 'pr' as const, stepId: randomUUID() };
    const key = (type: string) => evidenceKey({ organizationId: 'org-it', ...at, type });
    const ref = (type: EvidenceRef['type']): EvidenceRef => ({ type, bytes: 1, sha256: '0'.repeat(64), truncated: false, redactions: 0 });
    const cellPut = (url: string, contentType: string, body: string | Buffer) =>
        fetch(url, { method: 'PUT', headers: { 'content-type': contentType, 'content-length': String(Buffer.byteLength(body)) }, body: new Uint8Array(Buffer.from(body)), redirect: 'manual' });

    beforeAll(async () => {
        await s3.createBucket();
        await s3.putEvidenceLifecycle(30);
    });

    afterAll(async () => {
        for (const type of ['output', 'screenshot-0', 'logs', 'db']) {
            await s3.delete(`${cfg.prefix}${key(type)}`).catch(() => undefined);
            await s3.delete(`${cfg.prefix}.uploads/${key(type)}`).catch(() => undefined);
        }
    });

    it('the worker writes and reads an evidence object, and a presigned GET serves it as an attachment', async () => {
        await store.put(key('output'), '{"ok":true}', 'application/json');
        expect((await store.get(key('output')))?.body.toString()).toBe('{"ok":true}');
        const res = await fetch(presignEvidenceRead(cfg, { key: key('output'), ttlSeconds: 60 }).url);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('application/json');
        expect(res.headers.get('content-disposition')).toMatch(/^attachment; filename="pr-/);
        expect(res.headers.get('cache-control')).toBe('private, no-store');
        expect(await res.text()).toBe('{"ok":true}');
    });

    it("a cell's PUT with its grant lands on staging (200), another content type is refused, the take moves it", async () => {
        const grant = evidenceRequestOf(ev, at, ['browser'], 30_000).uploads!.find((g) => g.type === 'screenshot-0')!;
        expect((await cellPut(grant.url, 'text/html', '<b>x</b>')).status).toBe(403);
        expect((await cellPut(grant.url, 'image/png', 'png-bytes')).status).toBe(200);
        expect(await store.get(key('screenshot-0'))).toBeNull();
        const out = await checkUploadedRefs(ev, at, [ref('screenshot-0')]);
        expect(out.refs).toHaveLength(1);
        expect((await store.get(key('screenshot-0')))?.contentType).toBe('image/png');
        expect(await s3.head(`${cfg.prefix}.uploads/${key('screenshot-0')}`)).toBeNull();
    });

    it('an upload past its ceiling is deleted unread', async () => {
        const grant = evidenceRequestOf(ev, at, ['db'], 30_000).uploads!.find((g) => g.type === 'db')!;
        expect((await cellPut(grant.url, 'application/json', Buffer.alloc(grant.maxBytes + 1, 0x20))).status).toBe(200);
        const out = await checkUploadedRefs(ev, at, [ref('db')]);
        expect(out.refs).toEqual([]);
        expect(await s3.head(`${cfg.prefix}.uploads/${key('db')}`)).toBeNull();
        expect(await store.get(key('db'))).toBeNull();
    });

    it('a presigned grant past its expiry is refused', async () => {
        const grant = evidenceRequestOf({ ...ev, uploads: { presigner: store, now: () => new Date(Date.now() - 3_600_000) } }, at, ['logs'], 1_000).uploads![0];
        expect((await cellPut(grant.url, 'text/plain', 'late')).status).toBe(403);
    });
});
