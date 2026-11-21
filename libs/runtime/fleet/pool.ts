import { createHash } from 'crypto';

import { z } from 'zod';

// Host pools and host classes (docs/runtime/host-providers.md §5.1). A pool is
// what placement and the controller read; its class is what only the provider
// reads. A stored pool carries its class resolved (runtime-fleet `apply`), so
// one row says everything about the hosts it makes.

export const PROVIDER_KINDS = ['static', 'fake', 'boat', 'aws', 'baremetal'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/**
 * perRun: one host per Run, created when the Run asks for room and deleted when it is done (the boat profile).
 * pooled: long-lived hosts shared by Runs (static pools today; warm and consolidation later, not built).
 */
export const POOL_LIFECYCLES = ['perRun', 'pooled'] as const;
export const PoolLifecycleSchema = z.enum(POOL_LIFECYCLES);
export type PoolLifecycle = z.infer<typeof PoolLifecycleSchema>;

const Slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'a lowercase slug of at most 63 characters');
const Scope = z.union([z.literal('kodus'), z.string().regex(/^org:[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/, 'org:<organizationId>')]);
const LabelValue = z.string().min(1).max(64);

/** Labels from a closed set: what placement and residency match on. */
export const PoolLabelsSchema = z.strictObject({
    region: LabelValue.optional(),
    residency: z.enum(['eu', 'us', 'any']).optional(),
    kvm: z.enum(['true', 'false']).optional(),
    backend: z.enum(['microvm', 'docker-gvisor', 'any']).optional(),
    isolation: z.enum(['vm', 'microvm', 'sandboxed-container']).optional(),
    arch: z.enum(['x86_64', 'arm64']).optional(),
    tenancy: z.enum(['run', 'org', 'shared']).optional(),
    cost: z.enum(['low', 'medium', 'high']).optional(),
});

/** boat's create options for a Run host (docs.boat.dev create-sandbox). `from` is the environment's template, never the class's. */
export const BoatClassSchema = z.strictObject({
    type: z.enum(['small', 'default', 'large', 'xlarge']).default('large'),
    noEnv: z.literal(true).default(true),
    snapshots: z.literal(false).default(false),
    monitoring: z.boolean().default(false),
    failFast: z.boolean().default(true),
    ttlSeconds: z.number().int().min(600).max(86_400).default(7200),
    /** The boat organization (wallet) the hosts are billed to. */
    org: z.string().min(1).max(128).optional(),
    /**
     * The cell base (§8.2): the saved snapshot of a cell release on boat's image, never enrolled, that a Run host
     * starts from when its environment has no template of its own. Org-neutral by construction, so never an
     * environment template (kodus-env-…): one org's baked data would boot every org's hosts.
     */
    base: z
        .string()
        .regex(/^kodus-cell-[a-z0-9][a-z0-9-]{0,51}$/, 'a cell base is a kodus-cell-<release>-<backend> saved snapshot of at most 63 characters, never an environment template')
        .optional(),
});

const ClassBase = { kind: z.literal('HostClass'), name: Slug };
export const HostClassSchema = z.discriminatedUnion('provider', [
    z.strictObject({ ...ClassBase, provider: z.literal('static') }),
    z.strictObject({ ...ClassBase, provider: z.literal('fake'), fake: z.strictObject({ memoryMb: z.number().int().positive().default(16_384) }).default({ memoryMb: 16_384 }) }),
    z.strictObject({ ...ClassBase, provider: z.literal('boat'), boat: BoatClassSchema }),
    // Shapes kept for the adapters to come (§9.3, §9.4); the controller refuses a pool of them until they exist.
    z.strictObject({ ...ClassBase, provider: z.literal('aws'), aws: z.record(z.string(), z.unknown()) }),
    z.strictObject({ ...ClassBase, provider: z.literal('baremetal'), baremetal: z.record(z.string(), z.unknown()) }),
]);
export type HostClass = z.infer<typeof HostClassSchema>;

/** What a Run host of this class starts from when its environment has no template: the class's cell base. */
export const cellBaseOf = (cls: HostClass): string | undefined => (cls.provider === 'boat' ? cls.boat.base : undefined);

const Capacity = z
    .strictObject({ min: z.number().int().min(0), max: z.number().int().min(0).max(1000), warm: z.number().int().min(0).default(0), stopped: z.number().int().min(0).default(0) })
    .refine((c) => c.min <= c.max, 'capacity.min must be at most capacity.max');

export const HostPoolSchema = z
    .strictObject({
        kind: z.literal('HostPool'),
        name: Slug,
        scope: Scope,
        provider: z.enum(PROVIDER_KINDS),
        lifecycle: PoolLifecycleSchema,
        hostClass: HostClassSchema,
        labels: PoolLabelsSchema.default({}),
        weight: z.number().int().min(0).max(1000).default(0),
        /** Only these orgs may place claims on the pool (a pool being trusted, or one that needs legal sign-off). Absent: every org the scope admits. */
        admission: z.strictObject({ allowOrgs: z.array(z.string().min(1).max(128)).min(1).max(1000) }).optional(),
        perRun: z
            .strictObject({
                registrationTimeoutSeconds: z.number().int().min(60).max(3600).default(600),
                maxRunMinutes: z.number().int().min(5).max(24 * 60).default(120),
            })
            .default({ registrationTimeoutSeconds: 600, maxRunMinutes: 120 }),
        health: z.strictObject({ maxConsecutiveFailures: z.number().int().min(1).max(100).default(3) }).default({ maxConsecutiveFailures: 3 }),
        /** pooled only; required for a pooled pool that a controller drives. */
        capacity: Capacity.optional(),
        price: z.strictObject({ usdPerHostHour: z.number().min(0).max(100), source: z.enum(['list', 'contract', 'org']) }).optional(),
    })
    .superRefine((p, ctx) => {
        if (p.hostClass.provider !== p.provider) ctx.addIssue({ code: 'custom', path: ['hostClass', 'provider'], message: `the class's provider (${p.hostClass.provider}) is not the pool's (${p.provider})` });
        if (p.lifecycle === 'pooled' && p.provider !== 'static' && !p.capacity) ctx.addIssue({ code: 'custom', path: ['capacity'], message: 'a pooled pool a controller drives needs capacity' });
        if (p.lifecycle === 'perRun' && p.provider === 'static') ctx.addIssue({ code: 'custom', path: ['lifecycle'], message: 'a static pool cannot create a host per Run' });
    });
export type HostPool = z.infer<typeof HostPoolSchema>;

export const parseHostPool = (input: unknown): HostPool => HostPoolSchema.parse(input);

/** The pool's id: its name for a Kodus pool, `org:<id>/<name>` for an org's. */
export const poolIdOf = (p: Pick<HostPool, 'scope' | 'name'>): string => (p.scope === 'kodus' ? p.name : `${p.scope}/${p.name}`);

/** The static pool every org's hand-registered cells fall into (the hub creates it at the first registration). */
export const orgDefaultPoolId = (organizationId: string) => `org:${organizationId}/default`;
/** The static pool of Kodus-owned cells from RUNTIME_MANAGED_CELLS. */
export const KODUS_STATIC_POOL_ID = 'kodus-static';

/** Whether runtime-fleet creates and destroys this pool's hosts (static pools are registered by hand). */
export const isControlled = (p: Pick<HostPool, 'provider'>): boolean => p.provider !== 'static';

/**
 * The hash of what shapes a host: provider, class and lifecycle. Weight, admission, labels and limits change where
 * Runs go, not what a host is, so they never make a host stale (Karpenter's drift hash).
 */
export function poolSpecHash(p: HostPool): string {
    return createHash('sha256').update(stableJson({ provider: p.provider, lifecycle: p.lifecycle, hostClass: p.hostClass })).digest('hex').slice(0, 16);
}

function stableJson(v: unknown): string {
    if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
    if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(',')}}`;
    return JSON.stringify(v);
}
