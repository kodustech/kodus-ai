import {
    EVIDENCE_MAX_TTL_SECONDS,
    EVIDENCE_UPLOAD_MAX_TTL_SECONDS,
    evidenceKey,
    evidenceUploadLimit,
    isEvidenceUploadType,
    type EvidenceSide,
    type EvidenceUploadType,
    type SignedEvidenceUrl,
    type UploadGrant,
} from './evidence';
import { type AwsCredentials, presignUrl } from './sigv4';

// Evidence in an S3-compatible bucket (RUNTIME_EVIDENCE_STORE=s3), shared by
// the runtime-worker (writes, upload grants, its own reads) and the API (read
// URLs). The object key is the evidence key {orgId}/{runId}/{side}/{stepId}/{type}
// under an optional prefix. A cell never writes that key: its presigned PUT
// goes to a staging key ({prefix}.uploads/{key}), and the worker takes the
// upload into the evidence key once it checked its size, type and canaries
// (S3EvidenceStore.takeUpload). The API signs reads of the evidence key only.

/** Staging prefix of cell uploads; `.` is not in an org id, so it never collides with an evidence key. */
export const EVIDENCE_S3_STAGING = '.uploads/';

export interface S3EvidenceConfig {
    bucket: string;
    region: string;
    /** Where this process calls the store (RUNTIME_EVIDENCE_S3_ENDPOINT; AWS when unset). */
    endpoint: string;
    /** Where cells and browsers reach it (RUNTIME_EVIDENCE_S3_PUBLIC_ENDPOINT; the endpoint when unset). Presigned URLs name this host. */
    publicEndpoint: string;
    /** bucket in the path (MinIO, most self-hosted stores) instead of the host name. */
    forcePathStyle: boolean;
    /** '' or a path ending in '/'. */
    prefix: string;
    /** Never enumerable past the access key id: a logged or serialized config carries no secret. */
    credentials: AwsCredentials;
}

type Env = Record<string, string | undefined>;

const BUCKET = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const REGION = /^[a-z0-9-]{2,32}$/;
const PREFIX = /^(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*$/;

/** Credentials whose secret and token are not enumerable: JSON, spread and inspect never show them. */
export function hiddenCredentials(c: AwsCredentials): AwsCredentials {
    const out = { accessKeyId: c.accessKeyId } as AwsCredentials;
    Object.defineProperty(out, 'secretAccessKey', { value: c.secretAccessKey, enumerable: false });
    if (c.sessionToken) Object.defineProperty(out, 'sessionToken', { value: c.sessionToken, enumerable: false });
    return out;
}

function endpointOf(name: string, raw: string): string {
    let u: URL;
    try {
        u = new URL(raw);
    } catch {
        throw new Error(`${name} must be a URL`);
    }
    if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password || u.search || u.hash) {
        throw new Error(`${name} must be an http(s) URL without credentials, query or fragment`);
    }
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
}

/** RUNTIME_EVIDENCE_S3_*: validated at boot; a missing bucket or credential stops the process. */
export function loadS3EvidenceConfig(env: Env): S3EvidenceConfig {
    const bucket = env.RUNTIME_EVIDENCE_S3_BUCKET?.trim() ?? '';
    if (!BUCKET.test(bucket)) throw new Error('RUNTIME_EVIDENCE_S3_BUCKET must be a bucket name (3 to 63 of a-z, 0-9, . and -)');
    const region = env.RUNTIME_EVIDENCE_S3_REGION?.trim() || 'us-east-1';
    if (!REGION.test(region)) throw new Error('RUNTIME_EVIDENCE_S3_REGION is not a region name');
    const accessKeyId = env.RUNTIME_EVIDENCE_S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = env.RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY?.trim();
    if (!accessKeyId || !secretAccessKey) throw new Error('RUNTIME_EVIDENCE_S3_ACCESS_KEY_ID and RUNTIME_EVIDENCE_S3_SECRET_ACCESS_KEY are required');
    const endpoint = endpointOf('RUNTIME_EVIDENCE_S3_ENDPOINT', env.RUNTIME_EVIDENCE_S3_ENDPOINT?.trim() || `https://s3.${region}.amazonaws.com`);
    const publicEndpoint = env.RUNTIME_EVIDENCE_S3_PUBLIC_ENDPOINT?.trim() ? endpointOf('RUNTIME_EVIDENCE_S3_PUBLIC_ENDPOINT', env.RUNTIME_EVIDENCE_S3_PUBLIC_ENDPOINT.trim()) : endpoint;
    let prefix = env.RUNTIME_EVIDENCE_S3_PREFIX?.trim() ?? '';
    if (prefix && !prefix.endsWith('/')) prefix += '/';
    if (!PREFIX.test(prefix) || prefix.split('/').some((s) => s === '.' || s === '..')) throw new Error('RUNTIME_EVIDENCE_S3_PREFIX may hold only A-Z a-z 0-9 _ . - and / segments');
    const flag = (env.RUNTIME_EVIDENCE_S3_FORCE_PATH_STYLE ?? '').trim().toLowerCase();
    return {
        bucket,
        region,
        endpoint,
        publicEndpoint,
        forcePathStyle: flag === '1' || flag === 'true',
        prefix,
        credentials: hiddenCredentials({ accessKeyId, secretAccessKey, sessionToken: env.RUNTIME_EVIDENCE_S3_SESSION_TOKEN?.trim() || undefined }),
    };
}

/** The object of an evidence key. */
export const evidenceObjectKey = (cfg: Pick<S3EvidenceConfig, 'prefix'>, key: string) => `${cfg.prefix}${key}`;
/** Where a cell's presigned PUT of that key lands, before the worker takes it. */
export const evidenceStagingKey = (cfg: Pick<S3EvidenceConfig, 'prefix'>, key: string) => `${cfg.prefix}${EVIDENCE_S3_STAGING}${key}`;

/** origin and raw path of one object, on the server endpoint or the one cells and browsers reach. */
export function s3ObjectLocation(cfg: S3EvidenceConfig, objectKey: string, opts: { public?: boolean } = {}): { origin: string; path: string } {
    const u = new URL(opts.public ? cfg.publicEndpoint : cfg.endpoint);
    const base = u.pathname.replace(/\/+$/, '');
    if (cfg.forcePathStyle) return { origin: u.origin, path: `${base}/${cfg.bucket}/${objectKey}` };
    return { origin: `${u.protocol}//${cfg.bucket}.${u.host}`, path: `${base}/${objectKey}` };
}

const EXT: Record<string, string> = { 'application/json': 'json', 'text/plain': 'txt', 'image/png': 'png', 'video/webm': 'webm', 'application/zip': 'zip' };

/** The content type an evidence type is served as; anything the worker does not type is bytes. */
export function evidenceServedType(type: string): string {
    if (type === 'output') return 'application/json';
    if (isEvidenceUploadType(type)) return evidenceUploadLimit(type).contentType;
    return 'application/octet-stream';
}

/**
 * A read URL of one evidence key (at most 5 minutes, §7): a presigned GET
 * whose response is always an attachment of the type's content type, never
 * cached. The signature covers those overrides, so the URL cannot ask for
 * another type or an inline disposition.
 */
export function presignEvidenceRead(cfg: S3EvidenceConfig, input: { key: string; ttlSeconds: number; now?: Date }): SignedEvidenceUrl {
    const [, , side, stepId, type] = input.key.split('/');
    const ttl = Math.min(Math.max(1, Math.floor(input.ttlSeconds)), EVIDENCE_MAX_TTL_SECONDS);
    const now = input.now ?? new Date();
    const served = evidenceServedType(type ?? '');
    const loc = s3ObjectLocation(cfg, evidenceObjectKey(cfg, input.key), { public: true });
    const url = presignUrl({
        method: 'GET',
        ...loc,
        query: {
            'response-cache-control': 'private, no-store',
            'response-content-disposition': `attachment; filename="${side}-${stepId}-${type}.${EXT[served] ?? 'bin'}"`,
            'response-content-type': served,
        },
        region: cfg.region,
        credentials: cfg.credentials,
        now,
        expiresSeconds: ttl,
    });
    return { url, expiresAt: new Date(Math.floor(now.getTime() / 1000) * 1000 + ttl * 1000).toISOString() };
}

/**
 * One upload grant as a presigned PUT to the staging key (EVIDENCE-CAPTURE-DESIGN
 * "Transport and storage"): the content type is a signed header, so a PUT with
 * any other is refused by the store. The size is not in the signature (a
 * presigned PUT cannot bound a range); the worker refuses an object past the
 * type's ceiling when it takes the upload, before reading it.
 */
export function presignEvidenceUpload(
    cfg: S3EvidenceConfig,
    input: { organizationId: string; runId: string; side: EvidenceSide; stepId: string; type: EvidenceUploadType; ttlSeconds: number; now?: Date },
): UploadGrant {
    const key = evidenceKey({ organizationId: input.organizationId, runId: input.runId, side: input.side, stepId: input.stepId, type: input.type });
    const { contentType, maxBytes } = evidenceUploadLimit(input.type);
    const ttl = Math.min(Math.max(1, Math.floor(input.ttlSeconds)), EVIDENCE_UPLOAD_MAX_TTL_SECONDS);
    const now = input.now ?? new Date();
    const url = presignUrl({
        method: 'PUT',
        ...s3ObjectLocation(cfg, evidenceStagingKey(cfg, key), { public: true }),
        headers: { 'content-type': contentType },
        region: cfg.region,
        credentials: cfg.credentials,
        now,
        expiresSeconds: ttl,
    });
    return { type: input.type, url, contentType, maxBytes, expiresAt: new Date(Math.floor(now.getTime() / 1000) * 1000 + ttl * 1000).toISOString() };
}
