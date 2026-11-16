import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { z } from 'zod';

import {
    ENV_SESSION_SIGNATURE_HEADER,
    EnvSessionExecSchema,
    EnvSessionOpenSchema,
    EnvSessionOwnerSchema,
    EnvSessionNonces,
    EnvSessionValidationSchema,
    verifiedEnvSessionRequest,
} from '@libs/runtime/contracts/env-session';

import { SANDBOX_ROUTES, SandboxOpenSchema, SandboxOpRequestSchema, SandboxRefSchema, SandboxSnapshotRequestSchema, SandboxTemplateSchema } from '@libs/runtime/contracts/sandbox';
import { PREVIEW_ROUTES, PreviewOpenSchema, PreviewRefSchema } from '@libs/runtime/contracts/preview';

import { CellUnavailableError, HubRefused } from '../../shared/errors';
import { requestListener } from '../../shared/request-listener';
import { SandboxError, type SandboxService } from '../sandbox/sandbox.service';
import { PreviewError, type PreviewService } from '../preview/preview.service';
import { EnvSessionError, type EnvSessionService } from './env-session.service';

// The runtime-worker's env-session listener: the only door from the API's
// /mcp/env tools to an interactive claim. Its own port,
// reached from the product network only; every request is signed by the API
// with a key derived from RUNTIME_SECRET_SEAL_KEY over method, path, time, a
// nonce and the body, and served once. POST only, JSON in and out, no detail
// on a refusal.

const MAX_BODY = 64 * 1024;
const Uuid = z.uuid();
/** An id that cannot exist is the same 404 as an id of someone else. */
const idOf = (id: string | undefined) => {
    const r = Uuid.safeParse(id);
    if (!r.success) throw new EnvSessionError(404, 'not_found', 'not found');
    return r.data;
};
const HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

export interface EnvSessionServerOptions {
    service: Pick<EnvSessionService, 'open' | 'get' | 'exec' | 'step' | 'close' | 'validation'>;
    /** envSessionKeyFrom(RUNTIME_SECRET_SEAL_KEY). */
    key: Buffer;
    now?: () => number;
    /** The nonces this listener accepted (one per signed request); a fresh set when absent. */
    nonces?: EnvSessionNonces;
    /** The code sandboxes' routes (/sandbox/*, the runtime-sandbox provider); absent: they answer 404. */
    sandboxes?: Pick<SandboxService, 'open' | 'op' | 'renew' | 'release' | 'snapshot' | 'template'>;
    /** Preview URLs' routes (/preview/*, docs/runtime/preview-urls.md §9.2); absent: they answer 404. */
    previews?: Pick<PreviewService, 'open' | 'status' | 'stop'>;
}

function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, HEADERS);
    res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string | null> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size > max) {
                resolve(null);
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

const ROUTES: Array<{ pattern: RegExp; handle: (s: EnvSessionServerOptions['service'], id: string | undefined, body: unknown) => Promise<unknown> }> = [
    { pattern: /^\/env\/sessions$/, handle: (s, _id, body) => s.open(EnvSessionOpenSchema.parse(body)) },
    { pattern: /^\/env\/sessions\/([^/]+)\/status$/, handle: (s, id, body) => s.get(EnvSessionOwnerSchema.parse(body), idOf(id)) },
    { pattern: /^\/env\/sessions\/([^/]+)\/validation$/, handle: (s,id,body) => {const req=EnvSessionValidationSchema.parse(body);return s.validation(req,idOf(id),req.name);} },
    { pattern: /^\/env\/sessions\/([^/]+)\/exec$/, handle: (s, id, body) => s.exec({ ...EnvSessionExecSchema.parse(body), sessionId: idOf(id) }) },
    { pattern: /^\/env\/sessions\/([^/]+)\/release$/, handle: (s, id, body) => s.close(EnvSessionOwnerSchema.parse(body), idOf(id)) },
    { pattern: /^\/env\/steps\/([^/]+)$/, handle: (s, id, body) => s.step(EnvSessionOwnerSchema.parse(body), idOf(id)) },
];

// A sandbox write carries up to 512 KiB of base64: its route takes a larger body.
const MAX_SANDBOX_BODY = 1024 * 1024;
const SANDBOX: Record<string, (s: NonNullable<EnvSessionServerOptions['sandboxes']>, body: unknown) => Promise<unknown>> = {
    [SANDBOX_ROUTES.open]: (s, body) => s.open(SandboxOpenSchema.parse(body)),
    [SANDBOX_ROUTES.op]: (s, body) => s.op(SandboxOpRequestSchema.parse(body)),
    [SANDBOX_ROUTES.renew]: (s, body) => s.renew(SandboxRefSchema.parse(body)),
    [SANDBOX_ROUTES.release]: (s, body) => s.release(SandboxRefSchema.parse(body)),
    [SANDBOX_ROUTES.snapshot]: (s, body) => s.snapshot(SandboxSnapshotRequestSchema.parse(body)),
    [SANDBOX_ROUTES.template]: (s, body) => s.template(SandboxTemplateSchema.parse(body)),
};

const PREVIEW: Record<string, (s: NonNullable<EnvSessionServerOptions['previews']>, body: unknown) => Promise<unknown>> = {
    [PREVIEW_ROUTES.open]: (s, body) => s.open(PreviewOpenSchema.parse(body)),
    [PREVIEW_ROUTES.status]: (s, body) => s.status(PreviewRefSchema.parse(body)),
    [PREVIEW_ROUTES.stop]: (s, body) => s.stop(PreviewRefSchema.parse(body)),
};

export function envSessionRequestHandler(opts: EnvSessionServerOptions) {
    if (!opts.key || opts.key.length < 32) throw new Error('env-session key must have at least 32 bytes');
    const now = opts.now ?? (() => Date.now());
    // Each signed request is served once: a replay inside the skew window is refused like a bad signature.
    const nonces = opts.nonces ?? new EnvSessionNonces();
    return async (req: IncomingMessage, res: ServerResponse) => {
        try {
            const path = new URL(req.url ?? '/', 'http://env.invalid').pathname;
            if (req.method === 'GET' && path === '/health') return send(res, 200, { ok: true });
            if (req.method !== 'POST') return send(res, 405, { code: 'method_not_allowed' });
            const sandbox = opts.sandboxes && Object.hasOwn(SANDBOX, path) ? SANDBOX[path] : undefined;
            const preview = opts.previews && Object.hasOwn(PREVIEW, path) ? PREVIEW[path] : undefined;
            const route = ROUTES.map((r) => ({ r, m: r.pattern.exec(path) })).find((x) => x.m);
            if (!route && !sandbox && !preview) return send(res, 404, { code: 'not_found' });
            const raw = await readBody(req, sandbox ? MAX_SANDBOX_BODY : MAX_BODY);
            if (raw === null) return send(res, 413, { code: 'too_large' });
            const signature = req.headers[ENV_SESSION_SIGNATURE_HEADER];
            const at = now();
            const signed = verifiedEnvSessionRequest(opts.key, typeof signature === 'string' ? signature : undefined, { method: 'POST', path, body: raw, now: at });
            if (!signed || !nonces.accept(signed.nonce, signed.at, at)) {
                return send(res, 401, { code: 'unauthorized' });
            }
            let body: unknown;
            try {
                body = JSON.parse(raw);
            } catch {
                return send(res, 400, { code: 'invalid_body' });
            }
            if (sandbox) return send(res, 200, await sandbox(opts.sandboxes!, body));
            if (preview) return send(res, 200, await preview(opts.previews!, body));
            const id = route!.m![1] ? decodeURIComponent(route!.m![1]) : undefined;
            return send(res, 200, await route!.r.handle(opts.service, id, body));
        } catch (e) {
            if (e instanceof z.ZodError) return send(res, 400, { code: 'invalid_body' });
            if (e instanceof EnvSessionError || e instanceof SandboxError || e instanceof PreviewError) return send(res, e.status, { code: e.code, message: e.message });
            if (e instanceof HubRefused) return send(res, 409, { code: e.body.code, message: e.body.message });
            if (e instanceof CellUnavailableError) return send(res, 503, { code: 'cell_unavailable', message: 'The sandbox cell is not reachable now.' });
            if (!res.headersSent) return send(res, 500, { code: 'error' });
            res.destroy();
        }
    };
}

export function startEnvSessionServer(opts: EnvSessionServerOptions & { port: number; host?: string }): Promise<Server> {
    const server = createServer(requestListener(envSessionRequestHandler(opts)));
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(opts.port, opts.host ?? '0.0.0.0', () => resolve(server));
    });
}
