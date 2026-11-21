import type { HostClass, ProviderKind } from './pool';

// The host provider port (docs/runtime/host-providers.md §4.2): the Cluster
// API infrastructure contract cut to what a host needs. An adapter lives in
// apps/runtime/src/fleet/providers/<kind>/; only runtime-fleet holds one.
// Every adapter passes describeHostProviderConformance (./testing.ts).

/** Tags every host carries: `list` finds this installation's hosts by `installation`, the orphan pass by all three. */
export interface HostTags {
    installation: string;
    pool: string;
    host: string;
}

/** What a new host needs to enroll, and nothing else: the token is single use and dead once the cell registered. */
export interface BootstrapPayload {
    hubUrl: string;
    /** PEM of the CA that signs the hub's TLS certificate. */
    hubCa: string;
    /** A kcf_ fleet token (libs/runtime/contracts/fleet-token.ts). */
    token: string;
}

/** Where the cell reads its bootstrap and deletes it (cmd/cell register -bootstrap); /tmp is never in a saved snapshot. */
export const BOOTSTRAP_PATH = '/tmp/kodus-enroll.json';

export interface CreateHostRequest {
    hostId: string;
    /** Idempotency: a retry with the same token returns the same host and never bills a second one. */
    clientToken: string;
    cls: HostClass;
    /** The image or template the host boots from (a boat saved snapshot name); absent: the class's base. */
    from?: string;
    bootstrap: BootstrapPayload;
    tags: HostTags;
}

export type ProviderHostState = 'pending' | 'running' | 'stopped' | 'gone' | 'failed';

export interface ProviderHost {
    providerId: string;
    state: ProviderHostState;
    tags: Partial<HostTags>;
    /** The provider's reason when failed or degraded (boat `error`, `healthReason`): logs only. */
    reason?: string;
}

export interface HostClassFacts {
    vcpu: number;
    memoryMb: number;
    diskGb: number;
    usdPerHour: number;
}

/** What the account may still do now; null fields are unlimited. */
export interface ProviderQuotas {
    canStart: boolean;
    activeHosts: number;
    maxActiveHosts: number | null;
    startsRemaining: { minute: number | null; hour: number | null; day: number | null };
    /** The class's size is not available on the account's plan (boat `machineTypes[].available`). */
    classAvailable: boolean;
}

/** A frozen host disk saved under a name (boat saved snapshots): the environment template (§8.2). */
export interface SavedImage {
    name: string;
    state: 'saving' | 'ready' | 'failed';
    reason?: string;
}

/** Optional: a provider that saves a host as a named image. */
export interface HostImagePort {
    save(req: { providerId: string; name: string }): Promise<SavedImage>;
    get(name: string): Promise<SavedImage | null>;
    /** Idempotent: an image already gone is success. */
    remove(name: string): Promise<void>;
}

export interface HostProvider {
    readonly kind: ProviderKind;
    /** What hosts of this class can do and cost, from the class alone. */
    describe(cls: HostClass): HostClassFacts;
    quotas(cls: HostClass): Promise<ProviderQuotas | null>;
    create(req: CreateHostRequest): Promise<ProviderHost>;
    /** null: the provider does not know the host (gone). */
    get(providerId: string): Promise<ProviderHost | null>;
    /** Every host carrying this installation's tag, all pages. */
    list(tags: Pick<HostTags, 'installation'>): Promise<ProviderHost[]>;
    /** Idempotent: a host already gone is success. Never takes a host without this installation's tag. */
    destroy(providerId: string): Promise<void>;
    /** Optional: push the host's dead-man deadline to now + ttlSeconds (boat ttlSeconds). */
    extend?(providerId: string, ttlSeconds: number): Promise<void>;
    /** Optional: named images of a host (the template step). */
    readonly images?: HostImagePort;
}
