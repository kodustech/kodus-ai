import type { ProviderErrorKind } from '@libs/runtime/fleet/provider-error';

// RECORDED FROM DOCS, NOT FROM THE LIVE API.
//
// A boat v1 API that answers with the shapes documented on docs.boat.dev
// (API reference pages for create, get, list, update and delete of a
// sandbox, the deletion operation, GET /limits and saved snapshots; limits
// and errors page; all read 2026-11-17). Nothing here was observed on the
// live API: no key exists yet. The live test (boat-provider.live.spec.ts,
// RUNTIME_BOAT_LIVE_TEST=1) is what confirms these shapes. Specs only.

/** Not a boat key: the recorded API accepts only this placeholder. */
export const RECORDED_KEY = 'boat_RECORDED_FROM_DOCS_NOT_A_KEY';

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

type Sandbox = { id: string; name: string; state: string; labels: Record<string, string>; type: string; snapshots: boolean; monitoring: boolean; ttlSeconds: number | null; createdAt: string };
type Answer = { status: number; body: unknown; headers?: Record<string, string> };

/** The documented ErrorEnvelope of each failure the conformance suite injects. */
export function recordedError(kind: ProviderErrorKind): Answer {
    const env = (status: number, code: string, extra: Record<string, unknown> = {}) => ({
        status,
        body: { ok: false, type: 'sandbox.error', status, code, message: 'recorded', error: { code, message: 'recorded', status, details: extra }, requestId: 'req_recorded', ...extra },
        headers: status === 429 ? { 'retry-after': String(extra.retryAfterSeconds ?? 30) } : {},
    });
    switch (kind) {
        case 'throttled':
            return env(429, 'rate_limited', { window: 'minute', limit: 12, cause: 'plan', nextStartAt: '2026-11-17T12:01:00Z', retryAfterSeconds: 60 });
        case 'quota_exceeded':
            return env(429, 'limit_reached');
        case 'capacity_unavailable':
            return env(503, 'no_ready_machine', { retryAfterSeconds: 5 });
        case 'unauthorized':
            return env(401, 'unauthorized');
        case 'invalid_class':
            return env(403, 'machine_class_plan_required');
        case 'transient':
            return env(500, 'internal_error');
    }
}

export class RecordedBoat {
    readonly sandboxes = new Map<string, Sandbox>();
    readonly calls: Array<{ method: string; path: string; headers: Record<string, string>; body?: any }> = [];
    private readonly idempotency = new Map<string, { body: string; id: string }>();
    private readonly failures: Array<{ route: string; answer: Answer }> = [];
    private readonly saved = new Map<string, { name: string; status: string; sourceSandboxId: string; createdAt: string }>();
    private seq = 0;
    /** GET /limits as documented (LimitsFields), a $20 plan with a few starts spent. */
    limits: any = {
        ok: true,
        type: 'account.limits',
        canStart: true,
        billingStatus: 'active',
        activeSandboxes: 3,
        maxActiveSandboxes: 100,
        startLimits: { perMinute: 12, perHour: 60, perDay: 200 },
        starts: { minute: { limit: 12, used: 1, remaining: 11 }, hour: { limit: 60, used: 3, remaining: 57 }, day: { limit: 200, used: 10, remaining: 190 } },
        machineTypes: [
            { type: 'small', available: true, reason: null },
            { type: 'default', available: true, reason: null },
            { type: 'large', available: true, reason: null },
            { type: 'xlarge', available: false, reason: 'needs the $100 plan' },
        ],
    };

    constructor(private readonly opts: { pageSize?: number } = {}) {}

    /** The next request to this route (`METHOD /path-without-ids`) answers this. */
    failNext(route: string, answer: Answer) {
        this.failures.push({ route, answer });
    }

    addSandbox(labels: Record<string, string>): string {
        const s = this.sandbox({ labels, type: 'large', snapshots: false, monitoring: false, ttlSeconds: 3600, name: 'foreign' });
        s.state = 'ready';
        return s.id;
    }

    setState(id: string, state: string) {
        const s = this.sandboxes.get(id);
        if (s) s.state = state;
    }

    private sandbox(p: Omit<Sandbox, 'id' | 'state' | 'createdAt'>): Sandbox {
        let n = ++this.seq;
        let id = '';
        for (let i = 0; i < 8; i++) {
            id += ALPHABET[n % ALPHABET.length];
            n = Math.floor(n / ALPHABET.length);
        }
        const s: Sandbox = { id: `bx_${id}`, state: 'provisioning', createdAt: '2026-11-17T12:00:00Z', ...p };
        this.sandboxes.set(s.id, s);
        return s;
    }

    private view(s: Sandbox) {
        return { id: s.id, name: s.name, state: s.state, labels: s.labels, type: s.type, snapshots: s.snapshots, monitoring: s.monitoring, ttlSeconds: s.ttlSeconds, desktopAvailable: false, snapshotAvailable: false, createdAt: s.createdAt, health: 'ok', healthReason: null, error: null };
    }

    readonly fetch: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const method = (init?.method ?? 'GET').toUpperCase();
        const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
        const raw = typeof init?.body === 'string' ? init.body : undefined;
        const path = url.pathname.replace(/^\/api\/v1/, '');
        this.calls.push({ method, path, headers, ...(raw ? { body: JSON.parse(raw) } : {}) });
        const answer = this.answer(method, path, url.searchParams, headers, raw);
        return new Response(JSON.stringify(answer.body), { status: answer.status, headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) } });
    };

    private answer(method: string, path: string, q: URLSearchParams, headers: Record<string, string>, raw?: string): Answer {
        if (headers.authorization !== `Bearer ${RECORDED_KEY}`) return recordedError('unauthorized');
        const route = `${method} ${path.replace(/bx_[a-z0-9]{8}/, '{id}').replace(/^\/saved-snapshots\/.+$/, '/saved-snapshots/{name}')}`;
        const fail = this.failures.findIndex((f) => f.route === route);
        if (fail >= 0) return this.failures.splice(fail, 1)[0].answer;
        const id = path.match(/^\/sandboxes\/(bx_[a-z0-9]{8})$/)?.[1];
        const notFound = { status: 404, body: { ok: false, type: 'sandbox.error', status: 404, code: 'not_found', message: 'Not found', error: { code: 'not_found', message: 'Not found', status: 404 }, requestId: 'req_recorded' } };
        if (route === 'POST /sandboxes') {
            const key = headers['idempotency-key'];
            const prior = key ? this.idempotency.get(key) : undefined;
            if (prior && prior.body !== raw) return { status: 409, body: { ok: false, code: 'idempotency_key_reused', message: 'recorded', error: { code: 'idempotency_key_reused', message: 'recorded', status: 409 } } };
            if (prior) {
                const s = this.sandboxes.get(prior.id)!;
                return { status: 202, body: { ok: true, type: 'sandbox.created', status: s.state === 'provisioning' ? 'provisioning' : 'ready', ttlSeconds: s.ttlSeconds, sandbox: this.view(s) } };
            }
            const b = JSON.parse(raw ?? '{}');
            const s = this.sandbox({ labels: b.labels ?? {}, type: b.type ?? 'default', snapshots: b.snapshots ?? true, monitoring: b.monitoring ?? true, ttlSeconds: b.ttlSeconds ?? 3600, name: b.name ?? 'Sandbox' });
            if (key) this.idempotency.set(key, { body: raw ?? '', id: s.id });
            return { status: 202, body: { ok: true, type: 'sandbox.created', status: 'provisioning', ttlSeconds: s.ttlSeconds, sandbox: this.view(s) }, headers: { 'ratelimit-policy': '"ip";q=600;w=60, "starts-minute";q=12;w=60, "starts-hour";q=60;w=3600, "starts-day";q=200;w=86400', ratelimit: '"starts-minute";r=11;t=60' } };
        }
        if (route === 'GET /sandboxes') {
            const label = q.getAll('label').map((l) => l.split('='));
            const all = [...this.sandboxes.values()].filter((s) => label.every(([k, v]) => s.labels[k] === v));
            const size = Math.min(Number(q.get('limit') ?? 100), this.opts.pageSize ?? 200);
            const start = Number(q.get('cursor') ?? 0);
            const page = all.slice(start, start + size);
            const more = start + size < all.length;
            return { status: 200, body: { ok: true, type: 'sandbox.list', sandboxes: page.map((s) => this.view(s)), pageInfo: { nextCursor: more ? String(start + size) : null, hasMore: more, limit: size } } };
        }
        if (id && method === 'GET') {
            const s = this.sandboxes.get(id);
            return s ? { status: 200, body: { ok: true, type: 'sandbox.info', sandbox: this.view(s) } } : notFound;
        }
        if (id && method === 'PATCH') {
            const s = this.sandboxes.get(id);
            if (!s) return notFound;
            s.ttlSeconds = JSON.parse(raw ?? '{}').ttlSeconds ?? s.ttlSeconds;
            return { status: 200, body: { ok: true, type: 'sandbox.info', sandbox: this.view(s) } };
        }
        if (id && method === 'DELETE') {
            const s = this.sandboxes.get(id);
            if (!s) return notFound;
            if (headers['x-ascii-confirm-delete'] !== id) return { status: 409, body: { ok: false, code: 'confirm_delete_required', message: 'recorded', error: { code: 'confirm_delete_required', message: 'recorded', status: 409 } } };
            // The target is gone from every list once the operation exists.
            this.sandboxes.delete(id);
            return { status: 202, body: { ok: true, type: 'sandbox.deleting', operation: { id: `bdop_${'0'.repeat(32)}`, kind: 'sandbox', targetId: id, reason: 'explicit', status: 'pending', attemptCount: 0, requestedAt: '2026-11-17T12:00:00Z', completedAt: null } } };
        }
        if (route === 'GET /limits') return { status: 200, body: this.limits };
        if (route === 'POST /saved-snapshots') {
            const b = JSON.parse(raw ?? '{}');
            if (!this.sandboxes.has(b.sandboxId)) return notFound;
            const snap = { name: b.name, status: 'saving', sourceSandboxId: b.sandboxId, createdAt: '2026-11-17T12:00:00Z' };
            this.saved.set(b.name, snap);
            return { status: 202, body: { ok: true, type: 'snapshot.saved.saving', status: 'saving', snapshot: { ...snap } } };
        }
        if (route === 'GET /saved-snapshots/{name}') {
            const snap = this.saved.get(decodeURIComponent(path.slice('/saved-snapshots/'.length)));
            if (!snap) return notFound;
            // A save settles between two reads here; on boat it takes seconds to minutes.
            snap.status = 'ready';
            return { status: 200, body: { ok: true, type: 'snapshot.saved', snapshot: { ...snap } } };
        }
        if (route === 'DELETE /saved-snapshots/{name}') {
            const name = decodeURIComponent(path.slice('/saved-snapshots/'.length));
            if (!this.saved.delete(name)) return notFound;
            return { status: 200, body: { ok: true, type: 'snapshot.saved.deleted', name } };
        }
        return notFound;
    }
}
