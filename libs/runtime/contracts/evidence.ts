import { createHmac, timingSafeEqual } from 'crypto';

// Evidence lives in the cell object store at {orgId}/{runId}/{side}/{stepId}/{type}
// (§8). The key is always built here, on the server, from the Run the caller
// was authorized for; nothing in it comes from the VM or the client except the
// step id, the side and the type, each checked against a closed set.
// The URL is read by the evidence server on an isolated origin, which only
// accepts this short HMAC token (RT-16).

export const EVIDENCE_SIDES = ['base', 'pr', 'setup'] as const;
export type EvidenceSide = (typeof EVIDENCE_SIDES)[number];

/** Screenshots and pixel diffs of one round: at most 10 (design table), numbered from 0. */
export const EVIDENCE_MAX_SCREENSHOTS = 10;

/**
 * What a browser probe round needs past the probe's own time (ADR-071): the
 * runner container's start and close (the cell's StartGrace, 40 s) and the
 * uploads of up to 60 MB of artifacts. The hub waits this much longer for
 * its result, and its upload grants live this much longer.
 */
export const BROWSER_ROUND_GRACE_MS = 120_000;

/**
 * What a cell uploads with a grant (EVIDENCE-CAPTURE-DESIGN): service logs,
 * database effects, an exec cast, and the browser runner's artifacts.
 * `output` is not one: the worker writes it from the step result itself.
 */
// prettier-ignore
export const EVIDENCE_UPLOAD_TYPES = [
    'logs', 'db', 'cast',
    'screenshot-0', 'screenshot-1', 'screenshot-2', 'screenshot-3', 'screenshot-4', 'screenshot-5', 'screenshot-6', 'screenshot-7', 'screenshot-8', 'screenshot-9',
    'video', 'trace', 'har',
    'pixeldiff-0', 'pixeldiff-1', 'pixeldiff-2', 'pixeldiff-3', 'pixeldiff-4', 'pixeldiff-5', 'pixeldiff-6', 'pixeldiff-7', 'pixeldiff-8', 'pixeldiff-9',
] as const;
export type EvidenceUploadType = (typeof EVIDENCE_UPLOAD_TYPES)[number];

export type EvidenceType = 'output' | 'screenshot' | 'proxy_log' | 'app_log' | EvidenceUploadType;
/** Every type a key may name: the worker's own and the uploaded ones. */
export const EVIDENCE_TYPES: readonly EvidenceType[] = [...new Set<EvidenceType>(['output', 'screenshot', 'video', 'trace', 'har', 'proxy_log', 'app_log', ...EVIDENCE_UPLOAD_TYPES])];

/** The only content types evidence is stored as; an upload of any other is refused. */
export const EVIDENCE_CONTENT_TYPES = ['application/json', 'text/plain', 'image/png', 'video/webm', 'application/zip'] as const;
export type EvidenceContentType = (typeof EVIDENCE_CONTENT_TYPES)[number];

const KIB = 1_024;
const MIB = 1_024 * KIB;

/** Each upload type's content type and byte ceiling (design table "What is captured"). A grant never asks more. */
export function evidenceUploadLimit(type: EvidenceUploadType): { contentType: EvidenceContentType; maxBytes: number } {
    if (type.startsWith('screenshot-') || type.startsWith('pixeldiff-')) return { contentType: 'image/png', maxBytes: 2 * MIB };
    switch (type) {
        case 'logs':
            return { contentType: 'text/plain', maxBytes: 256 * KIB };
        case 'db':
            return { contentType: 'application/json', maxBytes: 64 * KIB };
        case 'cast':
            // asciicast v2 is newline-delimited JSON; stored as text so it is never parsed as one document.
            return { contentType: 'text/plain', maxBytes: 512 * KIB };
        case 'video':
            return { contentType: 'video/webm', maxBytes: 20 * MIB };
        case 'trace':
            return { contentType: 'application/zip', maxBytes: 20 * MIB };
        case 'har':
            return { contentType: 'application/json', maxBytes: 10 * MIB };
    }
    throw new InvalidEvidenceKeyError('invalid upload type');
}

export const isEvidenceUploadType = (t: string): t is EvidenceUploadType => (EVIDENCE_UPLOAD_TYPES as readonly string[]).includes(t);
export const isEvidenceContentType = (t: string): t is EvidenceContentType => (EVIDENCE_CONTENT_TYPES as readonly string[]).includes(t);

/** Evidence URLs live at most 5 minutes (§7). */
export const EVIDENCE_MAX_TTL_SECONDS = 300;

const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const STEP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class InvalidEvidenceKeyError extends Error {}

export function evidenceKey(input: {
    organizationId: string;
    runId: string;
    side: string;
    stepId: string;
    type: string;
}): string {
    const { organizationId, runId, side, stepId, type } = input;
    if (!SAFE_ID.test(organizationId) || !SAFE_ID.test(runId)) throw new InvalidEvidenceKeyError('invalid run');
    if (!STEP_ID.test(stepId)) throw new InvalidEvidenceKeyError('stepId must be a uuid');
    if (!(EVIDENCE_SIDES as readonly string[]).includes(side)) throw new InvalidEvidenceKeyError('invalid side');
    if (!(EVIDENCE_TYPES as readonly string[]).includes(type)) throw new InvalidEvidenceKeyError('invalid type');
    return `${organizationId}/${runId}/${side}/${stepId.toLowerCase()}/${type}`;
}

const sign = (secret: string, key: string, exp: number) =>
    createHmac('sha256', secret).update(`evidence\n${key}\n${exp}`).digest('base64url');

export interface SignedEvidenceUrl {
    url: string;
    expiresAt: string;
}

export function signEvidenceUrl(input: {
    baseUrl: string;
    key: string;
    secret: string;
    ttlSeconds: number;
    now?: Date;
}): SignedEvidenceUrl {
    if (!input.secret || input.secret.length < 32) throw new Error('evidence signing secret must have at least 32 characters');
    const ttl = Math.min(Math.max(1, Math.floor(input.ttlSeconds)), EVIDENCE_MAX_TTL_SECONDS);
    const exp = Math.floor((input.now ?? new Date()).getTime() / 1000) + ttl;
    const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/${input.key}`);
    // Nothing else goes in the URL: the evidence server always answers as an
    // attachment, whatever a parameter would ask (the signature covers the key and exp only).
    url.searchParams.set('exp', String(exp));
    url.searchParams.set('sig', sign(input.secret, input.key, exp));
    return { url: url.toString(), expiresAt: new Date(exp * 1000).toISOString() };
}

/** What the evidence server checks before serving the exact key. */
export function verifyEvidenceSignature(input: {
    key: string;
    exp: number;
    sig: string;
    secret: string;
    now?: Date;
}): boolean {
    const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (!Number.isInteger(input.exp) || input.exp <= nowSec || input.exp - nowSec > EVIDENCE_MAX_TTL_SECONDS) return false;
    const expected = Buffer.from(sign(input.secret, input.key, input.exp));
    const given = Buffer.from(String(input.sig ?? ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * Upload grants (EVIDENCE-CAPTURE-DESIGN "Transport and storage"): the worker
 * signs one per artifact with the probe step; the cell PUTs that artifact to
 * the evidence store with it. A grant is bound to the exact key (org, Run,
 * side, step, type), one content type, a byte ceiling, a nonce (single use)
 * and a short expiry. Its signature is domain-separated from a read URL's,
 * so neither can stand in for the other.
 */
export const EVIDENCE_UPLOAD_MAX_TTL_SECONDS = 900;

export interface UploadGrant {
    type: EvidenceUploadType;
    /** PUT here with Content-Type `contentType` and at most `maxBytes` bytes. */
    url: string;
    contentType: EvidenceContentType;
    maxBytes: number;
    expiresAt: string;
}

const signUpload = (secret: string, g: { key: string; contentType: string; maxBytes: number; exp: number; nonce: string }) =>
    createHmac('sha256', secret).update(`evidence-upload\n${g.key}\n${g.contentType}\n${g.maxBytes}\n${g.exp}\n${g.nonce}`).digest('base64url');

const NONCE = /^[A-Za-z0-9_-]{16,64}$/;

export function signUploadGrant(input: {
    baseUrl: string;
    organizationId: string;
    runId: string;
    side: EvidenceSide;
    stepId: string;
    type: EvidenceUploadType;
    secret: string;
    ttlSeconds: number;
    nonce: string;
    now?: Date;
}): UploadGrant {
    if (!input.secret || input.secret.length < 32) throw new Error('evidence signing secret must have at least 32 characters');
    if (!NONCE.test(input.nonce)) throw new Error('upload grant nonce must be 16 to 64 url-safe characters');
    const key = evidenceKey({ organizationId: input.organizationId, runId: input.runId, side: input.side, stepId: input.stepId, type: input.type });
    const { contentType, maxBytes } = evidenceUploadLimit(input.type);
    const ttl = Math.min(Math.max(1, Math.floor(input.ttlSeconds)), EVIDENCE_UPLOAD_MAX_TTL_SECONDS);
    const exp = Math.floor((input.now ?? new Date()).getTime() / 1000) + ttl;
    const url = new URL(`${input.baseUrl.replace(/\/+$/, '')}/${key}`);
    url.searchParams.set('exp', String(exp));
    url.searchParams.set('max', String(maxBytes));
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('sig', signUpload(input.secret, { key, contentType, maxBytes, exp, nonce: input.nonce }));
    return { type: input.type, url: url.toString(), contentType, maxBytes, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * What the evidence server checks before it stores an upload: the signature
 * over the exact key, the content type the request declares and the byte
 * ceiling; an expiry no further than the maximum; a type whose limits match.
 */
export function verifyUploadGrant(input: {
    key: string;
    contentType: string;
    maxBytes: number;
    exp: number;
    nonce: string;
    sig: string;
    secret: string;
    now?: Date;
}): boolean {
    const nowSec = Math.floor((input.now ?? new Date()).getTime() / 1000);
    if (!Number.isInteger(input.exp) || input.exp <= nowSec || input.exp - nowSec > EVIDENCE_UPLOAD_MAX_TTL_SECONDS) return false;
    if (!NONCE.test(String(input.nonce ?? ''))) return false;
    const type = input.key.split('/')[4] ?? '';
    if (!isEvidenceUploadType(type)) return false;
    const limit = evidenceUploadLimit(type);
    if (limit.contentType !== input.contentType || limit.maxBytes !== input.maxBytes) return false;
    const expected = Buffer.from(signUpload(input.secret, { key: input.key, contentType: input.contentType, maxBytes: input.maxBytes, exp: input.exp, nonce: input.nonce }));
    const given = Buffer.from(String(input.sig ?? ''));
    return expected.length === given.length && timingSafeEqual(expected, given);
}
