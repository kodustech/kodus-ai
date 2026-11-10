import { randomUUID } from 'crypto';

import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/contracts/runtime-commands';
import { sealSecret } from '@libs/runtime/run/sealed-secret';

import { shopRunRequest } from '../e2e/fixtures';
import type {
    AdmissionIdentity,
    AdmissionLease,
    AdmissionLimits,
    AdmissionPayload,
    AdmissionRecord,
    AdmissionRef,
    PhysicalAdmissionTicket,
} from './admission-contract';
import { InMemoryAdmissionStore } from './admission-store';

const AT = Date.parse('2026-11-08T12:00:00Z');
const limits: AdmissionLimits = {
    globalWaiting: 20,
    perOrgWaiting: 10,
    globalExecuting: 3,
    perOrgExecuting: 2,
    maxAttempts: 3,
};
const run = (
    org = 'org-a',
    over: Record<string, unknown> = {},
): AdmissionPayload => ({
    kind: 'run',
    request: {
        ...shopRunRequest(),
        organizationId: org,
        requestedAt: new Date(AT).toISOString(),
        ...over,
    },
});
const setup = (org = 'org-a'): AdmissionPayload => {
    const key = randomUUID();
    const request: RuntimeEnvironmentSetupRequested = {
        key,
        organizationId: org,
        environmentId: 'env-a',
        teamId: 't',
        repositoryId: 'r',
        repositoryName: 'acme/shop',
        requestedAt: new Date(AT).toISOString(),
        requestedBy: { userId: 'u' },
        repoToken: sealSecret('synthetic', Buffer.alloc(32, 1), key),
    };
    return { kind: 'setup', request };
};
const ref = (payload: AdmissionPayload): AdmissionRef => ({
    organizationId: payload.request.organizationId,
    kind: payload.kind,
    key: payload.kind === 'run' ? payload.request.runId : payload.request.key,
});
const ticket = (row: AdmissionRecord, now = AT): PhysicalAdmissionTicket => ({
    organizationId: row.organizationId,
    kind: row.kind,
    key: row.key,
    generation: row.generation,
    ticketOwnerToken: row.ticketOwnerToken,
    ticketId: randomUUID(),
    cellId: 'cell-a',
    sessionEpoch: randomUUID(),
    expiresAt: new Date(now + 120_000).toISOString(),
    members: [
        {
            side: row.kind === 'setup' ? 'setup' : 'base',
            idempotencyKey: row.key,
            claimId: 'claim-a',
        },
    ],
});
const identity = (row: AdmissionRecord): AdmissionIdentity => ({
    organizationId: row.organizationId,
    kind: row.kind,
    key: row.key,
    generation: row.generation,
    ticketOwnerToken: row.ticketOwnerToken,
});

describe('logical admission state and ownership', () => {
    let at: number;
    let liveClaims: boolean;
    let store: InMemoryAdmissionStore;
    beforeEach(() => {
        at = AT;
        liveClaims = false;
        store = new InMemoryAdmissionStore({
            now: () => new Date(at),
            hasLiveClaims: async () => liveClaims,
        });
    });
    const accept = async (input: AdmissionPayload, cap = limits) => {
        const result = await store.accept(input, cap);
        if (!('record' in result)) throw new Error(result.status);
        return result.record;
    };
    const take = async (input: AdmissionPayload): Promise<AdmissionLease> => {
        const row = await accept(input);
        const result = await store.take(ref(input), row.generation, 30_000);
        if (result.status !== 'taken') throw new Error(result.status);
        return result.lease;
    };

    it('validates sealed Run/setup arguments and refuses plaintext without storing them', async () => {
        for (const input of [run(), setup()]) {
            const bad = structuredClone(input);
            bad.request.repoToken = 'PLAINTEXT_SECRET';
            await expect(store.accept(bad, limits)).rejects.toThrow(
                'invalid admission input',
            );
            expect(await store.get(ref(input))).toBeNull();
        }
    });

    it('deduplicates exact input, refuses conflicting identity, and never reads another tenant', async () => {
        const input = run();
        expect((await store.accept(input, limits)).status).toBe('accepted');
        expect(
            (await store.accept(structuredClone(input), limits)).status,
        ).toBe('existing');
        const changed = structuredClone(input);
        if (changed.kind === 'run')
            changed.request.pullRequest.title = 'different';
        expect(await store.accept(changed, limits)).toEqual({
            status: 'conflict',
        });
        const foreign = structuredClone(input);
        foreign.request.organizationId = 'org-b';
        expect(await store.accept(foreign, limits)).toEqual({
            status: 'conflict',
        });
        expect(await store.get(ref(foreign))).toBeNull();
    });

    it('bounds accepted waiting counts and normalized UTF8 payload bytes', async () => {
        const first = run();
        const row = await accept(first);
        expect(row.payloadBytes).toBe(
            Buffer.byteLength(JSON.stringify(row.payload)),
        );
        expect(
            await store.accept(run(), { ...limits, perOrgWaiting: 1 }),
        ).toEqual({ status: 'backlog_full' });
        expect(
            await store.accept(run('org-b'), { ...limits, globalWaiting: 1 }),
        ).toEqual({ status: 'backlog_full' });
        expect(
            await store.accept(run('org-b'), { ...limits, maxPayloadBytes: 1 }),
        ).toEqual({ status: 'payload_too_large' });
        expect(
            await store.accept(run('org-b'), {
                ...limits,
                globalBacklogBytes: row.payloadBytes,
            }),
        ).toEqual({ status: 'backlog_full' });
        expect(
            await store.accept(run(), {
                ...limits,
                orgBacklogBytes: row.payloadBytes,
            }),
        ).toEqual({ status: 'backlog_full' });
    });

    it('writes a cancellation tombstone before acceptance and refuses late resurrection', async () => {
        const input = run();
        expect((await store.cancel(ref(input))).changed).toBe(true);
        expect((await store.accept(input, limits)).status).toBe('cancelled');
        expect((await store.get(ref(input)))!.payload).toBeNull();
        expect((await store.take(ref(input), 0, 30_000)).status).toBe(
            'cancelled',
        );
    });

    it('fences expired worker owners while retaining the same generation physical identity', async () => {
        const input = run();
        const old = await take(input);
        expect((await store.take(ref(input), 0, 30_000)).status).toBe('busy');
        at += 30_001;
        const next = await store.take(ref(input), 0, 30_000);
        expect(next.status).toBe('taken');
        if (next.status !== 'taken') return;
        expect(next.lease.ticketOwnerToken).toBe(old.ticketOwnerToken);
        expect(next.lease.leaseToken).not.toBe(old.leaseToken);
        expect(next.lease.ownerEpoch).toBe(old.ownerEpoch + 1);
        expect(
            (
                await store.defer(
                    old,
                    'no_capacity',
                    new Date(at + 1_000).toISOString(),
                )
            ).changed,
        ).toBe(false);
        const before = next.record.deadlineAt;
        const deferred = await store.defer(
            next.lease,
            'no_capacity',
            new Date(at + 1_000).toISOString(),
        );
        expect(deferred.changed).toBe(true);
        expect(deferred.record!.generation).toBe(1);
        expect(deferred.record!.ticketOwnerToken).not.toBe(
            old.ticketOwnerToken,
        );
        expect(deferred.record!.deadlineAt).toBe(before);
        expect((await store.take(ref(input), 0, 30_000)).status).toBe('stale');
    });

    it('shares global/per-org execution limits across kinds and preserves setup-at-most-one', async () => {
        const firstSetup = await take(setup());
        const secondSetup = await take(setup());
        const r = await take(run());
        expect((await store.reserveExecution(firstSetup, limits)).status).toBe(
            'reserved',
        );
        expect((await store.reserveExecution(secondSetup, limits)).status).toBe(
            'setup_limit',
        );
        expect(
            (await store.reserveExecution(r, { ...limits, perOrgExecuting: 1 }))
                .status,
        ).toBe('org_limit');
        const other = await take(run('org-b'));
        expect(
            (
                await store.reserveExecution(other, {
                    ...limits,
                    globalExecuting: 1,
                })
            ).status,
        ).toBe('global_limit');
    });

    it('retains a cancelled permit through lease expiry until explicit confirmed cleanup', async () => {
        const input = run();
        const lease = await take(input);
        const row =
            (await store.reserveExecution(lease, limits)).status === 'reserved'
                ? (await store.get(ref(input)))!
                : null;
        expect(row).not.toBeNull();
        expect((await store.cancel(ref(input))).changed).toBe(true);
        at += 120_000;
        expect((await store.get(ref(input)))!.permitHeld).toBe(true);
        liveClaims = true;
        expect(
            (await store.finishExecution(identity(row!), row!.executionId!))
                .changed,
        ).toBe(false);
        liveClaims = false;
        expect(
            (await store.finishExecution(identity(row!), row!.executionId!))
                .changed,
        ).toBe(true);
        expect((await store.get(ref(input)))!.permitHeld).toBe(false);
    });

    it('persists the dispatch intent before wake and does not reuse it for another generation', async () => {
        const input = run();
        const lease = await take(input);
        await store.reserveExecution(lease, limits);
        const row = (await store.get(ref(input)))!;
        const physical = ticket(row);
        expect((await store.attachTicket(lease, physical)).changed).toBe(true);
        expect(await store.owns(identity(row))).toBe(true);
        expect(
            (
                await store.defer(
                    lease,
                    'no_capacity',
                    new Date(at + 1_000).toISOString(),
                )
            ).changed,
        ).toBe(false);
        expect((await store.markDispatched(lease)).changed).toBe(true);
        expect(
            (await store.startExecution(identity(row), row.executionId!))
                .changed,
        ).toBe(true);
        expect(
            (
                await store.startExecution(
                    { ...identity(row), generation: 1 },
                    row.executionId!,
                )
            ).changed,
        ).toBe(false);
        expect((await store.get(ref(input)))!.state).toBe('running');
    });

    it('keeps terminal ticket cleanup due until a matching success acknowledgement', async () => {
        const input = run();
        const lease = await take(input);
        await store.reserveExecution(lease, limits);
        const row = (await store.get(ref(input)))!;
        const physical = ticket(row);
        await store.attachTicket(lease, physical);
        await store.markDispatched(lease);
        await store.startExecution(identity(row), row.executionId!);

        expect(
            (
                await store.finishExecution(
                    { ...identity(row), generation: 1 },
                    row.executionId!,
                )
            ).releasedTicket,
        ).toBeUndefined();
        await store.finishExecution(identity(row), row.executionId!);
        expect((await store.get(ref(input)))!).toMatchObject({
            permitHeld: false,
            ticket: physical,
        });
        expect(await store.due(10)).toContainEqual({
            ...ref(input),
            generation: 0,
            action: 'finalize',
        });
        expect(
            await store.accept(run(), { ...limits, perOrgWaiting: 1 }),
        ).toEqual({ status: 'backlog_full' });
        expect(
            await store.accept(run('org-b'), {
                ...limits,
                globalBacklogBytes: row.payloadBytes,
            }),
        ).toEqual({ status: 'backlog_full' });
        expect(
            (await store.finishExecution(identity(row), row.executionId!))
                .releasedTicket,
        ).toEqual(physical);
        expect(
            (
                await store.acknowledgeTicketCleanup(
                    { ...identity(row), generation: 1 },
                    physical.ticketId,
                )
            ).changed,
        ).toBe(false);
        expect(
            (
                await store.acknowledgeTicketCleanup(
                    identity(row),
                    'wrong-ticket',
                )
            ).changed,
        ).toBe(false);
        expect(
            (
                await store.acknowledgeTicketCleanup(
                    identity(row),
                    physical.ticketId,
                )
            ).changed,
        ).toBe(true);
        expect((await store.get(ref(input)))!).toMatchObject({
            permitHeld: false,
            ticket: null,
            nextAt: null,
        });
        expect(await store.due(10)).toEqual([]);
    });

    it('rotates due pages fairly without changing the waiting request schedule', async () => {
        const first = await accept(run());
        at += 1;
        const second = await accept(run());
        expect((await store.due(1))[0].key).toBe(first.key);
        expect((await store.due(1))[0].key).toBe(second.key);
        expect((await store.due(1))[0].key).toBe(first.key);
        expect((await store.due(1))[0].key).toBe(second.key);
        expect((await store.get(second))!.nextAt).toBe(second.nextAt);
    });

    it('expires an old request without resetting its queue deadline or allocating work', async () => {
        const input = run('org-a', {
            requestedAt: new Date(AT - 31 * 60_000).toISOString(),
        });
        const row = await accept(input);
        expect(row.state).toBe('expired');
        expect(row.executionId).toBeTruthy();
        expect(row.payload).toBeTruthy();
        expect(row.permitHeld).toBe(false);
        expect((await store.take(ref(input), 0, 30_000)).status).toBe(
            'expired',
        );
    });

    it('bounds fork approval and establishes the queue clock once with fresh sealed tokens', async () => {
        const input = run();
        if (input.kind !== 'run') return;
        input.request.pullRequest.fork = true;
        const row = await accept(input);
        expect(row.state).toBe('awaiting_approval');
        expect(row.deadlineAt).toBeNull();
        expect(row.approvalDeadlineAt).toBe(
            new Date(AT + 7 * 24 * 60 * 60_000).toISOString(),
        );
        at += 60_000;
        const tokens = {
            repoToken: sealSecret(
                'repo-new',
                Buffer.alloc(32, 1),
                input.request.runId,
            ),
            runToken: sealSecret(
                'run-new',
                Buffer.alloc(32, 1),
                input.request.runId,
            ),
        };
        const approved = await store.approveRun(ref(input), tokens, limits);
        expect(approved.changed).toBe(true);
        expect(approved.record!.payload).toMatchObject({
            options: {
                forkApproved: true,
                queuedAt: new Date(at).toISOString(),
            },
            request: tokens,
        });
        expect(approved.record!.deadlineAt).toBe(
            new Date(at + 30 * 60_000).toISOString(),
        );
        expect(approved.record!.executionId).toBe(`${input.request.runId}:run`);
        expect((await store.accept(input, limits)).status).toBe('existing');
        const fixed = approved.record!.deadlineAt;
        at += 60_000;
        expect(
            (await store.approveRun(ref(input), tokens, limits)).changed,
        ).toBe(false);
        expect((await store.get(ref(input)))!.deadlineAt).toBe(fixed);
    });

    it('returns bounded lightweight repair references without request bodies', async () => {
        await accept(run());
        await accept(setup());
        const due = await store.due(1);
        expect(due).toHaveLength(1);
        expect(Object.keys(due[0]).sort()).toEqual([
            'action',
            'generation',
            'key',
            'kind',
            'organizationId',
        ]);
    });
});
