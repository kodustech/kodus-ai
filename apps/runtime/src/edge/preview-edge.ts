import { randomBytes, type KeyObject } from 'crypto';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'http';
import { connect as h2connect, constants as h2, type ClientHttp2Session, type ClientHttp2Stream } from 'http2';
import { request as httpsRequest } from 'https';
import type { Duplex } from 'stream';
import { checkServerIdentity } from 'tls';

import { metrics as otel } from '@opentelemetry/api';

import {
    isOpenPreviewState,
    isPreviewReturnPath,
    isSiblingPreviewRequest,
    PREVIEW_ACTIVITY_EVERY_MS,
    PREVIEW_COOKIE_HEADER_MAX,
    PREVIEW_LIMITS,
    PREVIEW_RESERVED_PREFIX,
    PREVIEW_SESSION_MAX_HOURS,
    PREVIEW_SESSION_PATH,
    PREVIEW_SESSION_REVALIDATE_MINUTES,
    PREVIEW_STREAM_HEADERS,
    PREVIEW_TUNNEL_AUTH_SCHEME,
    PREVIEW_TUNNEL_TICKET_PATTERN,
    type PreviewRefusal,
    previewLabelOf,
    previewRequestHeaders,
    previewResponseHeaders,
    previewSessionCookie,
    previewSessionOf,
    type PreviewGrantClaims,
    previewTicketHash,
    verifyPreviewGrant,
} from '@libs/runtime/contracts/preview';
import { CatalogMeter } from '@libs/runtime/telemetry/instruments';

import { type PreviewRow, type PreviewStore, sessionHashOf } from '../shared/persistence/preview-store';
import { previewCookieClearingFor } from './cookie-clearing';
import { blockedPage, confirmPage, endedPage, notFoundPage, reopenPage, sendPage, startingPage } from './edge-pages';

// The preview edge (docs/runtime/preview-urls.md §3, §4, §6): terminates the
// browser's HTTPS for *.<preview domain>, exchanges a single-use grant from
// the app for a host-only cookie, and proxies the viewer's requests as
// HTTP/2 streams over the tunnel the preview's cell dialed. It never forwards
// its own cookie, the viewer's IP or a client X-Forwarded-*; it adds
// frame-ancestors, noindex and HSTS; and it records no path, query, header
// value or token anywhere (§11): requests are counted by outcome only.

export type EdgeLog = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>) => void;

export interface PreviewEdgeDeps {
    store: PreviewStore;
    domain: string;
    /** The web app's origin, for "open it again" links. */
    appUrl: string;
    grantPublicKey: KeyObject;
    replicaId: string;
    /**
     * This replica's browser listener as the other replicas reach it
     * (RUNTIME_PREVIEW_EDGE_INTERNAL_URL): written with each tunnel it holds,
     * so a request that lands elsewhere is forwarded here once (§4.2). Absent:
     * one replica, nothing forwarded.
     */
    internalUrl?: string;
    /** A session older than this goes back to the app for a fresh grant (RUNTIME_PREVIEW_SESSION_REVALIDATE_MINUTES); default 15. */
    sessionRevalidateMinutes?: number;
    now?: () => Date;
    meter?: CatalogMeter;
    log?: EdgeLog;
}

/** Set on a request one replica forwards to the holder of the cell's tunnel: the holder never forwards it again. */
export const PREVIEW_FORWARDED_HEADER = 'x-kodus-preview-forwarded';
/** A holder row older than this is a replica that went away (the heartbeat writes every 30 s). */
const HOLDER_FRESH_MS = 90_000;

/** The peer of a tunnel connection, as the TLS layer authenticated it. */
export interface TunnelPeer {
    authorized: boolean;
    role?: string;
    cn?: string;
    serial?: string;
}

const isNavigation = (req: IncomingMessage) => req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');

/**
 * Whether a POST comes from a page of this same preview host: Sec-Fetch-Site
 * (a header no page can set) says same-origin, or, from a browser that does
 * not send it, the Origin is this host over https. Another site, a sibling
 * preview host (same-site until the domain is on the PSL), an opaque `null`
 * origin and a request with neither are refused.
 */
function sameOriginPost(req: IncomingMessage, host: string): boolean {
    const site = req.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin') return false;
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== '') {
        let o: URL;
        try {
            o = new URL(origin);
        } catch {
            return false;
        }
        return o.protocol === 'https:' && o.hostname === host;
    }
    return site === 'same-origin';
}

/** An application/x-www-form-urlencoded body of at most `limit` bytes, or null. */
function readForm(req: IncomingMessage, limit = 8_192): Promise<URLSearchParams | null> {
    return new Promise((resolve) => {
        const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
        if (type !== 'application/x-www-form-urlencoded') {
            req.resume();
            return resolve(null);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        req.on('data', (c: Buffer) => {
            size += c.length;
            if (size <= limit) chunks.push(c);
        });
        req.on('end', () => resolve(size <= limit ? new URLSearchParams(Buffer.concat(chunks).toString('utf8')) : null));
        req.on('error', () => resolve(null));
    });
}

export class PreviewEdge {
    /** cellId → the HTTP/2 session over the cell's tunnel (the cell is the server). */
    readonly tunnels = new Map<string, ClientHttp2Session>();
    private readonly now: () => Date;
    private readonly lastActivity = new Map<string, number>();
    private readonly streamsOf = new Map<string, number>();
    private readonly sessions;
    private readonly requests;
    private readonly bytes;
    private readonly droppedCookies;
    private heartbeat?: NodeJS.Timeout;

    constructor(private readonly deps: PreviewEdgeDeps) {
        this.now = deps.now ?? (() => new Date());
        const meter = deps.meter ?? new CatalogMeter(otel.getMeter('kody-runtime'));
        this.sessions = meter.counter('runtime.preview.session');
        this.requests = meter.counter('runtime.preview.requests');
        this.bytes = meter.counter('runtime.preview.bytes');
        this.droppedCookies = meter.counter('runtime.preview.dropped_cookies');
        meter.gauge('runtime.preview.tunnels', () => [{ value: this.tunnels.size, labels: {} }]);
    }

    private log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}) {
        this.deps.log?.(level, msg, fields);
    }

    /** Keeps the holder rows fresh (the worker re-routes a preview whose cell has no fresh row) and pings each tunnel. */
    startHeartbeat(everyMs = 30_000) {
        this.heartbeat = setInterval(() => {
            const at = this.now().toISOString();
            for (const [cellId, s] of this.tunnels) {
                s.ping(() => undefined);
                // A missed refresh is written again on the next beat, well inside HOLDER_FRESH_MS.
                void this.deps.store.holdTunnel(cellId, this.deps.replicaId, at, this.deps.internalUrl).catch(() => undefined);
            }
        }, everyMs);
        this.heartbeat.unref();
    }

    close() {
        if (this.heartbeat) clearInterval(this.heartbeat);
        for (const s of this.tunnels.values()) s.destroy();
        this.tunnels.clear();
    }

    // ---- the tunnel (cell → edge) ----

    /**
     * Whether a tunnel WebSocket may be accepted: a certificate from the cell
     * CA with OU=cell, the serial pinned on the cell's row, and a one-time
     * ticket the hub issued to that same cell (consumed here). Either alone
     * opens nothing.
     */
    async authorizeTunnel(peer: TunnelPeer, authorization: string | undefined): Promise<string | null> {
        if (!peer.authorized || peer.role !== 'cell' || !peer.cn || !peer.serial) return null;
        const prefix = `${PREVIEW_TUNNEL_AUTH_SCHEME} `;
        const ticket = authorization?.startsWith(prefix) ? authorization.slice(prefix.length).trim() : '';
        if (!PREVIEW_TUNNEL_TICKET_PATTERN.test(ticket)) return null;
        const now = this.now().toISOString();
        // The ticket is spent whatever the certificate says: a stolen one is used once at most.
        const ticketOk = await this.deps.store.consumeTunnelTicket(previewTicketHash(ticket), peer.cn, now);
        if (!ticketOk) return null;
        if (!(await this.deps.store.cellCertificatePinned(peer.cn, peer.serial, now))) return null;
        return peer.cn;
    }

    /** The cell's tunnel byte stream becomes an HTTP/2 client session (the cell serves). A newer tunnel of the same cell replaces the older. */
    attachTunnel(cellId: string, stream: Duplex): ClientHttp2Session {
        const session = h2connect('http://cell.preview.invalid', {
            createConnection: () => stream,
            settings: { enablePush: false },
        });
        const previous = this.tunnels.get(cellId);
        this.tunnels.set(cellId, session);
        previous?.close();
        // A lost holder row is written again by the heartbeat within 30 s; until then another replica shows "reconnecting".
        void this.deps.store.holdTunnel(cellId, this.deps.replicaId, this.now().toISOString(), this.deps.internalUrl).catch(() => undefined);
        this.log('info', 'preview.tunnel.connected', { cellId });
        const gone = () => {
            if (this.tunnels.get(cellId) !== session) return;
            this.tunnels.delete(cellId);
            // A row left behind goes stale after HOLDER_FRESH_MS, and a stale holder is never forwarded to.
            void this.deps.store.releaseTunnel(cellId, this.deps.replicaId).catch(() => undefined);
            this.log('info', 'preview.tunnel.closed', { cellId });
        };
        session.on('close', gone);
        session.on('error', () => session.destroy());
        session.on('goaway', () => session.close());
        return session;
    }

    // ---- the browser ----

    readonly handle = (req: IncomingMessage, res: ServerResponse) => {
        this.serve(req, res).catch((e) => {
            this.log('error', 'preview.request_failed', { error: (e as Error).message.slice(0, 200) });
            if (!res.headersSent) notFoundPage(res);
            else res.destroy();
        });
    };

    private refused(row: Pick<PreviewRow, 'organizationId' | 'previewId' | 'runId' | 'side'> | null, reason: PreviewRefusal, actor?: string) {
        this.sessions.add(1, { outcome: 'refused', reason, ...(row ? { 'kodus.organization.id': row.organizationId } : {}) });
        if (row) void this.deps.store.audit({ organizationId: row.organizationId, previewId: row.previewId, ...(row.runId ? { runId: row.runId } : {}), side: row.side, ...(actor ? { actor } : {}), action: 'session_refused', reason }).catch((e: unknown) => this.log('error', 'preview.audit_unrecorded', { previewId: row.previewId, action: 'session_refused', reason, error: (e as Error).message.slice(0, 200) }));
        this.log('info', 'preview.session.refused', { reason, ...(row ? { previewId: row.previewId } : {}) });
    }

    private async serve(req: IncomingMessage, res: ServerResponse) {
        const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d{1,5}$/, '');
        if (!previewLabelOf(host, this.deps.domain)) return notFoundPage(res);
        const url = new URL(req.url ?? '/', `https://${host}`);
        // The session exchange checks its own origin (a same-origin POST only).
        if (url.pathname === PREVIEW_SESSION_PATH) return this.exchange(req, res, host, url);
        // Until the preview domain is a public suffix (PSL), every org's previews are one site (S1-WEB-01):
        // a sibling preview's script or form is refused here, and cookies it tossed onto the whole domain are
        // expired once they bloat the header, before any app sees them.
        if (isSiblingPreviewRequest(req.headers, req.method, { host, domain: this.deps.domain })) {
            this.requests.add(1, { outcome: 'refused' });
            this.log('info', 'preview.request.same_site_refused', {});
            return sendPage(res, 403, 'Preview not available', '<p>A request from another preview is not served here.</p>');
        }
        const cookies = req.headers.cookie;
        if (cookies && cookies.length > PREVIEW_COOKIE_HEADER_MAX) {
            this.requests.add(1, { outcome: 'refused' });
            this.log('info', 'preview.request.cookies_cleared', { bytes: cookies.length });
            res.setHeader('set-cookie', previewCookieClearingFor(cookies, this.deps.domain, url.pathname));
            return sendPage(res, 431, 'Too many cookies', '<p>This browser carried more cookies to the preview than it accepts; they were cleared. Reload the page.</p>');
        }
        const row = await this.deps.store.previewByHost(host);
        const cookie = previewSessionOf(req.headers.cookie);
        const session = cookie ? await this.deps.store.getSession(sessionHashOf(cookie)) : null;
        const now = this.now();
        if (!row || !session || session.closedAt || Date.parse(session.expiresAt) <= now.getTime() || session.previewId !== row.previewId || session.organizationId !== row.organizationId) {
            this.requests.add(1, { outcome: 'refused' });
            return notFoundPage(res);
        }
        // Access is checked again through the app every few minutes (#9): the app re-runs the member and repo checks before a new grant.
        if (Date.parse(session.createdAt) + (this.deps.sessionRevalidateMinutes ?? PREVIEW_SESSION_REVALIDATE_MINUTES) * 60_000 <= now.getTime()) {
            this.requests.add(1, { outcome: 'refused', 'kodus.organization.id': row.organizationId });
            if (isNavigation(req)) {
                res.writeHead(303, { location: this.launcherLink(row), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex, nofollow' });
                return res.end();
            }
            res.writeHead(401, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' });
            return res.end('the preview session must be renewed: reload the page');
        }
        if (url.pathname === '/__kodus/status') {
            res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' });
            return res.end(JSON.stringify({ state: row.state }));
        }
        if (url.pathname.startsWith(PREVIEW_RESERVED_PREFIX)) return notFoundPage(res);
        const appLink = row.runId
            ? `${this.deps.appUrl}/runtime/runs/${encodeURIComponent(row.runId)}/preview?side=${row.side}`
            : `${this.deps.appUrl}/runtime/environments/${encodeURIComponent(row.environmentId)}`;
        if (!isOpenPreviewState(row.state)) return endedPage(res, appLink);
        if (row.state === 'sleeping') {
            if (row.reason === 'reopen') return reopenPage(res, appLink);
            // The worker's next tick wakes it (a few seconds).
            await this.deps.store.requestWake(row.previewId, now.toISOString());
            this.requests.add(1, { outcome: 'waking', 'kodus.organization.id': row.organizationId });
            return isNavigation(req) ? startingPage(res, 'The preview is waking up.') : this.retryLater(res);
        }
        if (row.state === 'blocked') {
            if (row.reason === 'reopen') return reopenPage(res, appLink);
            // A reload of the page is the retry (blocked → starting); a script's request is not.
            if (isNavigation(req)) await this.deps.store.requestWake(row.previewId, now.toISOString());
            return blockedPage(res, row.reason ?? 'The preview could not start.');
        }
        if (row.state === 'starting') return isNavigation(req) ? startingPage(res, 'The preview is starting.') : this.retryLater(res);
        const tunnel = row.cellId ? this.tunnels.get(row.cellId) : undefined;
        if (!tunnel || tunnel.closed || tunnel.destroyed) {
            // Another replica holds the cell's tunnel: the request goes there once, as the browser sent it.
            const holder = row.cellId && !req.headers[PREVIEW_FORWARDED_HEADER] ? await this.deps.store.tunnelHolder(row.cellId, new Date(now.getTime() - HOLDER_FRESH_MS).toISOString()) : null;
            if (holder && holder.replica !== this.deps.replicaId && holder.url) return this.forward(req, res, host, holder.url, row);
            this.requests.add(1, { outcome: 'no_tunnel', 'kodus.organization.id': row.organizationId });
            return isNavigation(req) ? startingPage(res, 'The preview is reconnecting.') : this.retryLater(res);
        }
        this.noteActivity(row.previewId, now.getTime());
        return this.proxy(req, res, host, row, session.sessionHash, tunnel, url);
    }

    /**
     * The browser's request, as it came, to the replica holding the tunnel
     * (its internal URL): that replica checks the session again and proxies
     * it. Over TLS it must present the wildcard certificate for this
     * preview's host. Nothing here reads or logs the request.
     */
    private forward(req: IncomingMessage, res: ServerResponse, host: string, holderUrl: string, row: PreviewRow) {
        const org = { 'kodus.organization.id': row.organizationId };
        const target = new URL(holderUrl);
        const tls = target.protocol === 'https:';
        const headers: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(req.headers)) if (value !== undefined && name !== 'connection' && name !== 'keep-alive') headers[name] = value;
        headers.host = host;
        headers[PREVIEW_FORWARDED_HEADER] = this.deps.replicaId;
        const upstream = (tls ? httpsRequest : httpRequest)(
            {
                protocol: target.protocol,
                hostname: target.hostname,
                port: target.port || (tls ? 443 : 80),
                method: req.method,
                path: req.url ?? '/',
                headers,
                timeout: PREVIEW_LIMITS.requestTimeoutMs,
                ...(tls ? { servername: host, checkServerIdentity: (_: string, cert: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(host, cert) } : {}),
            },
            (answer) => {
                this.requests.add(1, { outcome: 'forwarded', ...org });
                const { connection: _c, 'keep-alive': _k, ...out } = answer.headers;
                res.writeHead(answer.statusCode ?? 502, out);
                answer.pipe(res);
            },
        );
        upstream.on('timeout', () => upstream.destroy(new Error('timeout')));
        upstream.on('error', () => {
            this.requests.add(1, { outcome: 'upstream_error', ...org });
            if (!res.headersSent) return isNavigation(req) ? startingPage(res, 'The preview is reconnecting.') : this.retryLater(res);
            res.destroy();
        });
        res.on('close', () => {
            if (!res.writableFinished) upstream.destroy();
        });
        req.pipe(upstream);
    }

    /** The app's page that opens this preview and grants it again (it sends the tab back here). */
    private launcherLink(row: PreviewRow): string {
        return row.runId
            ? `${this.deps.appUrl}/runtime/runs/${encodeURIComponent(row.runId)}/preview?side=${row.side}`
            : `${this.deps.appUrl}/runtime/environments/${encodeURIComponent(row.environmentId)}/preview`;
    }

    private retryLater(res: ServerResponse) {
        res.writeHead(503, { 'retry-after': '5', 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex, nofollow' });
        res.end('starting');
    }

    /** At most one activity write per preview a minute: the worker renews the lease and keeps it awake on it. */
    private noteActivity(previewId: string, at: number) {
        const last = this.lastActivity.get(previewId) ?? 0;
        if (at - last < PREVIEW_ACTIVITY_EVERY_MS) return;
        this.lastActivity.set(previewId, at);
        // A lost activity write is written again by the next request a minute later.
        void this.deps.store.recordActivity(previewId, new Date(at).toISOString()).catch(() => undefined);
    }

    /**
     * /__kodus/session. GET ?grant=…&to=…: the grant is checked and shown as
     * a prompt naming the repository and PR; nothing is set, unless the
     * browser already holds this same viewer's session here (a renewal, #9).
     * POST (the
     * prompt's form, from this same host): the grant becomes a host-only
     * cookie and the browser goes to `to`. A grant is a bearer credential any
     * API caller can mint for their own previews, so a cross-site redirect to
     * it must never open a session by itself (review 2026-11-14, #4).
     */
    private async exchange(req: IncomingMessage, res: ServerResponse, host: string, url: URL) {
        if (req.method === 'GET') {
            const token = url.searchParams.get('grant') ?? '';
            const to = url.searchParams.get('to') ?? '/';
            const granted = await this.checkGrant(res, host, token);
            if (!granted) return;
            const { row, g } = granted;
            // The same viewer renewing their own session on this preview (#9): they answered the prompt already.
            const cookie = previewSessionOf(req.headers.cookie);
            const held = cookie ? await this.deps.store.getSession(sessionHashOf(cookie)) : null;
            if (held && !held.closedAt && held.previewId === row.previewId && held.organizationId === row.organizationId && held.userId === g.sub) return this.openSession(res, row, g, to);
            return confirmPage(res, { repository: row.repositoryFullName, ...(row.prNumber ? { prNumber: row.prNumber } : {}), side: row.side, environment: !row.runId, grant: token, to: isPreviewReturnPath(to) ? to : '/' });
        }
        if (req.method !== 'POST') return notFoundPage(res);
        if (!sameOriginPost(req, host)) {
            req.resume();
            this.refused(await this.deps.store.previewByHost(host), 'grant_invalid');
            return notFoundPage(res);
        }
        const form = await readForm(req);
        if (!form) return notFoundPage(res);
        const granted = await this.checkGrant(res, host, form.get('grant') ?? '');
        if (!granted) return;
        return this.openSession(res, granted.row, granted.g, form.get('to') ?? '/');
    }

    /** The grant's preview and claims when the grant is good for this host's open preview; else the refusal is answered and null returned. */
    private async checkGrant(res: ServerResponse, host: string, token: string): Promise<{ row: PreviewRow; g: PreviewGrantClaims } | null> {
        const now = this.now();
        const verified = verifyPreviewGrant(this.deps.grantPublicKey, token, { host, now: now.getTime() });
        const row = await this.deps.store.previewByHost(host);
        if ('reason' in verified) {
            this.refused(row, verified.reason === 'expired' ? 'expired' : 'grant_invalid');
            notFoundPage(res);
            return null;
        }
        const g = verified.claims;
        if (!row) {
            this.refused(null, 'not_found');
            notFoundPage(res);
            return null;
        }
        // The grant names this preview of this org; anything else is someone else's grant.
        if (g.org !== row.organizationId || g.pid !== row.previewId || g.side !== row.side) {
            this.refused(row, 'other_org', g.sub);
            notFoundPage(res);
            return null;
        }
        if (!isOpenPreviewState(row.state)) {
            this.refused(row, 'expired', g.sub);
            endedPage(res);
            return null;
        }
        return { row, g };
    }

    /** Spends the grant and sets the session cookie; the 303 takes the grant out of the address bar. */
    private async openSession(res: ServerResponse, row: PreviewRow, g: PreviewGrantClaims, to: string) {
        const now = this.now();
        if (!(await this.deps.store.useGrant(g.jti, new Date(g.exp * 1000).toISOString()))) {
            this.refused(row, 'grant_replayed', g.sub);
            return notFoundPage(res);
        }
        const cookie = randomBytes(32).toString('base64url');
        const expiresAt = Math.min(Date.parse(row.expiresAt), now.getTime() + PREVIEW_SESSION_MAX_HOURS * 3_600_000);
        await this.deps.store.createSession({
            sessionHash: sessionHashOf(cookie),
            previewId: row.previewId,
            organizationId: row.organizationId,
            userId: g.sub,
            createdAt: now.toISOString(),
            expiresAt: new Date(expiresAt).toISOString(),
        });
        await this.deps.store.audit({ organizationId: row.organizationId, previewId: row.previewId, ...(row.runId ? { runId: row.runId } : {}), side: row.side, actor: g.sub, action: 'session_opened' });
        this.sessions.add(1, { outcome: 'opened', reason: 'none', 'kodus.organization.id': row.organizationId });
        this.log('info', 'preview.session.opened', { previewId: row.previewId, access: 'member' });
        res.writeHead(303, {
            location: isPreviewReturnPath(to) ? to : '/',
            'set-cookie': previewSessionCookie(cookie, Math.floor((expiresAt - now.getTime()) / 1000)),
            'referrer-policy': 'no-referrer',
            'cache-control': 'no-store',
            'x-robots-tag': 'noindex, nofollow',
            'x-frame-options': 'DENY',
        });
        res.end();
    }

    /** One browser request as one HTTP/2 stream through the cell's tunnel, streamed both ways. */
    private proxy(req: IncomingMessage, res: ServerResponse, host: string, row: PreviewRow, sessionHash: string, tunnel: ClientHttp2Session, url: URL) {
        const org = { 'kodus.organization.id': row.organizationId };
        const open = this.streamsOf.get(row.previewId) ?? 0;
        if (open >= PREVIEW_LIMITS.concurrentStreams) {
            this.requests.add(1, { outcome: 'refused', ...org });
            res.writeHead(503, { 'retry-after': '1', 'content-type': 'text/plain; charset=utf-8' });
            return res.end('too many requests at once');
        }
        const declared = Number(req.headers['content-length'] ?? 0);
        if (declared > PREVIEW_LIMITS.requestBodyBytes) {
            this.requests.add(1, { outcome: 'refused', ...org });
            res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' });
            return res.end('request body too large');
        }
        this.streamsOf.set(row.previewId, open + 1);
        let done = false;
        const finish = (outcome: string) => {
            if (done) return;
            done = true;
            this.streamsOf.set(row.previewId, Math.max(0, (this.streamsOf.get(row.previewId) ?? 1) - 1));
            this.requests.add(1, { outcome, ...org });
        };
        let stream: ClientHttp2Stream;
        try {
            stream = tunnel.request({
                ...previewRequestHeaders(req.headers, host),
                [h2.HTTP2_HEADER_METHOD]: req.method ?? 'GET',
                [h2.HTTP2_HEADER_PATH]: `${url.pathname}${url.search}`,
                [h2.HTTP2_HEADER_SCHEME]: 'https',
                [h2.HTTP2_HEADER_AUTHORITY]: host,
                [PREVIEW_STREAM_HEADERS.previewId]: row.previewId,
                [PREVIEW_STREAM_HEADERS.session]: sessionHash.slice(0, 16),
            });
        } catch {
            finish('upstream_error');
            return isNavigation(req) ? startingPage(res, 'The preview is reconnecting.') : this.retryLater(res);
        }
        stream.setTimeout(PREVIEW_LIMITS.requestTimeoutMs, () => {
            finish('timeout');
            stream.close(h2.NGHTTP2_CANCEL);
            if (!res.headersSent) {
                res.writeHead(504, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('the preview did not answer in time');
            } else res.destroy();
        });
        let up = 0;
        req.on('data', (chunk: Buffer) => {
            up += chunk.length;
            if (up > PREVIEW_LIMITS.requestBodyBytes) {
                stream.close(h2.NGHTTP2_CANCEL);
                req.destroy();
            }
        });
        req.pipe(stream);
        // The viewer went away: the stream ends at once, on the cell too.
        res.on('close', () => {
            if (!res.writableFinished) stream.close(h2.NGHTTP2_CANCEL);
            this.bytes.add(up, { direction: 'up', ...org });
        });
        stream.on('response', (headers) => {
            const status = Number(headers[h2.HTTP2_HEADER_STATUS] ?? 502);
            if (headers['kodus-preview-refused']) {
                // The cell has no route for it (yet): the worker declares it again.
                finish('no_route');
                stream.close(h2.NGHTTP2_CANCEL);
                return isNavigation(req) ? startingPage(res, 'The preview is reconnecting.') : this.retryLater(res);
            }
            const { headers: out, droppedCookies } = previewResponseHeaders(headers as Record<string, string | string[] | undefined>);
            if (droppedCookies) this.droppedCookies.add(droppedCookies);
            res.writeHead(status, out);
            let down = 0;
            stream.on('data', (c: Buffer) => (down += c.length));
            stream.on('end', () => {
                this.bytes.add(down, { direction: 'down', ...org });
                finish('ok');
            });
            stream.pipe(res);
        });
        stream.on('error', () => {
            finish('upstream_error');
            if (!res.headersSent) {
                res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
                res.end('the preview did not answer');
            } else res.destroy();
        });
        stream.on('close', () => finish(stream.rstCode === h2.NGHTTP2_NO_ERROR ? 'ok' : 'upstream_error'));
    }
}
