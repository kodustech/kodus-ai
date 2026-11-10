import { LockScopedPg } from '../persistence/lock-scoped-pg';
import type { Pool, PoolClient } from 'pg';

export const PR_ADMISSION_STORE = Symbol('PR_ADMISSION_STORE');
export interface PrScope {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
}
export interface RunDeliveryContext {
    messageId?: string;
    redelivered: boolean;
}
export type PrAdmissionDecision =
    | { accepted: true }
    | {
          accepted: false;
          reason: 'superseded' | 'cancelled' | 'unknown_redelivery';
      };
/** Called under the cluster-wide PR lock. No payload, token or wall-clock ordering is stored. */
export interface PrAdmissionStore {
    register(
        scope: PrScope,
        runId: string,
        headSha: string,
        redelivered: boolean,
    ): Promise<PrAdmissionDecision>;
    current(scope: PrScope, runId: string): Promise<PrAdmissionDecision>;
    cancel(
        scope: PrScope,
        commandId: string,
        keepHead?: string,
        redelivered?: boolean,
    ): Promise<string>;
    canCancel(scope: PrScope, runId: string, ceiling: string): Promise<boolean>;
}
interface Fence {
    generation: bigint;
    head: string | null;
}
interface Registration extends PrScope {
    generation: bigint;
    head: string;
}
function conflict(): never {
    throw Object.assign(new Error('pr_admission_conflict'), {
        code: 'admission_conflict',
    });
}
function same(a: PrScope, b: PrScope) {
    return (
        a.organizationId === b.organizationId &&
        a.repositoryId === b.repositoryId &&
        a.prNumber === b.prNumber
    );
}
function decision(fence: Fence, generation: bigint): PrAdmissionDecision {
    return fence.generation === generation && fence.head !== null
        ? { accepted: true }
        : {
              accepted: false,
              reason: fence.head === null ? 'cancelled' : 'superseded',
          };
}
const scopeKey = (s: PrScope) =>
    JSON.stringify([s.organizationId, s.repositoryId, s.prNumber]);
const identityKey = (s: PrScope, id: string) =>
    JSON.stringify([s.organizationId, id]);

/** Explicit test/local adapter; never the production DI default. */
export class InMemoryPrAdmissionStore implements PrAdmissionStore {
    private readonly fences = new Map<string, Fence>();
    private readonly runs = new Map<string, Registration>();
    private readonly cancellations = new Map<
        string,
        PrScope & { ceiling: string; keepHead?: string }
    >();
    async register(
        scope: PrScope,
        runId: string,
        head: string,
        redelivered: boolean,
    ): Promise<PrAdmissionDecision> {
        const key = scopeKey(scope);
        const fence = this.fences.get(key);
        const known = this.runs.get(identityKey(scope, runId));
        if (known) {
            if (!same(scope, known) || known.head !== head) conflict();
            return decision(fence!, known.generation);
        }
        if (redelivered && fence)
            return { accepted: false, reason: 'unknown_redelivery' };
        const next =
            !fence || fence.head !== head
                ? { generation: (fence?.generation ?? 0n) + 1n, head }
                : fence;
        this.fences.set(key, next);
        this.runs.set(identityKey(scope, runId), {
            ...scope,
            generation: next.generation,
            head,
        });
        return { accepted: true };
    }
    async current(scope: PrScope, runId: string): Promise<PrAdmissionDecision> {
        const known = this.runs.get(identityKey(scope, runId));
        if (!known || !same(scope, known)) conflict();
        return decision(this.fences.get(scopeKey(scope))!, known.generation);
    }
    async cancel(
        scope: PrScope,
        commandId: string,
        keepHead?: string,
        redelivered?: boolean,
    ): Promise<string> {
        const id = identityKey(scope, commandId);
        const known = this.cancellations.get(id);
        if (known) {
            if (!same(scope, known) || known.keepHead !== keepHead) conflict();
            return known.ceiling;
        }
        const key = scopeKey(scope),
            fence = this.fences.get(key);
        if (redelivered && fence) conflict();
        const retainsCurrent =
            keepHead !== undefined && fence?.head === keepHead;
        const ceiling = (
            retainsCurrent ? fence!.generation - 1n : (fence?.generation ?? 0n)
        ).toString();
        if (!retainsCurrent)
            this.fences.set(key, {
                generation: (fence?.generation ?? 0n) + 1n,
                head: keepHead ?? null,
            });
        this.cancellations.set(id, { ...scope, ceiling, keepHead });
        return ceiling;
    }
    async canCancel(
        scope: PrScope,
        runId: string,
        ceiling: string,
    ): Promise<boolean> {
        const known = this.runs.get(identityKey(scope, runId));
        return (
            !known ||
            (same(scope, known) && known.generation <= BigInt(ceiling))
        );
    }
}

export class PgPrAdmissionStore implements PrAdmissionStore {
    constructor(
        pool: Pool,
        private readonly sql = new LockScopedPg(pool),
    ) {}
    private async transaction<T>(
        scope: PrScope,
        fn: (client: PoolClient, fence: Fence) => Promise<T>,
    ): Promise<T> {
        return this.sql.transaction(async (client) => {
            await client.query(
                `INSERT INTO runtime.runtime_pr_fences (organization_id,repository_id,pr_number,generation) VALUES ($1,$2,$3,0) ON CONFLICT DO NOTHING`,
                [scope.organizationId, scope.repositoryId, scope.prNumber],
            );
            const row = (
                await client.query(
                    `SELECT generation,head_sha FROM runtime.runtime_pr_fences WHERE organization_id=$1 AND repository_id=$2 AND pr_number=$3 FOR UPDATE`,
                    [scope.organizationId, scope.repositoryId, scope.prNumber],
                )
            ).rows[0];
            const result = await fn(client, {
                generation: BigInt(row.generation),
                head: row.head_sha,
            });
            return result;
        });
    }
    private async run(
        client: Pick<Pool, 'query'>,
        scope: PrScope,
        runId: string,
    ): Promise<Registration | undefined> {
        const row = (
            await client.query(
                `SELECT repository_id,pr_number,generation,head_sha FROM runtime.runtime_pr_run_generations WHERE organization_id=$1 AND run_id=$2`,
                [scope.organizationId, runId],
            )
        ).rows[0];
        return row
            ? {
                  organizationId: scope.organizationId,
                  repositoryId: row.repository_id,
                  prNumber: row.pr_number,
                  generation: BigInt(row.generation),
                  head: row.head_sha,
              }
            : undefined;
    }
    async register(
        scope: PrScope,
        runId: string,
        head: string,
        redelivered: boolean,
    ): Promise<PrAdmissionDecision> {
        return this.transaction(scope, async (client, fence) => {
            const known = await this.run(client, scope, runId);
            if (known) {
                if (!same(scope, known) || known.head !== head) conflict();
                return decision(fence, known.generation);
            }
            if (redelivered && fence.generation > 0n)
                return { accepted: false, reason: 'unknown_redelivery' };
            const generation =
                fence.generation === 0n || fence.head !== head
                    ? fence.generation + 1n
                    : fence.generation;
            await client.query(
                `UPDATE runtime.runtime_pr_fences SET generation=$4,head_sha=$5 WHERE organization_id=$1 AND repository_id=$2 AND pr_number=$3`,
                [
                    scope.organizationId,
                    scope.repositoryId,
                    scope.prNumber,
                    generation.toString(),
                    head,
                ],
            );
            await client.query(
                `INSERT INTO runtime.runtime_pr_run_generations (organization_id,run_id,repository_id,pr_number,generation,head_sha) VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                    scope.organizationId,
                    runId,
                    scope.repositoryId,
                    scope.prNumber,
                    generation.toString(),
                    head,
                ],
            );
            return { accepted: true };
        });
    }
    async current(scope: PrScope, runId: string): Promise<PrAdmissionDecision> {
        const row = (
            await this.sql.query(
                `SELECT f.generation,f.head_sha,r.generation AS run_generation
            FROM runtime.runtime_pr_run_generations r JOIN runtime.runtime_pr_fences f
              ON f.organization_id=r.organization_id AND f.repository_id=r.repository_id AND f.pr_number=r.pr_number
            WHERE r.organization_id=$1 AND r.repository_id=$2 AND r.pr_number=$3 AND r.run_id=$4`,
                [
                    scope.organizationId,
                    scope.repositoryId,
                    scope.prNumber,
                    runId,
                ],
            )
        ).rows[0];
        if (!row) conflict();
        return decision(
            { generation: BigInt(row.generation), head: row.head_sha },
            BigInt(row.run_generation),
        );
    }
    async cancel(
        scope: PrScope,
        commandId: string,
        keepHead?: string,
        redelivered?: boolean,
    ): Promise<string> {
        return this.transaction(scope, async (client, fence) => {
            const known = (
                await client.query(
                    `SELECT repository_id,pr_number,ceiling,keep_head FROM runtime.runtime_pr_cancel_generations WHERE organization_id=$1 AND command_id=$2`,
                    [scope.organizationId, commandId],
                )
            ).rows[0];
            if (known) {
                if (
                    known.repository_id !== scope.repositoryId ||
                    known.pr_number !== scope.prNumber ||
                    (known.keep_head ?? undefined) !== keepHead
                )
                    conflict();
                return known.ceiling;
            }
            if (redelivered && fence.generation > 0n) conflict();
            const retainsCurrent =
                keepHead !== undefined && fence.head === keepHead;
            const ceiling = (
                retainsCurrent ? fence.generation - 1n : fence.generation
            ).toString();
            if (!retainsCurrent)
                await client.query(
                    `UPDATE runtime.runtime_pr_fences SET generation=$4,head_sha=$5 WHERE organization_id=$1 AND repository_id=$2 AND pr_number=$3`,
                    [
                        scope.organizationId,
                        scope.repositoryId,
                        scope.prNumber,
                        (fence.generation + 1n).toString(),
                        keepHead ?? null,
                    ],
                );
            await client.query(
                `INSERT INTO runtime.runtime_pr_cancel_generations (organization_id,command_id,repository_id,pr_number,ceiling,keep_head) VALUES ($1,$2,$3,$4,$5,$6)`,
                [
                    scope.organizationId,
                    commandId,
                    scope.repositoryId,
                    scope.prNumber,
                    ceiling,
                    keepHead ?? null,
                ],
            );
            return ceiling;
        });
    }
    async canCancel(
        scope: PrScope,
        runId: string,
        ceiling: string,
    ): Promise<boolean> {
        const known = await this.run(this.sql, scope, runId);
        return (
            !known ||
            (same(scope, known) && known.generation <= BigInt(ceiling))
        );
    }
}
