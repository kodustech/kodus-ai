import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';

import { InvalidEvidenceKeyError, isEvidenceContentType, verifyEvidenceSignature, verifyUploadGrant } from '@libs/runtime/api/domain/evidence';

import { canonicalEvidenceKey, type EvidenceStore } from '../../shared/evidence/file-evidence-store';

// The evidence server (§8, RT-16): its own origin, no cookie, no session.
// It serves one exact key for a URL the API signed after the per-object
// check (GET /runtime/runs/:id/evidence/:stepId), for at most 5 minutes, as
// an attachment with a sandbox CSP, so HTML or JS from a PR never runs with
// any Kodus origin's rights. Anything else is 4xx without detail.
//
// With uploads on, it also takes a cell's PUT of one artifact with the
// upload grant the worker signed for it (EVIDENCE-CAPTURE-DESIGN): the exact
// key, the declared content type (one of EVIDENCE_CONTENT_TYPES, the one
// the type allows), at most the grant's bytes, before it expires, once.

const HEADERS = {
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

export interface EvidenceServerOptions {
    store: Pick<EvidenceStore, 'get'> & Partial<Pick<EvidenceStore, 'put'>>;
    /** RUNTIME_EVIDENCE_SIGNING_SECRET, shared with the API only. */
    secret: string;
    now?: () => Date;
    /** Accept PUT with an upload grant (needs a store that can put). */
    uploads?: boolean;
}

/** Types the Run page embeds by signed URL (<img>, <video>); every other one stays same-origin. */
const MEDIA_TYPES = new Set(['image/png', 'video/webm']);

const TYPE_EXT: Record<string, string> = { 'application/json': 'json', 'text/plain': 'txt', 'image/png': 'png', 'video/webm': 'webm', 'application/zip': 'zip' };

const TEXT: Record<number, string> = {
    400: 'bad request',
    403: 'forbidden',
    404: 'not found',
    405: 'method not allowed',
    409: 'conflict',
    411: 'length required',
    413: 'too large',
    415: 'unsupported media type',
    500: 'error',
};

type DenyStatus = 400 | 403 | 404 | 405 | 409 | 411 | 413 | 415 | 500;

/** Nonces of grants already used, until their expiry: a grant stores once even if its object is swept. */
class UsedNonces {
    private readonly used = new Map<string, number>();
    constructor(private readonly max = 100_000) {}

    /** Records the nonce; false when it was seen. */
    claim(nonce: string, exp: number, nowSec: number): boolean {
        if (this.used.size >= this.max) for (const [n, e] of this.used) if (e <= nowSec) this.used.delete(n);
        if (this.used.has(nonce)) return false;
        // Full of live grants: refuse rather than forget one (a forgotten nonce could be replayed).
        if (this.used.size >= this.max) return false;
        this.used.set(nonce, exp);
        return true;
    }
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer | 'too_large'> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > max) {
                resolve('too_large');
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function deny(res: ServerResponse, status: DenyStatus) {
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(TEXT[status]);
}

export function evidenceRequestHandler(opts: EvidenceServerOptions) {
    if (!opts.secret || opts.secret.length < 32) throw new Error('evidence signing secret must have at least 32 characters');
    const now = opts.now ?? (() => new Date());
    const nonces = new UsedNonces();
    const upload = async (req: IncomingMessage, res: ServerResponse, url: URL, key: string) => {
        const put = opts.store.put?.bind(opts.store);
        if (!opts.uploads || !put) return deny(res, 405);
        const exp = Number(url.searchParams.get('exp'));
        const maxBytes = Number(url.searchParams.get('max'));
        const nonce = url.searchParams.get('nonce') ?? '';
        const sig = url.searchParams.get('sig') ?? '';
        // The declared type, exactly: no parameters, no sniffing.
        const contentType = String(req.headers['content-type'] ?? '').trim().toLowerCase();
        if (!isEvidenceContentType(contentType)) return deny(res, 415);
        // The grant binds the content type too: a PNG grant never stores text.
        if (!verifyUploadGrant({ key, contentType, maxBytes, exp, nonce, sig, secret: opts.secret, now: now() })) return deny(res, 403);
        const declared = req.headers['content-length'];
        if (declared === undefined) return deny(res, 411);
        if (!/^\d+$/.test(String(declared)) || Number(declared) > maxBytes) return deny(res, 413);
        if (!nonces.claim(nonce, exp, Math.floor(now().getTime() / 1000))) return deny(res, 409);
        // Single use across restarts too: an object already there is never replaced by a cell.
        if (await opts.store.get(key)) return deny(res, 409);
        const body = await readBody(req, maxBytes);
        if (body === 'too_large') return deny(res, 413);
        await put(key, body, contentType);
        res.writeHead(201, { ...HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('stored');
    };
    return async (req: IncomingMessage, res: ServerResponse) => {
        try {
            if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'PUT') return deny(res, 405);
            const url = new URL(req.url ?? '/', 'http://evidence.invalid');
            if (url.pathname === '/health') {
                res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/plain' });
                return res.end('ok');
            }
            let key: string;
            try {
                key = canonicalEvidenceKey(decodeURIComponent(url.pathname.replace(/^\/+/, '')));
            } catch (e) {
                if (e instanceof InvalidEvidenceKeyError || e instanceof URIError) return deny(res, 404);
                throw e;
            }
            if (req.method === 'PUT') return await upload(req, res, url, key);
            const exp = Number(url.searchParams.get('exp'));
            const sig = url.searchParams.get('sig') ?? '';
            if (!verifyEvidenceSignature({ key, exp, sig, secret: opts.secret, now: now() })) return deny(res, 403);
            const obj = await opts.store.get(key);
            if (!obj) return deny(res, 404);
            const [, , side, stepId, type] = key.split('/');
            // Only an evidence type is served as itself; anything else stored is bytes.
            const type0 = obj.contentType.split(';')[0].trim().toLowerCase();
            const ext = TYPE_EXT[type0];
            res.writeHead(200, {
                ...HEADERS,
                // A screenshot or a video is shown on the Run page as an <img> or <video> whose src is this signed
                // URL (ADR-071): only those may be embedded by another origin. Nothing else is, and nothing is ever
                // inlined into the app's DOM.
                ...(MEDIA_TYPES.has(type0) ? { 'Cross-Origin-Resource-Policy': 'cross-origin' } : {}),
                'Content-Type': ext ? type0 : 'application/octet-stream',
                'Content-Length': String(obj.body.length),
                // Always an attachment, whatever the URL asks for.
                'Content-Disposition': `attachment; filename="${side}-${stepId}-${type}.${ext ?? 'bin'}"`,
            });
            res.end(req.method === 'HEAD' ? undefined : obj.body);
        } catch {
            if (!res.headersSent) deny(res, 500);
            else res.destroy();
        }
    };
}

export function startEvidenceServer(opts: EvidenceServerOptions & { port: number; host?: string }): Promise<Server> {
    const server = createServer(evidenceRequestHandler(opts));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve(server));
    });
}
