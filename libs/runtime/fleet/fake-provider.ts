import type { CreateHostRequest, HostImagePort, HostProvider, HostTags, ProviderHost, ProviderHostState, SavedImage } from './host-provider';
import type { HostClass } from './pool';

// The in-process provider (docs/runtime/host-providers.md §13 step 5): the
// conformance suite's reference, the fleet's specs, and a dev runtime-fleet
// with RUNTIME_FLEET_FAKE_PROVIDER=1, which the production image refuses.
// It makes no machine: a host is a row in memory.

type Op = 'create' | 'get' | 'list' | 'destroy' | 'extend';

/** A provider that keeps hosts in memory: idempotent by client token, pages its list, fails on demand. */
export class FakeHostProvider implements HostProvider {
    readonly kind = 'fake' as const;
    readonly hosts = new Map<string, ProviderHost & { clientToken: string; from?: string; bootstrap?: CreateHostRequest['bootstrap']; ttlSeconds?: number }>();
    readonly calls: Array<{ op: Op; id?: string }> = [];
    private readonly failures: Array<{ op: Op; error: Error }> = [];
    private seq = 0;
    readonly savedImages = new Map<string, SavedImage>();

    constructor(private readonly opts: { installation?: string; pageSize?: number; startState?: ProviderHostState } = {}) {}

    get installation() {
        return this.opts.installation ?? 'it-installation';
    }

    /** The next call of this operation throws `error` (once). */
    failNext(op: Op, error: Error) {
        this.failures.push({ op, error });
    }

    private maybeFail(op: Op) {
        const i = this.failures.findIndex((f) => f.op === op);
        if (i >= 0) throw this.failures.splice(i, 1)[0].error;
    }

    /** A host of another installation, which list must not return and destroy must not take. */
    addForeign(): string {
        const providerId = `fake-${++this.seq}`;
        this.hosts.set(providerId, { providerId, state: 'running', tags: { installation: 'someone-else', pool: 'x', host: 'x' }, clientToken: `foreign-${this.seq}` });
        return providerId;
    }

    /** Moves a host to a state, as the provider would (a boot finishing, a machine failing). */
    setState(providerId: string, state: ProviderHostState) {
        const h = this.hosts.get(providerId);
        if (h) h.state = state;
    }

    describe(_cls: HostClass) {
        return { vcpu: 8, memoryMb: 16_384, diskGb: 111, usdPerHour: 0.072 };
    }

    async quotas() {
        return { canStart: true, activeHosts: [...this.hosts.values()].filter((h) => h.state !== 'gone').length, maxActiveHosts: null, startsRemaining: { minute: null, hour: null, day: null }, classAvailable: true };
    }

    async create(req: CreateHostRequest): Promise<ProviderHost> {
        this.calls.push({ op: 'create', id: req.hostId });
        this.maybeFail('create');
        for (const h of this.hosts.values()) if (h.clientToken === req.clientToken) return view(h);
        const providerId = `fake-${++this.seq}`;
        const host = { providerId, state: this.opts.startState ?? 'pending', tags: { ...req.tags }, clientToken: req.clientToken, from: req.from, bootstrap: req.bootstrap };
        this.hosts.set(providerId, host);
        return view(host);
    }

    async get(providerId: string) {
        this.calls.push({ op: 'get', id: providerId });
        this.maybeFail('get');
        const h = this.hosts.get(providerId);
        return h && h.state !== 'gone' ? view(h) : null;
    }

    async list(tags: Pick<HostTags, 'installation'>) {
        this.calls.push({ op: 'list' });
        this.maybeFail('list');
        // Pages as a real provider does; the adapter contract is every page.
        const all = [...this.hosts.values()].filter((h) => h.state !== 'gone' && h.tags.installation === tags.installation);
        const out: ProviderHost[] = [];
        for (let i = 0; i < all.length; i += this.opts.pageSize ?? 100) out.push(...all.slice(i, i + (this.opts.pageSize ?? 100)).map(view));
        return out;
    }

    async destroy(providerId: string) {
        this.calls.push({ op: 'destroy', id: providerId });
        this.maybeFail('destroy');
        const h = this.hosts.get(providerId);
        if (!h || h.state === 'gone') return;
        if (h.tags.installation !== this.installation) return;
        h.state = 'gone';
    }

    async extend(providerId: string, ttlSeconds: number) {
        this.calls.push({ op: 'extend', id: providerId });
        this.maybeFail('extend');
        const h = this.hosts.get(providerId);
        if (h) h.ttlSeconds = ttlSeconds;
    }

    readonly images: HostImagePort = {
        save: async ({ name }) => {
            const img: SavedImage = { name, state: 'ready' };
            this.savedImages.set(name, img);
            return img;
        },
        get: async (name) => this.savedImages.get(name) ?? null,
        remove: async (name) => void this.savedImages.delete(name),
    };
}

const view = (h: ProviderHost): ProviderHost => ({ providerId: h.providerId, state: h.state, tags: { ...h.tags }, ...(h.reason ? { reason: h.reason } : {}) });

