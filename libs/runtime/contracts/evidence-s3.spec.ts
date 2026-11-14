import { inspect } from 'util';

import { BaselineScreenshotSchema, UploadGrantSchema } from '@libs/runtime/protocol/messages';

import { evidenceKey } from './evidence';
import { evidenceObjectKey, evidenceStagingKey, loadS3EvidenceConfig, presignEvidenceRead, presignEvidenceUpload, s3ObjectLocation } from './evidence-s3';

const STEP = '0b9c8d7e-6f50-4a1b-9c2d-3e4f5a6b7c8d';
const NOW = new Date('2026-11-07T12:00:00Z');
const SECRET = 'not-a-real-secret-key-0000000000000000000';

const env = (over: Record<string, string> = {}) => ({
    RUNTIME_EVIDENCE_S3_BUCKET: 'kodus-evidence',
    RUNTIME_EVIDENCE_S3_REGION: 'us-east-1',
    RUNTIME_EVIDENCE_S3_ACCESS_KEY_ID: 'AKIDEVIDENCE',
    RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY: SECRET,
    ...over,
});

const minio = () =>
    loadS3EvidenceConfig(
        env({ RUNTIME_EVIDENCE_S3_ENDPOINT: 'http://minio:9000', RUNTIME_EVIDENCE_S3_PUBLIC_ENDPOINT: 'http://localhost:9000', RUNTIME_EVIDENCE_S3_FORCE_PATH_STYLE: '1', RUNTIME_EVIDENCE_S3_PREFIX: 'rt' }),
    );

describe('loadS3EvidenceConfig', () => {
    it('defaults to AWS virtual-hosted URLs in the region, with no prefix', () => {
        const c = loadS3EvidenceConfig(env({ RUNTIME_EVIDENCE_S3_REGION: 'sa-east-1' }));
        expect(c).toMatchObject({ bucket: 'kodus-evidence', region: 'sa-east-1', endpoint: 'https://s3.sa-east-1.amazonaws.com', publicEndpoint: 'https://s3.sa-east-1.amazonaws.com', forcePathStyle: false, prefix: '' });
        expect(s3ObjectLocation(c, 'a/b')).toEqual({ origin: 'https://kodus-evidence.s3.sa-east-1.amazonaws.com', path: '/a/b' });
    });

    it('takes a MinIO endpoint, path style, a public endpoint and a prefix', () => {
        const c = minio();
        expect(c.prefix).toBe('rt/');
        expect(s3ObjectLocation(c, 'rt/a')).toEqual({ origin: 'http://minio:9000', path: '/kodus-evidence/rt/a' });
        expect(s3ObjectLocation(c, 'rt/a', { public: true })).toEqual({ origin: 'http://localhost:9000', path: '/kodus-evidence/rt/a' });
    });

    it('never shows the secret: not in JSON, a spread or inspect', () => {
        const c = loadS3EvidenceConfig(env({ RUNTIME_EVIDENCE_S3_SESSION_TOKEN: 'session-token-value' }));
        expect(c.credentials.secretAccessKey).toBe(SECRET);
        expect(c.credentials.sessionToken).toBe('session-token-value');
        for (const shown of [JSON.stringify(c), JSON.stringify({ ...c.credentials }), inspect(c, { depth: 5 })]) {
            expect(shown).not.toContain(SECRET);
            expect(shown).not.toContain('session-token-value');
        }
    });

    it('refuses a missing bucket or credential, a bad prefix and an endpoint with credentials', () => {
        expect(() => loadS3EvidenceConfig(env({ RUNTIME_EVIDENCE_S3_BUCKET: '' }))).toThrow('BUCKET');
        expect(() => loadS3EvidenceConfig(env({ RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY: '' }))).toThrow('SECRET_ACCESS_KEY');
        expect(() => loadS3EvidenceConfig(env({ RUNTIME_EVIDENCE_S3_PREFIX: '../x' }))).toThrow('PREFIX');
        expect(() => loadS3EvidenceConfig(env({ RUNTIME_EVIDENCE_S3_PREFIX: 'a b' }))).toThrow('PREFIX');
        expect(() => loadS3EvidenceConfig(env({ RUNTIME_EVIDENCE_S3_ENDPOINT: 'https://u:p@s3.example.com' }))).toThrow('ENDPOINT');
    });
});

describe('presigned evidence URLs', () => {
    const at = { organizationId: 'org-1', runId: 'run-1', side: 'pr' as const, stepId: STEP };

    it('a grant is a presigned PUT of the staging key, its content type signed, that the cell protocol accepts', () => {
        for (const cfg of [minio(), loadS3EvidenceConfig(env())]) {
            const g = presignEvidenceUpload(cfg, { ...at, type: 'screenshot-0', ttlSeconds: 600, now: NOW });
            expect(g).toMatchObject({ type: 'screenshot-0', contentType: 'image/png', maxBytes: 2 * 1024 * 1024, expiresAt: '2026-11-07T12:10:00.000Z' });
            const u = new URL(g.url);
            expect(u.pathname.endsWith(`/${evidenceStagingKey(cfg, evidenceKey({ ...at, type: 'screenshot-0' }))}`)).toBe(true);
            expect(u.pathname).toContain('/.uploads/org-1/run-1/pr/');
            expect(u.searchParams.get('X-Amz-SignedHeaders')).toBe('content-type;host');
            expect(u.searchParams.get('X-Amz-Expires')).toBe('600');
            expect(UploadGrantSchema.safeParse(g).success).toBe(true);
        }
    });

    it('a grant lives at most 15 minutes', () => {
        const g = presignEvidenceUpload(minio(), { ...at, type: 'video', ttlSeconds: 99_999, now: NOW });
        expect(new URL(g.url).searchParams.get('X-Amz-Expires')).toBe('900');
    });

    it('a read is a presigned GET of the evidence key: attachment, its type, no cache, at most 5 minutes', () => {
        const cfg = minio();
        const key = evidenceKey({ ...at, type: 'screenshot-0' });
        const r = presignEvidenceRead(cfg, { key, ttlSeconds: 3_600, now: NOW });
        const u = new URL(r.url);
        expect(u.origin).toBe('http://localhost:9000');
        expect(u.pathname).toBe(`/kodus-evidence/${evidenceObjectKey(cfg, key)}`);
        expect(u.searchParams.get('X-Amz-Expires')).toBe('300');
        expect(u.searchParams.get('response-content-type')).toBe('image/png');
        expect(u.searchParams.get('response-content-disposition')).toBe(`attachment; filename="pr-${STEP}-screenshot-0.png"`);
        expect(u.searchParams.get('response-cache-control')).toBe('private, no-store');
        expect(r.expiresAt).toBe('2026-11-07T12:05:00.000Z');
        // The cell reads a baseline screenshot with the same URL shape.
        expect(BaselineScreenshotSchema.safeParse({ step: 0, screenshot: 0, url: r.url }).success).toBe(true);
    });

    it('a type the worker does not know is served as bytes', () => {
        const r = presignEvidenceRead(minio(), { key: evidenceKey({ ...at, type: 'proxy_log' }), ttlSeconds: 60, now: NOW });
        expect(new URL(r.url).searchParams.get('response-content-type')).toBe('application/octet-stream');
    });
});
