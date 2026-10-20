/**
 * The only network peer of a Claude Agent SDK subprocess (#2113).
 *
 * One `node:http` server per worker on 127.0.0.1, ephemeral port, started on
 * first use. Each SDK call opens a session: a random token the subprocess puts
 * in its base URL (`/s/<token>`), revoked when the call ends. The gateway
 * holds the slot's credential, so the subprocess never has one.
 *
 * Per model request: the slot's BYOK envelope (limiter, tpm estimate and
 * reconcile, classification, cooldown, reporter), the upstream credential for
 * the route's format, the response streamed back unbuffered through a usage
 * tap, and one record in the session ledger. An upstream 4xx/5xx goes back to
 * the CLI unchanged and is recorded as the attempt's error.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { APICallError } from '@ai-sdk/provider';

import { reportByokFailure, runInByokEnvelope, type ByokEnvelopeOptions } from '@libs/llm/byok-call-envelope';

import type { SdkRoute } from '../route';
import { compactionOf, SessionLedger, type LedgerUsage, type SessionLedgerSnapshot } from './ledger';
import { UsageTap, tapKindFor } from './usage-tap';
import { anthropicUpstream } from './routes/anthropic';
import { vertexUpstream, googleAccessToken, type VertexTokenSource } from './routes/vertex';
import { bedrockUpstream } from './routes/bedrock';
import type { IncomingRequest, Upstream } from './routes/types';

/** One model request as the trace records it. */
export interface RequestObservation {
    model?: string;
    input: unknown;
    output: string;
    usage?: LedgerUsage;
    status: number;
    ms: number;
    compaction?: string;
}

export interface GatewaySessionParams {
    route: SdkRoute;
    envelope: ByokEnvelopeOptions;
    /** A9: the caller's explicit temperature, for older Claude models. */
    temperature?: number;
    /** The call's signal: queued requests stop waiting and in-flight ones abort. */
    signal?: AbortSignal;
    /** Called once per model request after it completes (Langfuse generation). */
    observe?: (o: RequestObservation) => void | Promise<void>;
}

export interface GatewaySession {
    token: string;
    /** Origin + session prefix: the CLI's base URL (Vertex mode adds `/v1`). */
    baseUrl: string;
    ledger: SessionLedger;
    /** Errors raised in the gateway itself (limiter queue timeout, unreachable upstream). */
    localErrors: Error[];
    close(): SessionLedgerSnapshot;
}

export interface SdkGatewayOptions {
    fetch?: typeof fetch;
    vertexToken?: VertexTokenSource;
}

interface LiveSession extends GatewaySession {
    params: GatewaySessionParams;
    /** A non-retryable upstream answer; later requests of the session get it back without a call. */
    fatal?: { status: number; headers: Record<string, string>; body: string };
}

/**
 * Answers the AI SDK path never retries (bad key, billing, permission, unknown
 * model). The CLI retries them up to its retry count; the gateway gives the
 * same answer back for the rest of the session, so the provider sees one
 * request and the slot one report, as today.
 */
const FATAL_STATUSES: ReadonlySet<number> = new Set([401, 402, 403, 404]);

const DROP_REQUEST_HEADERS = new Set([
    'host',
    'connection',
    'keep-alive',
    'content-length',
    'transfer-encoding',
    'accept-encoding',
    'x-api-key',
    'authorization',
    'proxy-authorization',
    'proxy-connection',
    'upgrade',
]);
const DROP_RESPONSE_HEADERS = new Set(['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'keep-alive']);

function anthropicError(type: string, message: string) {
    return JSON.stringify({ type: 'error', error: { type, message } });
}

function incomingHeaders(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || DROP_REQUEST_HEADERS.has(k)) continue;
        out[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    return out;
}

function responseHeaders(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
        if (!DROP_RESPONSE_HEADERS.has(key)) out[key] = value;
    });
    return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function parseJson(buf: Buffer): Record<string, any> | undefined {
    try {
        return JSON.parse(buf.toString('utf8'));
    } catch {
        return undefined;
    }
}

export class SdkGateway {
    private server?: Server;
    private starting?: Promise<void>;
    private port = 0;
    private readonly sessions = new Map<string, LiveSession>();
    private readonly sockets = new Set<Socket>();
    private readonly fetchImpl: typeof fetch;
    private readonly vertexToken: VertexTokenSource;

    constructor(opts: SdkGatewayOptions = {}) {
        this.fetchImpl = opts.fetch ?? fetch;
        this.vertexToken = opts.vertexToken ?? googleAccessToken;
    }

    get origin(): string {
        return `http://127.0.0.1:${this.port}`;
    }

    get liveSessions(): number {
        return this.sessions.size;
    }

    /** Idempotent: the first session starts the server. */
    start(): Promise<void> {
        if (this.server) return Promise.resolve();
        this.starting ??= new Promise<void>((resolve, reject) => {
            const server = createServer((req, res) => {
                this.handle(req, res).catch((err) => {
                    if (!res.headersSent) {
                        res.writeHead(500, { 'content-type': 'application/json' });
                        res.end(anthropicError('api_error', `gateway: ${String(err?.message ?? err)}`));
                    } else res.destroy();
                });
            });
            server.on('connection', (s) => {
                this.sockets.add(s);
                s.on('close', () => this.sockets.delete(s));
            });
            server.once('error', (e) => {
                this.starting = undefined;
                reject(e);
            });
            // Port 0: the OS picks a free one, so a port in use never blocks us.
            server.listen(0, '127.0.0.1', () => {
                this.port = (server.address() as { port: number }).port;
                // Never what keeps a process alive: it serves calls that are.
                server.unref();
                this.server = server;
                resolve();
            });
        });
        return this.starting;
    }

    async openSession(params: GatewaySessionParams): Promise<GatewaySession> {
        await this.start();
        const token = randomBytes(24).toString('hex');
        const ledger = new SessionLedger();
        const session: LiveSession = {
            token,
            baseUrl: `${this.origin}/s/${token}`,
            ledger,
            localErrors: [],
            params,
            close: () => {
                this.sessions.delete(token);
                return ledger.snapshot();
            },
        };
        this.sessions.set(token, session);
        return session;
    }

    /** Revokes every session and stops listening; open sockets are dropped. */
    async close(): Promise<void> {
        this.sessions.clear();
        const server = this.server;
        this.server = undefined;
        this.starting = undefined;
        if (!server) return;
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
            for (const s of this.sockets) s.destroy();
        });
    }

    private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const url = req.url ?? '/';
        const m = url.match(/^\/s\/([0-9a-f]{48})(\/.*)?$/);
        const session = m ? this.sessions.get(m[1]) : undefined;
        const body = await readBody(req);
        if (!session) {
            res.writeHead(401, { 'content-type': 'application/json' });
            res.end(anthropicError('authentication_error', 'gateway: unknown or expired session'));
            return;
        }
        const incoming: IncomingRequest = { method: req.method ?? 'GET', path: m![2] ?? '/', headers: incomingHeaders(req), body };
        if (incoming.method === 'HEAD' && incoming.path === '/api/hello') {
            res.writeHead(200);
            res.end();
            return;
        }
        const upstream = await this.upstreamFor(session.params, incoming);
        if (upstream.kind === 'local') {
            res.writeHead(upstream.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(upstream.body));
            return;
        }
        if (!upstream.modelRequest) {
            await this.forward(session, upstream, res);
            return;
        }
        await this.modelRequest(session, upstream, req, res);
    }

    private upstreamFor(params: GatewaySessionParams, req: IncomingRequest): Promise<Upstream> | Upstream {
        const route = params.route;
        if (route.format === 'anthropic') return anthropicUpstream(route, req, params.temperature);
        if (route.format === 'vertex') return vertexUpstream(route, req, this.vertexToken);
        return bedrockUpstream(route, req);
    }

    private async send(session: LiveSession, upstream: Extract<Upstream, { kind: 'forward' }>): Promise<Response> {
        return this.fetchImpl(upstream.url, {
            method: upstream.method,
            headers: upstream.headers,
            body: upstream.body.length ? new Uint8Array(upstream.body) : undefined,
            signal: session.params.signal,
        });
    }

    /** count_tokens and other non-model paths: credential applied, no envelope. */
    private async forward(session: LiveSession, upstream: Extract<Upstream, { kind: 'forward' }>, res: ServerResponse): Promise<void> {
        const r = await this.send(session, upstream);
        res.writeHead(r.status, responseHeaders(r.headers));
        if (r.body) await pipeline(Readable.fromWeb(r.body as any), res);
        else res.end();
    }

    private async modelRequest(
        session: LiveSession,
        upstream: Extract<Upstream, { kind: 'forward' }>,
        req: IncomingMessage,
        res: ServerResponse,
    ): Promise<void> {
        const { params, ledger } = session;
        if (session.fatal) {
            res.writeHead(session.fatal.status, session.fatal.headers);
            res.end(session.fatal.body);
            return;
        }
        const started = Date.now();
        const parsed = parseJson(upstream.body);
        const compaction = compactionOf(req.headers['x-claude-code-compaction']);
        const input = parsed ? { system: parsed.system, messages: parsed.messages } : undefined;

        try {
            await runInByokEnvelope<{ usage?: LedgerUsage }>(
                params.envelope,
                {
                    abortSignal: params.signal,
                    prompt: input,
                    usageTokens: (r) => (r.usage ? r.usage.inputTokens + r.usage.outputTokens : undefined),
                },
                async () => {
                    const r = await this.send(session, upstream);
                    const headers = responseHeaders(r.headers);
                    if (r.status >= 400) {
                        const text = await r.text();
                        res.writeHead(r.status, headers);
                        res.end(text);
                        if (FATAL_STATUSES.has(r.status)) session.fatal = { status: r.status, headers, body: text };
                        const retryAfter = r.headers.get('retry-after') ?? undefined;
                        ledger.recordError({ status: r.status, body: text, ...(retryAfter ? { retryAfter } : {}) });
                        ledger.record({ status: r.status, ms: Date.now() - started, ...(compaction ? { compaction } : {}) });
                        // The CLI gets the answer as is; the slot gets today's
                        // classification, cooldown and report for it.
                        try {
                            await params.observe?.({ model: parsed?.model, input, output: text, status: r.status, ms: Date.now() - started, ...(compaction ? { compaction } : {}) });
                        } catch {
                            /* tracing never fails a request */
                        }
                        reportByokFailure(
                            params.envelope,
                            new APICallError({
                                message: `upstream ${r.status}`,
                                url: upstream.url,
                                requestBodyValues: {},
                                statusCode: r.status,
                                responseHeaders: Object.fromEntries(r.headers.entries()),
                                responseBody: text,
                                isRetryable: r.status === 429 || r.status >= 500,
                            }),
                        );
                        return {};
                    }
                    res.writeHead(r.status, headers);
                    const kind = tapKindFor(r.headers.get('content-type') ?? undefined);
                    const tap = kind ? new UsageTap(kind) : undefined;
                    if (r.body) {
                        const source = Readable.fromWeb(r.body as any);
                        await (tap ? pipeline(source, tap, res) : pipeline(source, res));
                    } else res.end();
                    const result = tap?.result();
                    const ms = Date.now() - started;
                    ledger.record({ status: r.status, ms, ...(result?.usage ? { usage: result.usage } : {}), ...(compaction ? { compaction } : {}) });
                    try {
                        await params.observe?.({
                            model: parsed?.model,
                            input,
                            output: result?.output ?? '',
                            usage: result?.usage,
                            status: r.status,
                            ms,
                            ...(compaction ? { compaction } : {}),
                        });
                    } catch {
                        /* tracing never fails a request */
                    }
                    return { usage: result?.usage };
                },
            );
        } catch (err) {
            // Raised before or instead of an upstream answer: limiter queue
            // timeout, abort, unreachable upstream. Kept for the executor, which
            // raises it as the attempt's error; the CLI gets a non-retryable 400
            // so it stops instead of queueing again.
            session.localErrors.push(err instanceof Error ? err : new Error(String(err)));
            if (!res.headersSent) {
                res.writeHead(400, { 'content-type': 'application/json' });
                res.end(anthropicError('invalid_request_error', `gateway: ${String((err as Error)?.message ?? err)}`));
            } else res.destroy();
        }
    }
}
