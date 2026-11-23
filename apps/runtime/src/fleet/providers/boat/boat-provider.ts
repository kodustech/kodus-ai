import { BOOTSTRAP_PATH, type CreateHostRequest, type HostClassFacts, type HostImagePort, type HostProvider, type HostTags, type ProviderHost, type ProviderHostState, type ProviderQuotas, type SavedImage } from '@libs/runtime/fleet/host-provider';
import type { HostClass } from '@libs/runtime/fleet/pool';
import { ProviderError } from '@libs/runtime/fleet/provider-error';

import { mapBoatError, transportError } from './boat-errors';

// boat as a host provider (docs/runtime/host-providers.md §9.2): one boat
// sandbox per Run host, created `from` the environment's saved snapshot, with
// no env, no snapshots and no monitoring, and the bootstrap file in `files`.
// Plain fetch against the v1 REST API (docs.boat.dev/api/v1, read
// 2026-11-17); no SDK. Never used: exec, prompt, host, desktop, fork, boat
// environments. The key is the fleet's alone and never logged.

const LABEL = { installation: 'kodus.installation', pool: 'kodus.pool', host: 'kodus.host' } as const;

/** boat sizes (docs.boat.dev llms.txt key facts, 17/11): vCPU, RAM, disk, list $/h. */
const SIZES: Record<string, HostClassFacts> = {
    small: { vcpu: 2, memoryMb: 4_096, diskGb: 51, usdPerHour: 0.018 },
    default: { vcpu: 4, memoryMb: 8_192, diskGb: 51, usdPerHour: 0.036 },
    large: { vcpu: 8, memoryMb: 16_384, diskGb: 111, usdPerHour: 0.072 },
    xlarge: { vcpu: 16, memoryMb: 32_768, diskGb: 251, usdPerHour: 0.2 },
};

const STATES: Record<string, ProviderHostState> = {
    init: 'pending',
    provisioning: 'pending',
    provisioned: 'pending',
    cloning: 'pending',
    ready: 'running',
    idle: 'running',
    running: 'running',
    archiving: 'stopped',
    archived: 'stopped',
    error: 'failed',
};

export interface BoatProviderOptions {
    apiUrl: string;
    apiKey: string;
    /** This installation's tag: list finds its hosts by it, destroy refuses any other. */
    installation: string;
    fetch?: typeof fetch;
    timeoutMs?: number;
}

type BoatSandbox = { id: string; state: string; labels?: Record<string, string>; error?: string | null; healthReason?: string | null };

export class BoatHostProvider implements HostProvider {
    readonly kind = 'boat' as const;
    private readonly fetchImpl: typeof fetch;

    constructor(private readonly opts: BoatProviderOptions) {
        this.fetchImpl = opts.fetch ?? fetch;
    }

    describe(cls: HostClass): HostClassFacts {
        if (cls.provider !== 'boat') throw new ProviderError('invalid_class', 'not_a_boat_class');
        return SIZES[cls.boat.type];
    }

    async quotas(cls: HostClass): Promise<ProviderQuotas | null> {
        if (cls.provider !== 'boat') return null;
        const l = await this.call<any>('GET', '/limits');
        const remaining = (w: string) => (typeof l?.starts?.[w]?.remaining === 'number' ? (l.starts[w].remaining as number) : null);
        const type = Array.isArray(l?.machineTypes) ? l.machineTypes.find((t: { type?: string }) => t?.type === cls.boat.type) : undefined;
        return {
            canStart: l?.canStart !== false,
            activeHosts: Number(l?.activeSandboxes ?? 0),
            maxActiveHosts: typeof l?.maxActiveSandboxes === 'number' ? l.maxActiveSandboxes : null,
            startsRemaining: { minute: remaining('minute'), hour: remaining('hour'), day: remaining('day') },
            classAvailable: type ? type.available !== false : true,
        };
    }

    async create(req: CreateHostRequest): Promise<ProviderHost> {
        if (req.cls.provider !== 'boat') throw new ProviderError('invalid_class', 'not_a_boat_class');
        const c = req.cls.boat;
        const body = {
            type: c.type,
            ...(req.from ? { from: req.from } : {}),
            noEnv: c.noEnv,
            // A Run host is never snapshotted (the class pins it false); only a template setup host is saved.
            snapshots: req.saveable === true ? true : c.snapshots,
            monitoring: c.monitoring,
            failFast: c.failFast,
            ttlSeconds: c.ttlSeconds,
            ...(c.org ? { org: c.org } : {}),
            name: `kodus-${req.hostId}`.slice(0, 120),
            labels: labelsOf(req.tags),
            // Written before boat reports ready; the cell's `register -bootstrap` reads and deletes it.
            files: [{ path: BOOTSTRAP_PATH, encoding: 'utf8', content: JSON.stringify({ hubUrl: req.bootstrap.hubUrl, hubCa: req.bootstrap.hubCa, token: req.bootstrap.token }) }],
        };
        const r = await this.call<{ sandbox: BoatSandbox }>('POST', '/sandboxes', body, { 'idempotency-key': req.clientToken });
        return hostOf(r.sandbox);
    }

    async get(providerId: string): Promise<ProviderHost | null> {
        const r = await this.call<{ sandbox: BoatSandbox }>('GET', `/sandboxes/${encodeURIComponent(providerId)}`, undefined, {}, { notFound: null });
        if (!r || r.sandbox.state === 'cancelled') return null;
        return hostOf(r.sandbox);
    }

    async list(tags: Pick<HostTags, 'installation'>): Promise<ProviderHost[]> {
        const out: ProviderHost[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 1000; page++) {
            const q = new URLSearchParams({ label: `${LABEL.installation}=${tags.installation}`, limit: '200' });
            if (cursor) q.set('cursor', cursor);
            const r: { sandboxes?: BoatSandbox[]; pageInfo?: { nextCursor?: string | null; hasMore?: boolean } } = await this.call('GET', `/sandboxes?${q.toString()}`);
            for (const s of r.sandboxes ?? []) if (s.state !== 'cancelled' && s.labels?.[LABEL.installation] === tags.installation) out.push(hostOf(s));
            cursor = r.pageInfo?.hasMore ? (r.pageInfo.nextCursor ?? null) : null;
            if (!cursor) return out;
        }
        throw new ProviderError('transient', 'list_too_long');
    }

    async destroy(providerId: string): Promise<void> {
        const host = await this.get(providerId);
        // Gone already, or not ours: nothing to do (never another installation's host).
        if (!host || host.tags.installation !== this.opts.installation) return;
        await this.call('DELETE', `/sandboxes/${encodeURIComponent(providerId)}`, undefined, { 'x-ascii-confirm-delete': providerId }, { notFound: null });
    }

    async extend(providerId: string, ttlSeconds: number): Promise<void> {
        await this.call('PATCH', `/sandboxes/${encodeURIComponent(providerId)}`, { ttlSeconds });
    }

    readonly images: HostImagePort = {
        save: async ({ providerId, name }): Promise<SavedImage> => {
            const r = await this.call<{ snapshot?: { name: string; status: string } }>('POST', '/saved-snapshots', { sandboxId: providerId, name });
            return imageOf(r.snapshot ?? { name, status: 'saving' });
        },
        get: async (name): Promise<SavedImage | null> => {
            const r = await this.call<{ snapshot?: { name: string; status: string; error?: string } }>('GET', `/saved-snapshots/${encodeURIComponent(name)}`, undefined, {}, { notFound: null });
            return r?.snapshot ? imageOf(r.snapshot) : null;
        },
        remove: async (name): Promise<void> => {
            await this.call('DELETE', `/saved-snapshots/${encodeURIComponent(name)}`, undefined, {}, { notFound: null });
        },
    };

    private async call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, opts: { notFound?: null } = {}): Promise<T> {
        let res: Response;
        try {
            res = await this.fetchImpl(`${this.opts.apiUrl}${path}`, {
                method,
                headers: { authorization: `Bearer ${this.opts.apiKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
                ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 30_000),
            });
        } catch (e) {
            throw transportError(e);
        }
        const text = await res.text().catch(() => '');
        let parsed: unknown = undefined;
        try {
            parsed = text ? JSON.parse(text) : {};
        } catch {
            parsed = undefined;
        }
        if (res.status === 404 && 'notFound' in opts) return null as T;
        if (res.status < 200 || res.status >= 300) throw mapBoatError(res.status, parsed, res.headers);
        if (parsed === undefined) throw new ProviderError('transient', 'bad_json', { status: res.status });
        return parsed as T;
    }
}

function labelsOf(t: HostTags): Record<string, string> {
    return { [LABEL.installation]: t.installation, [LABEL.pool]: t.pool, [LABEL.host]: t.host };
}

function hostOf(s: BoatSandbox): ProviderHost {
    const l = s.labels ?? {};
    const reason = s.state === 'error' ? 'error' : s.healthReason ? 'degraded' : undefined;
    return {
        providerId: s.id,
        state: STATES[s.state] ?? 'pending',
        tags: { ...(l[LABEL.installation] ? { installation: l[LABEL.installation] } : {}), ...(l[LABEL.pool] ? { pool: l[LABEL.pool] } : {}), ...(l[LABEL.host] ? { host: l[LABEL.host] } : {}) },
        ...(reason ? { reason } : {}),
    };
}

const imageOf = (s: { name: string; status: string }): SavedImage => ({ name: s.name, state: s.status === 'ready' ? 'ready' : s.status === 'failed' ? 'failed' : 'saving' });
