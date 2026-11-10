import { randomUUID } from 'crypto';

import { Pool } from 'pg';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';

import { shopRunRequest } from '../../e2e/fixtures';
import type {
    AdmissionIdentity,
    AdmissionLease,
    AdmissionLimits,
    AdmissionPayload,
    AdmissionRecord,
    AdmissionRef,
    PhysicalAdmissionTicket,
} from './admission-contract';
import { PgAdmissionStore } from './pg-admission-store';
import { applyRetention, ensureRuntimeSchema } from '../persistence/runtime-schema';

const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';
const limits: AdmissionLimits = {
    globalWaiting: 50,
    perOrgWaiting: 30,
    globalExecuting: 3,
    perOrgExecuting: 2,
    maxAttempts: 3,
};
const ref = (payload: AdmissionPayload): AdmissionRef => ({
    organizationId: payload.request.organizationId,
    kind: payload.kind,
    key: payload.kind === 'run' ? payload.request.runId : payload.request.key,
});
const identity = (row: AdmissionRecord): AdmissionIdentity => ({
    organizationId: row.organizationId,
    kind: row.kind,
    key: row.key,
    generation: row.generation,
    ticketOwnerToken: row.ticketOwnerToken,
});
const ticket = (row: AdmissionRecord): PhysicalAdmissionTicket => ({
    ...identity(row),
    ticketId: randomUUID(),
    cellId: 'cell-admission-it',
    sessionEpoch: randomUUID(),
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
    members: [
        {
            side: row.kind === 'setup' ? 'setup' : 'base',
            idempotencyKey: row.key,
            claimId: randomUUID(),
        },
    ],
});

(skip ? describe.skip : describe)(
    'Pg admission across replicas (real isolated PostgreSQL)',
    () => {
        let pool: Pool;
        let a: PgAdmissionStore;
        let b: PgAdmissionStore;
        let org: string;
        const orgs: string[] = [];
        const ownOrg = () => {
            const id = `admission-it-${randomUUID()}`;
            orgs.push(id);
            return id;
        };
        const run = (organizationId = org): AdmissionPayload => ({
            kind: 'run',
            request: {
                ...shopRunRequest(),
                organizationId,
                requestedAt: new Date().toISOString(),
            },
        });
        const setup = (): AdmissionPayload => {
            const request: RuntimeEnvironmentSetupRequested = {
                key: randomUUID(),
                organizationId: org,
                environmentId: `env-${randomUUID()}`,
                teamId: 't',
                repositoryId: 'r',
                repositoryName: 'acme/shop',
                requestedAt: new Date().toISOString(),
                requestedBy: { userId: 'u' },
            };
            return { kind: 'setup', request };
        };
        const row = async (input: AdmissionPayload) => {
            const result = await a.accept(input, limits);
            if (!('record' in result)) throw new Error(result.status);
            return result.record;
        };
        const take = async (
            input: AdmissionPayload,
        ): Promise<AdmissionLease> => {
            const accepted = await row(input);
            const result = await a.take(
                ref(input),
                accepted.generation,
                30_000,
            );
            if (result.status !== 'taken') throw new Error(result.status);
            return result.lease;
        };

        beforeAll(async () => {
            pool = new Pool({ connectionString: url, max: 8 });
            await ensureRuntimeSchema(pool);
            a = new PgAdmissionStore(pool);
            b = new PgAdmissionStore(pool);
        });
        beforeEach(() => {
            org = ownOrg();
        });
        afterEach(async () => {
            await pool.query(
                'DELETE FROM runtime.runtime_claims WHERE org_id=ANY($1::text[])',
                [orgs],
            );
            await pool.query(
                'DELETE FROM runtime.runtime_admission_requests WHERE org_id=ANY($1::text[])',
                [orgs],
            );
        });
        afterAll(async () => pool?.end());

        it('atomically bounds global and tenant ingress under concurrent writers', async () => {
            const results = await Promise.all(
                Array.from({ length: 16 }, (_, i) =>
                    (i % 2 ? a : b).accept(run(), {
                        ...limits,
                        perOrgWaiting: 2,
                    }),
                ),
            );
            expect(
                results.filter((result) => result.status === 'accepted'),
            ).toHaveLength(2);
            expect(
                results.filter((result) => result.status === 'backlog_full'),
            ).toHaveLength(14);
            expect(
                (
                    await pool.query(
                        'SELECT count(*)::int AS n FROM runtime.runtime_admission_requests WHERE org_id=$1',
                        [org],
                    )
                ).rows[0].n,
            ).toBe(2);
            await pool.query(
                'DELETE FROM runtime.runtime_admission_requests WHERE org_id=$1',
                [org],
            );
            const baseline = (
                await pool.query(
                    "SELECT count(*)::int AS n FROM runtime.runtime_admission_requests WHERE NOT permit_held AND (state IN ('awaiting_approval','waiting','owned') OR ticket IS NOT NULL)",
                )
            ).rows[0].n;
            const global = await Promise.all(
                Array.from({ length: 16 }, (_, i) =>
                    (i % 2 ? a : b).accept(run(ownOrg()), {
                        ...limits,
                        globalWaiting: baseline + 3,
                    }),
                ),
            );
            expect(
                global.filter((result) => result.status === 'accepted'),
            ).toHaveLength(3);
        });

        it('enforces byte budgets after sealed normalization and never reflects invalid input', async () => {
            const input = run();
            const first = await row(input);
            const rejected = await Promise.all(
                Array.from({ length: 6 }, (_, i) =>
                    (i % 2 ? a : b).accept(run(ownOrg()), {
                        ...limits,
                        globalBacklogBytes: first.payloadBytes,
                    }),
                ),
            );
            expect(rejected).toEqual(Array(6).fill({ status: 'backlog_full' }));
            expect(
                await a.accept(run(), { ...limits, maxPayloadBytes: 1 }),
            ).toEqual({ status: 'payload_too_large' });
            const secret = structuredClone(input);
            secret.request.repoToken = 'SECRET_NOT_SEALED';
            await expect(a.accept(secret, limits)).rejects.toThrow(
                /^invalid admission input$/,
            );
            expect(
                (
                    await pool.query(
                        'SELECT count(*)::int AS n FROM runtime.runtime_admission_requests WHERE org_id=ANY($1::text[])',
                        [orgs],
                    )
                ).rows[0].n,
            ).toBe(1);
        });

        it('shares Run/setup grant counters and setup exclusivity across two store instances', async () => {
            const first = await take(setup());
            const second = await take(setup());
            expect((await a.reserveExecution(first, limits)).status).toBe(
                'reserved',
            );
            expect((await b.reserveExecution(second, limits)).status).toBe(
                'setup_limit',
            );
            const sameOrg = await take(run());
            expect(
                (
                    await b.reserveExecution(sameOrg, {
                        ...limits,
                        perOrgExecuting: 1,
                    })
                ).status,
            ).toBe('org_limit');
            const another = await take(run(ownOrg()));
            expect(
                (
                    await b.reserveExecution(another, {
                        ...limits,
                        globalExecuting: 1,
                    })
                ).status,
            ).toBe('global_limit');
            const candidates = await Promise.all(
                Array.from({ length: 8 }, () => take(run(ownOrg()))),
            );
            const grants = await Promise.all(
                candidates.map((lease, i) =>
                    (i % 2 ? a : b).reserveExecution(lease, limits),
                ),
            );
            expect(
                grants.filter((result) => result.status === 'reserved'),
            ).toHaveLength(2);
            expect(
                (
                    await pool.query(
                        'SELECT count(*)::int AS n FROM runtime.runtime_admission_requests WHERE permit_held',
                    )
                ).rows[0].n,
            ).toBe(3);
        });

        it('fences an old worker after lease takeover without changing physical ticket identity', async () => {
            const input = run();
            const old = await take(input);
            await pool.query(
                "UPDATE runtime.runtime_admission_requests SET owner_until=now()-interval '1 second' WHERE org_id=$1 AND kind=$2 AND request_key=$3",
                [old.organizationId, old.kind, old.key],
            );
            const next = await b.take(ref(input), 0, 30_000);
            expect(next.status).toBe('taken');
            if (next.status !== 'taken') return;
            expect(next.lease.ownerEpoch).toBe(old.ownerEpoch + 1);
            expect(next.lease.ticketOwnerToken).toBe(old.ticketOwnerToken);
            expect(next.lease.leaseToken).not.toBe(old.leaseToken);
            expect((await a.reserveExecution(old, limits)).status).toBe(
                'stale',
            );
            expect((await b.reserveExecution(next.lease, limits)).status).toBe(
                'reserved',
            );
            const current = (await b.get(ref(input)))!;
            expect((await a.attachTicket(old, ticket(current))).changed).toBe(
                false,
            );
            expect(
                (await b.attachTicket(next.lease, ticket(current))).changed,
            ).toBe(true);
        });

        it('retains active permits after cancellation and expiry until claim cleanup is recorded', async () => {
            const input = run();
            const lease = await take(input);
            await a.reserveExecution(lease, limits);
            const accepted = (await a.get(ref(input)))!;
            await a.attachTicket(lease, ticket(accepted));
            const cancelled = await b.cancel(ref(input));
            expect(cancelled.changed).toBe(true);
            expect(await a.owns(identity(accepted))).toBe(false);
            expect((await a.markDispatched(lease)).changed).toBe(false);
            const claim = randomUUID();
            await pool.query(
                `INSERT INTO runtime.runtime_claims (claim_id,cell_id,org_id,run_id,side,state,lease_expires_at,hard_expires_at,consumer)
            VALUES ($1,'cell-admission-it',$2,$3,'base','bound',now()-interval '2 hours',now()-interval '1 hour','runtime')`,
                [claim, org, ref(input).key],
            );
            expect(
                (
                    await a.finishExecution(
                        identity(accepted),
                        accepted.executionId!,
                    )
                ).changed,
            ).toBe(false);
            expect((await a.get(ref(input)))!.permitHeld).toBe(true);
            await pool.query(
                "UPDATE runtime.runtime_claims SET state='released',released_at=now() WHERE claim_id=$1 AND org_id=$2",
                [claim, org],
            );
            expect(
                (
                    await b.finishExecution(
                        identity(accepted),
                        accepted.executionId!,
                    )
                ).changed,
            ).toBe(true);
            expect((await a.get(ref(input)))!.permitHeld).toBe(false);
        });

        it('persists cancel-before-accept and prevents cross-tenant execution identity collisions', async () => {
            const input = run();
            await a.cancel(ref(input));
            expect((await b.accept(input, limits)).status).toBe('cancelled');
            const acceptedInput = run();
            await row(acceptedInput);
            const foreign = structuredClone(acceptedInput);
            foreign.request.organizationId = ownOrg();
            expect(await b.accept(foreign, limits)).toEqual({
                status: 'conflict',
            });
            expect(await b.get(ref(foreign))).toBeNull();
        });

        it('leaves attached dispatch intents repairable without exposing payloads in due scans', async () => {
            const input = run();
            const lease = await take(input);
            await a.reserveExecution(lease, limits);
            const current = (await a.get(ref(input)))!;
            await a.attachTicket(lease, ticket(current));
            await pool.query(
                "UPDATE runtime.runtime_admission_requests SET owner_until=now()-interval '1 second' WHERE org_id=$1 AND kind=$2 AND request_key=$3",
                [lease.organizationId, lease.kind, lease.key],
            );
            expect(await b.due(1)).toEqual([
                { ...ref(input), generation: 0, action: 'dispatch' },
            ]);
            const repair = await b.take(ref(input), 0, 30_000);
            if (repair.status !== 'taken') throw new Error(repair.status);
            expect(repair.record.ticket!.ticketId).toBe(
                (await a.get(ref(input)))!.ticket!.ticketId,
            );
            expect((await b.markDispatched(repair.lease)).changed).toBe(true);
            expect(
                (
                    await a.startExecution(
                        identity(current),
                        current.executionId!,
                    )
                ).changed,
            ).toBe(true);
            expect((await b.get(ref(input)))!.permitHeld).toBe(true);
        });

        it('persists terminal ticket cleanup across replica retries and acknowledges only the matching ticket', async () => {
            const input = run();
            const lease = await take(input);
            await a.reserveExecution(lease, limits);
            const accepted = (await a.get(ref(input)))!;
            const physical = ticket(accepted);
            await a.attachTicket(lease, physical);
            await a.markDispatched(lease);
            await a.startExecution(identity(accepted), accepted.executionId!);
            await a.finishExecution(identity(accepted), accepted.executionId!);

            expect(await b.due(100)).toContainEqual({
                ...ref(input),
                generation: 0,
                action: 'finalize',
            });
            expect(
                (
                    await b.finishExecution(
                        identity(accepted),
                        accepted.executionId!,
                    )
                ).releasedTicket,
            ).toEqual(physical);
            expect(
                await b.accept(run(), { ...limits, perOrgWaiting: 1 }),
            ).toEqual({ status: 'backlog_full' });
            expect(
                (
                    await b.acknowledgeTicketCleanup(
                        { ...identity(accepted), generation: 1 },
                        physical.ticketId,
                    )
                ).changed,
            ).toBe(false);
            expect(
                (
                    await b.acknowledgeTicketCleanup(
                        identity(accepted),
                        'wrong-ticket',
                    )
                ).changed,
            ).toBe(false);
            expect(
                (
                    await b.acknowledgeTicketCleanup(
                        identity(accepted),
                        physical.ticketId,
                    )
                ).changed,
            ).toBe(true);
            expect((await a.get(ref(input)))!).toMatchObject({
                state: 'completed',
                permitHeld: false,
                ticket: null,
                nextAt: null,
            });
            expect(await a.due(100)).toEqual([]);
        });

        it('rotates more than 200 old running and approval intents without starving newer waiting repair', async () => {
            const input = run();
            const accepted = await row(input);
            await pool.query(
                `INSERT INTO runtime.runtime_admission_requests (
                org_id,kind,request_key,generation,ticket_owner_token,payload,payload_bytes,payload_hash,execution_id,state,
                deadline_at,approval_deadline_at,next_at,max_attempts,owner_epoch,permit_held,created_at,updated_at)
                SELECT org_id,kind,$2||'-old-'||g,0,gen_random_uuid(),payload,payload_bytes,payload_hash,$2||'-old-'||g,
                  CASE WHEN g%2=0 THEN 'awaiting_approval' ELSE 'running' END,
                  deadline_at,now()+interval '7 days',now()-interval '1 hour',max_attempts,0,g%2<>0,created_at,updated_at
                FROM runtime.runtime_admission_requests CROSS JOIN generate_series(1,201) AS g
                WHERE org_id=$1 AND request_key=$2`,
                [org, accepted.key],
            );
            const pages = [
                await a.due(100),
                await b.due(100),
                await a.due(100),
            ];
            const seen = pages.flat().map((item) => item.key);
            expect(pages[0].some((item) => item.key === accepted.key)).toBe(
                false,
            );
            expect(new Set(seen).size).toBe(202);
            expect(seen).toContain(accepted.key);
            expect((await b.get(ref(input)))!.nextAt).toBe(accepted.nextAt);
        });

        it('retains active and pending-cleanup payloads while deleting only bounded old terminal rows', async () => {
            const completed = await row(run());
            const cancelled = await row(run());
            const activeInput = run();
            const activeLease = await take(activeInput);
            await a.reserveExecution(activeLease, limits);
            const active = (await a.get(ref(activeInput)))!;
            const pendingInput = run();
            const pendingLease = await take(pendingInput);
            await a.reserveExecution(pendingLease, limits);
            const pending = (await a.get(ref(pendingInput)))!;
            await a.attachTicket(pendingLease, ticket(pending));
            await a.finishExecution(identity(pending), pending.executionId!);
            await a.finishExecution(
                identity(completed),
                completed.executionId!,
            );
            await a.cancel(cancelled);
            await pool.query(
                "UPDATE runtime.runtime_admission_requests SET updated_at=now()-interval '31 days' WHERE org_id=$1",
                [org],
            );
            await applyRetention(pool, 30, 1);
            const terminal = [await a.get(completed), await a.get(cancelled)];
            expect(terminal.filter((item) => item === null)).toHaveLength(1);
            expect(await a.get(active)).toMatchObject({ permitHeld: true });
            expect(await a.get(pending)).toMatchObject({
                permitHeld: false,
                ticket: expect.any(Object),
            });
            await applyRetention(pool, 30, 1);
            expect(await a.get(completed)).toBeNull();
            expect(await a.get(cancelled)).toBeNull();
            expect(await a.get(active)).not.toBeNull();
            expect(await a.get(pending)).not.toBeNull();
        });

        it('writes large sealed payloads once and keeps lease/ticket updates and ownership reads lean', async () => {
            const marker = 'SYNTHETIC_LARGE_PAYLOAD_';
            const calls: Array<{ text: string; hasPayload: boolean }> = [];
            const record = (text: string, values: unknown[] = []) => {
                calls.push({
                    text,
                    hasPayload: values.some(
                        (value) =>
                            typeof value === 'string' && value.includes(marker),
                    ),
                });
            };
            const observed = new Proxy(pool, {
                get(target, property) {
                    if (property === 'connect')
                        return async () => {
                            const client = await target.connect();
                            return {
                                query: async (
                                    text: string,
                                    values?: unknown[],
                                ) => {
                                    record(text, values);
                                    return client.query(text, values);
                                },
                                release: () => client.release(),
                            };
                        };
                    if (property === 'query')
                        return async (text: string, values?: unknown[]) => {
                            record(text, values);
                            return target.query(text, values);
                        };
                    const value = (target as any)[property];
                    return typeof value === 'function'
                        ? value.bind(target)
                        : value;
                },
            }) as Pool;
            const lean = new PgAdmissionStore(observed);
            const input = run();
            if (input.kind !== 'run') return;
            input.request.diff[0].patch = marker.repeat(10_000);
            const accepted = await lean.accept(input, limits);
            if (!('record' in accepted)) throw new Error(accepted.status);
            expect(calls.filter((call) => call.hasPayload)).toHaveLength(1);
            calls.length = 0;
            const owned = await lean.take(ref(input), 0, 30_000);
            if (owned.status !== 'taken') throw new Error(owned.status);
            await lean.reserveExecution(owned.lease, limits);
            await lean.attachTicket(owned.lease, ticket(accepted.record));
            await lean.markDispatched(owned.lease);
            expect(calls.some((call) => call.hasPayload)).toBe(false);
            calls.length = 0;
            expect(await lean.owns(identity(accepted.record))).toBe(true);
            expect(calls).toHaveLength(1);
            expect(calls[0].text).not.toContain('SELECT *');
            expect(calls[0].text).not.toContain('payload');
            const stored = (await lean.get(ref(input)))!;
            expect(stored.payload).toEqual(input);
            expect((await lean.accept(input, limits)).status).toBe('existing');
        });
    },
);
