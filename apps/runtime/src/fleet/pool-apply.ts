import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';

import { cellBaseOf, HostClassSchema, HostPoolSchema, poolIdOf, poolSpecHash, type HostClass, type HostPool } from '@libs/runtime/fleet/pool';

// `runtime-fleet apply` (docs/runtime/host-providers.md §5.2): the pool files of the infra repository become
// runtime_host_pools rows, each with its class resolved inline and its spec hash. A file set is applied whole or
// not at all. Apply writes the spec, the hash and the weight; it never touches a pool's status (the reconcile
// loop's), its cordon or its hosts, and it never deletes a pool a file no longer names.

export interface PoolDocument {
    /** Where the document came from (`<file>#<n>`), for the errors. */
    source: string;
    doc: unknown;
}

export interface AppliedPool {
    poolId: string;
    pool: HostPool;
    specHash: string;
}

export type PoolApplyOutcome = { poolId: string; action: 'created' | 'updated' | 'unchanged'; specHash: string };

/** Writes resolved pools; one transaction for the whole set. */
export interface PoolSpecWriter {
    apply(pools: AppliedPool[]): Promise<PoolApplyOutcome[]>;
    close?(): Promise<void>;
}

/** Providers runtime-fleet has an adapter for (§9); a pool of any other kind waits for its adapter. */
const ADAPTED = new Set(['static', 'fake', 'boat']);

/** zod issues as `path: message`, never the value: a key pasted into a pool file by mistake stays out of the log. */
const issuesOf = (e: z.ZodError) => e.issues.map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}`);

export function resolvePoolDocuments(docs: PoolDocument[], opts: { allowFake: boolean }): { ok: true; pools: AppliedPool[] } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    const classes = new Map<string, HostClass>();
    const kindOf = (d: unknown) => (d && typeof d === 'object' && !Array.isArray(d) ? (d as { kind?: unknown }).kind : undefined);

    for (const { source, doc } of docs) {
        if (kindOf(doc) !== 'HostClass') continue;
        const parsed = HostClassSchema.safeParse(doc);
        if (!parsed.success) errors.push(...issuesOf(parsed.error).map((m) => `${source}: ${m}`));
        else if (classes.has(parsed.data.name)) errors.push(`${source}: the class ${parsed.data.name} is defined more than once`);
        else classes.set(parsed.data.name, parsed.data);
    }

    const pools: AppliedPool[] = [];
    for (const { source, doc } of docs) {
        const kind = kindOf(doc);
        if (kind === 'HostClass') continue;
        if (kind !== 'HostPool') {
            errors.push(`${source}: kind must be HostPool or HostClass`);
            continue;
        }
        const raw = doc as Record<string, unknown>;
        let input = raw;
        if (typeof raw.hostClass === 'string') {
            const cls = classes.get(raw.hostClass);
            if (!cls) {
                errors.push(`${source}: hostClass ${raw.hostClass} is not defined in these files`);
                continue;
            }
            input = { ...raw, hostClass: cls };
        }
        const parsed = HostPoolSchema.safeParse(input);
        if (!parsed.success) {
            errors.push(...issuesOf(parsed.error).map((m) => `${source}: ${m}`));
            continue;
        }
        const pool = parsed.data;
        const poolId = poolIdOf(pool);
        const refuse = (why: string) => errors.push(`${source}: ${poolId}: ${why}`);
        if (!ADAPTED.has(pool.provider)) refuse(`no adapter for ${pool.provider} yet`);
        else if (pool.provider === 'fake' && !opts.allowFake) refuse('a fake pool is for dev only (RUNTIME_FLEET_FAKE_PROVIDER=1 outside the production image)');
        else if (pool.provider === 'boat' && !pool.admission) refuse('a boat pool needs admission.allowOrgs: customer data at rest in boat waits for legal sign-off');
        else if (pool.provider === 'boat' && !cellBaseOf(pool.hostClass)) refuse('a boat class needs boat.base, the cell base its Run hosts start from');
        else if (pools.some((p) => p.poolId === poolId)) refuse('the pool is defined more than once');
        else pools.push({ poolId, pool, specHash: poolSpecHash(pool) });
    }

    if (errors.length) return { ok: false, errors };
    if (!pools.length) return { ok: false, errors: ['no HostPool in these files'] };
    return { ok: true, pools };
}

/** An apply the database refused as a whole: nothing of the file set was written. */
export class PoolApplyRefused extends Error {
    constructor(readonly reasons: string[]) {
        super(`apply refused: ${reasons.join('; ')}`);
        this.name = 'PoolApplyRefused';
    }
}

export class PgPoolSpecWriter implements PoolSpecWriter {
    constructor(private readonly db: Pick<Pool, 'connect'> & Partial<Pick<Pool, 'end'>>) {}

    async apply(pools: AppliedPool[]): Promise<PoolApplyOutcome[]> {
        const c: PoolClient = await this.db.connect();
        try {
            await c.query('BEGIN');
            const out: PoolApplyOutcome[] = [];
            const refused: string[] = [];
            for (const p of pools) {
                const spec = JSON.stringify(p.pool);
                const prev = (await c.query(`SELECT provider, lifecycle, spec = $2::jsonb AND weight = $3 AS same FROM runtime.runtime_host_pools WHERE pool_id = $1 FOR UPDATE`, [p.poolId, spec, p.pool.weight])).rows[0];
                // A pool's id is its identity: hosts, cells and demand point at it. Another provider is another pool.
                if (prev && prev.provider !== p.pool.provider) {
                    refused.push(`${p.poolId} is a ${prev.provider} pool; a ${p.pool.provider} pool needs another name`);
                    continue;
                }
                if (prev?.same) {
                    out.push({ poolId: p.poolId, action: 'unchanged', specHash: p.specHash });
                    continue;
                }
                const org = p.pool.scope === 'kodus' ? null : p.pool.scope.slice('org:'.length);
                await c.query(
                    `INSERT INTO runtime.runtime_host_pools (pool_id, scope, organization_id, provider, lifecycle, spec, spec_hash, weight)
                     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                     ON CONFLICT (pool_id) DO UPDATE SET lifecycle = EXCLUDED.lifecycle, spec = EXCLUDED.spec, spec_hash = EXCLUDED.spec_hash, weight = EXCLUDED.weight, updated_at = now()`,
                    [p.poolId, p.pool.scope, org, p.pool.provider, p.pool.lifecycle, spec, p.specHash, p.pool.weight],
                );
                out.push({ poolId: p.poolId, action: prev ? 'updated' : 'created', specHash: p.specHash });
            }
            if (refused.length) throw new PoolApplyRefused(refused);
            await c.query('COMMIT');
            return out;
        } catch (e) {
            await c.query('ROLLBACK').catch(() => undefined);
            throw e;
        } finally {
            c.release();
        }
    }

    async close() {
        await this.db.end?.();
    }
}
