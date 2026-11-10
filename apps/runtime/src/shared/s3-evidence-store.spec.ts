import { createHash } from 'crypto';

import { evidenceKey } from '@libs/runtime/contracts/evidence';
import { loadS3EvidenceConfig } from '@libs/runtime/contracts/evidence-s3';
import { presignUrl } from '@libs/runtime/contracts/sigv4';
import type { EvidenceRef } from '@libs/runtime/probe';

import { HmacCanaryVault } from '../worker/canary/canary';
import { checkUploadedRefs, evidenceRequestOf, type RunEvidence } from '../worker/run/run-evidence';
import { S3EvidenceStore } from './s3-evidence-store';
import { S3ObjectClient } from './s3-object-client';

// S3EvidenceStore against an in-memory S3 behind fetch: the worker's calls
// carry a SigV4 Authorization header; a cell's PUT carries a presigned URL
// whose signature (and signed content type) the fake checks by re-signing.

const STEP = '0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d';
const cfg = loadS3EvidenceConfig({
    RUNTIME_EVIDENCE_S3_BUCKET: 'evidence',
    RUNTIME_EVIDENCE_S3_ENDPOINT: 'http://minio:9000',
    RUNTIME_EVIDENCE_S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
    RUNTIME_EVIDENCE_S3_FORCE_PATH_STYLE: 'true',
    RUNTIME_EVIDENCE_S3_ACCESS_KEY_ID: 'AKIDTEST',
    RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY: 'test-secret-key-0000000000000000',
});

class FakeS3 {
    readonly objects = new Map<string, { body: Buffer; contentType: string; etag: string; meta?: Record<string, string> }>();
    readonly calls: string[] = [];

    private keyOf(url: URL) {
        const [, bucket, ...rest] = decodeURIComponent(url.pathname).split('/');
        expect(bucket).toBe('evidence');
        return rest.join('/');
    }

    set(key: string, body: Buffer | string, contentType: string) {
        const b = Buffer.from(body);
        this.objects.set(key, { body: b, contentType, etag: `"${createHash('md5').update(b).digest('hex')}"` });
    }

    /** A cell's PUT with a grant: the URL's signature must re-sign to the same, content type included. */
    cellPut(grantUrl: string, contentType: string, body: Buffer | string): number {
        const u = new URL(grantUrl);
        const q = u.searchParams;
        const d = q.get('X-Amz-Date')!;
        const now = new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${d.slice(9, 11)}:${d.slice(11, 13)}:${d.slice(13, 15)}Z`);
        const resigned = new URL(
            presignUrl({
                method: 'PUT',
                origin: u.origin,
                path: decodeURIComponent(u.pathname),
                headers: { 'content-type': contentType },
                region: cfg.region,
                credentials: cfg.credentials,
                now,
                expiresSeconds: Number(q.get('X-Amz-Expires')),
            }),
        ).searchParams.get('X-Amz-Signature');
        if (resigned !== q.get('X-Amz-Signature')) return 403;
        this.set(this.keyOf(u), body, contentType);
        return 200;
    }

    fetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = init?.method ?? 'GET';
        const h = new Headers(init?.headers);
        expect(h.get('authorization')).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//);
        expect(url.origin).toBe('http://minio:9000');
        const key = this.keyOf(url);
        this.calls.push(`${method} ${key}`);
        const obj = this.objects.get(key);
        const headersOf = (o: { body: Buffer; contentType: string; etag: string; meta?: Record<string, string> }) => ({
            'content-length': String(o.body.length),
            'content-type': o.contentType,
            etag: o.etag,
            ...o.meta,
        });
        switch (method) {
            case 'HEAD':
                return obj ? new Response(null, { status: 200, headers: headersOf(obj) }) : new Response(null, { status: 404 });
            case 'GET':
                if (!obj) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
                if (h.get('if-match') && h.get('if-match') !== obj.etag) return new Response(null, { status: 412 });
                return new Response(new Uint8Array(obj.body), { status: 200, headers: headersOf(obj) });
            case 'DELETE':
                this.objects.delete(key);
                return new Response(null, { status: 204 });
            case 'PUT': {
                const source = h.get('x-amz-copy-source');
                if (source) {
                    const src = this.objects.get(decodeURIComponent(source).replace(/^\/evidence\//, ''));
                    if (!src) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
                    const ifMatch = h.get('x-amz-copy-source-if-match');
                    if (ifMatch && ifMatch !== src.etag) return new Response('<Error><Code>PreconditionFailed</Code></Error>', { status: 412 });
                    this.set(key, src.body, h.get('content-type') ?? src.contentType);
                    return new Response('<CopyObjectResult/>', { status: 200 });
                }
                const body = Buffer.from(init?.body as Uint8Array);
                expect(h.get('x-amz-content-sha256')).toBe(createHash('sha256').update(body).digest('hex'));
                this.set(key, body, h.get('content-type') ?? 'application/octet-stream');
                this.objects.get(key)!.meta = Object.fromEntries([...h.entries()].filter(([k]) => k.startsWith('x-amz-meta-')));
                return new Response(null, { status: 200 });
            }
        }
        return new Response(null, { status: 405 });
    };
}

const at = { runId: 'run-1', side: 'pr' as const, stepId: STEP };
const keyOf = (type: string) => evidenceKey({ organizationId: 'org-1', ...at, type });
const ref = (type: EvidenceRef['type'], bytes = 1): EvidenceRef => ({ type, bytes, sha256: '0'.repeat(64), truncated: false, redactions: 0 });

function setup() {
    const s3 = new FakeS3();
    const store = new S3EvidenceStore(cfg, new S3ObjectClient(cfg, { fetch: s3.fetch }));
    const errors: unknown[] = [];
    const ev: RunEvidence = { organizationId: 'org-1', store, uploads: { presigner: store }, onError: (e) => errors.push(e) };
    return { s3, store, ev, errors };
}

describe('S3EvidenceStore', () => {
    it('the worker writes and reads the evidence key under the prefix', async () => {
        const { s3, store } = setup();
        await store.put(keyOf('output'), '{"a":1}', 'application/json');
        expect(s3.objects.get(keyOf('output'))?.contentType).toBe('application/json');
        expect((await store.get(keyOf('output')))?.body.toString()).toBe('{"a":1}');
        expect(await store.get(keyOf('logs'))).toBeNull();
    });

    it('a step asks the cell to PUT to the staging key by presigned URL; the take commits it to the evidence key', async () => {
        const { s3, ev, errors } = setup();
        const req = evidenceRequestOf(ev, at, ['browser'], 30_000);
        const shot = req.uploads!.find((g) => g.type === 'screenshot-0')!;
        expect(shot.url).toMatch(/^http:\/\/localhost:9000\/evidence\/\.uploads\/org-1\/run-1\/pr\//);
        // A cell that sends another content type than the grant's is refused by the store.
        expect(s3.cellPut(shot.url, 'text/html', '<script>')).toBe(403);
        expect(s3.cellPut(shot.url, 'image/png', 'png-bytes')).toBe(200);
        const out = await checkUploadedRefs(ev, at, [ref('screenshot-0')]);
        expect(errors).toEqual([]);
        expect(out.refs.map((r) => r.type)).toEqual(['screenshot-0']);
        expect(s3.objects.get(keyOf('screenshot-0'))).toMatchObject({ contentType: 'image/png' });
        expect(s3.objects.get(keyOf('screenshot-0'))!.body.toString()).toBe('png-bytes');
        expect(s3.objects.has(`.uploads/${keyOf('screenshot-0')}`)).toBe(false);
        // Binary uploads are copied server side, never downloaded.
        expect(s3.calls.filter((c) => c.startsWith('GET'))).toEqual([]);
    });

    it('an upload past its ceiling is deleted unread and its ref dropped', async () => {
        const { s3, ev } = setup();
        s3.set(`.uploads/${keyOf('db')}`, Buffer.alloc(64 * 1024 + 1), 'application/json');
        const out = await checkUploadedRefs(ev, at, [ref('db')]);
        expect(out.refs).toEqual([]);
        expect(s3.objects.size).toBe(0);
        expect(s3.calls.filter((c) => c.startsWith('GET'))).toEqual([]);
    });

    it('a ref with no upload, or with the wrong content type, is dropped', async () => {
        const { s3, ev } = setup();
        s3.set(`.uploads/${keyOf('logs')}`, 'x', 'application/json');
        const out = await checkUploadedRefs(ev, at, [ref('logs'), ref('cast')]);
        expect(out.refs).toEqual([]);
        expect(s3.objects.has(keyOf('logs'))).toBe(false);
    });

    it('a text upload with a canary is stored redacted and halts the Run; a retried take keeps it so', async () => {
        const { s3, ev } = setup();
        const canaries = new HmacCanaryVault('k').forRun({ runId: 'run-1', runToken: 't' });
        s3.set(`.uploads/${keyOf('logs')}`, `token ${canaries[0].value} here`, 'text/plain');
        const out = await checkUploadedRefs(ev, at, [ref('logs')], canaries);
        expect(out.leaked).toBe(true);
        expect(out.refs).toHaveLength(1);
        const stored = s3.objects.get(keyOf('logs'))!.body.toString();
        expect(stored).not.toContain(canaries[0].value);
        expect(stored).toContain('[redacted]');
        // The step ran again (a DBOS retry after the commit): the evidence key holds the redacted upload, and the leak still halts.
        const again = await checkUploadedRefs(ev, at, [ref('logs')], canaries);
        expect(again).toMatchObject({ leaked: true, refs: [expect.objectContaining({ type: 'logs' })] });
    });

    it('a cell PUT after the take never reaches the evidence key', async () => {
        const { s3, ev } = setup();
        const grant = evidenceRequestOf(ev, at, ['logs'], 30_000).uploads![0];
        s3.cellPut(grant.url, 'text/plain', 'clean');
        await checkUploadedRefs(ev, at, [ref('logs')], []);
        s3.cellPut(grant.url, 'text/plain', 'replaced later');
        expect(s3.objects.get(keyOf('logs'))!.body.toString()).toBe('clean');
    });

    it('the baseline screenshots of a browser round are presigned GETs of the evidence key', () => {
        const { ev } = setup();
        const req = evidenceRequestOf(ev, at, ['browser'], 30_000, { stepId: STEP, shots: [{ step: 1, screenshot: 0 }] });
        const u = new URL(req.baseline![0].url);
        expect(u.pathname).toBe(`/evidence/${evidenceKey({ organizationId: 'org-1', runId: 'run-1', side: 'base', stepId: STEP, type: 'screenshot-0' })}`);
        expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
    });
});
