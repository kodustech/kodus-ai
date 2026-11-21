import { createHash, createHmac } from 'crypto';

// AWS Signature Version 4 (the S3 dialect), with node crypto only: presigned
// URLs (query-string signing) for the cell's PUT and the browser's GET, and
// the Authorization header for the worker's own calls. No SDK: the Runtime
// talks to any S3-compatible store (AWS, MinIO, R2) with these two functions.
// Checked against the examples AWS publishes (sigv4.spec.ts).

export interface AwsCredentials {
    accessKeyId: string;
    secretAccessKey: string;
    /** Temporary credentials only (STS); signed into the request. */
    sessionToken?: string;
}

export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
/** A presigned URL lives at most 7 days (SigV4). */
export const SIGV4_MAX_EXPIRES_SECONDS = 604_800;

export const sha256Hex = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data, 'utf8').digest();

const UNRESERVED = /^[A-Za-z0-9\-_.~]$/;

/** URI-encodes as SigV4 asks: every UTF-8 byte but A-Z a-z 0-9 - _ . ~ as %XX (uppercase); `/` kept in a path. */
export function uriEncode(value: string, keepSlash = false): string {
    let out = '';
    for (const byte of Buffer.from(value, 'utf8')) {
        const ch = String.fromCharCode(byte);
        out += UNRESERVED.test(ch) || (keepSlash && ch === '/') ? ch : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
    }
    return out;
}

/** YYYYMMDDTHHMMSSZ. */
export const amzDate = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

export interface SigV4Request {
    method: string;
    /** scheme://host[:port] of the request, exactly as the client will send Host. */
    origin: string;
    /** The raw path (an S3 object key is not pre-encoded): each segment is encoded once, as S3 wants. */
    path: string;
    query?: Record<string, string> | Array<[string, string]>;
    /** Headers to sign besides host (and the x-amz-* the signer adds); names in any case. */
    headers?: Record<string, string>;
    region: string;
    service?: string;
    credentials: AwsCredentials;
    now: Date;
}

const pairs = (q: SigV4Request['query']): Array<[string, string]> => (Array.isArray(q) ? q : Object.entries(q ?? {}));

export function canonicalQuery(q: Array<[string, string]>): string {
    return q
        .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
        .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
        .map(([k, v]) => `${k}=${v}`)
        .join('&');
}

function canonicalHeaders(headers: Record<string, string>): { canonical: string; signed: string } {
    const norm = new Map<string, string>();
    for (const [k, v] of Object.entries(headers)) norm.set(k.toLowerCase().trim(), String(v).trim().replace(/\s+/g, ' '));
    const names = [...norm.keys()].sort();
    return { canonical: names.map((n) => `${n}:${norm.get(n)}\n`).join(''), signed: names.join(';') };
}

export const canonicalPath = (path: string) => uriEncode(path.startsWith('/') ? path : `/${path}`, true);

export function canonicalRequest(input: { method: string; path: string; query: Array<[string, string]>; headers: Record<string, string>; payloadHash: string }): {
    request: string;
    signedHeaders: string;
} {
    const h = canonicalHeaders(input.headers);
    return {
        request: [input.method.toUpperCase(), canonicalPath(input.path), canonicalQuery(input.query), h.canonical, h.signed, input.payloadHash].join('\n'),
        signedHeaders: h.signed,
    };
}

export function signingKey(secretAccessKey: string, date8: string, region: string, service: string): Buffer {
    return hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, date8), region), service), 'aws4_request');
}

function signature(r: SigV4Request, request: string): { scope: string; stringToSign: string; signature: string } {
    const service = r.service ?? 's3';
    const stamp = amzDate(r.now);
    const date8 = stamp.slice(0, 8);
    const scope = `${date8}/${r.region}/${service}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256Hex(request)].join('\n');
    return { scope, stringToSign, signature: createHmac('sha256', signingKey(r.credentials.secretAccessKey, date8, r.region, service)).update(stringToSign, 'utf8').digest('hex') };
}

const hostOf = (origin: string) => new URL(origin).host;

/**
 * A presigned URL (query-string auth): whoever holds it may make exactly this
 * request, with exactly the signed headers, until it expires. The payload is
 * unsigned (S3 presign), so the body is bounded by what the signed headers say.
 */
export function presignUrl(r: SigV4Request & { expiresSeconds: number }): string {
    const expires = Math.floor(r.expiresSeconds);
    if (!(expires >= 1 && expires <= SIGV4_MAX_EXPIRES_SECONDS)) throw new Error('presigned URL expiry must be 1 s to 7 days');
    const service = r.service ?? 's3';
    const stamp = amzDate(r.now);
    const headers = { ...(r.headers ?? {}), host: hostOf(r.origin) };
    const signedHeaders = canonicalHeaders(headers).signed;
    const query: Array<[string, string]> = [
        ...pairs(r.query),
        ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
        ['X-Amz-Credential', `${r.credentials.accessKeyId}/${stamp.slice(0, 8)}/${r.region}/${service}/aws4_request`],
        ['X-Amz-Date', stamp],
        ['X-Amz-Expires', String(expires)],
        ['X-Amz-SignedHeaders', signedHeaders],
        ...(r.credentials.sessionToken ? ([['X-Amz-Security-Token', r.credentials.sessionToken]] as Array<[string, string]>) : []),
    ];
    const { request } = canonicalRequest({ method: r.method, path: r.path, query, headers, payloadHash: UNSIGNED_PAYLOAD });
    const sig = signature(r, request).signature;
    return `${r.origin.replace(/\/+$/, '')}${canonicalPath(r.path)}?${canonicalQuery(query)}&X-Amz-Signature=${sig}`;
}

/**
 * The headers of a header-signed request (Authorization), for the worker's
 * own calls. `payloadHash` is the body's SHA-256 hex (EMPTY_SHA256 for none);
 * S3 requires it as x-amz-content-sha256, which is added and signed.
 * Returns the URL to call and every header to send (host is left to the client).
 */
export function signRequest(r: SigV4Request & { payloadHash: string }): { url: string; headers: Record<string, string> } {
    const service = r.service ?? 's3';
    const stamp = amzDate(r.now);
    const extra: Record<string, string> = { 'x-amz-date': stamp };
    if (service === 's3') extra['x-amz-content-sha256'] = r.payloadHash;
    if (r.credentials.sessionToken) extra['x-amz-security-token'] = r.credentials.sessionToken;
    const sent = { ...(r.headers ?? {}), ...extra };
    const query = pairs(r.query);
    const { request, signedHeaders } = canonicalRequest({ method: r.method, path: r.path, query, headers: { ...sent, host: hostOf(r.origin) }, payloadHash: r.payloadHash });
    const s = signature(r, request);
    const qs = canonicalQuery(query);
    return {
        url: `${r.origin.replace(/\/+$/, '')}${canonicalPath(r.path)}${qs ? `?${qs}` : ''}`,
        headers: { ...sent, authorization: `AWS4-HMAC-SHA256 Credential=${r.credentials.accessKeyId}/${s.scope}, SignedHeaders=${signedHeaders}, Signature=${s.signature}` },
    };
}

/** For tests and debugging: the intermediate values of one signature (never logged in production: no secret in them, but the URL is a capability). */
export function sigV4Debug(r: SigV4Request & { payloadHash: string }) {
    const { request } = canonicalRequest({ method: r.method, path: r.path, query: pairs(r.query), headers: { ...(r.headers ?? {}), host: hostOf(r.origin) }, payloadHash: r.payloadHash });
    return { canonicalRequest: request, ...signature(r, request) };
}
