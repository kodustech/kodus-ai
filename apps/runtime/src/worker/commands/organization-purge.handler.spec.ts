import { isRunLaneEvent, RuntimeCommandName, runtimeCommandOutboxMessage, runtimeCommandRoute } from '@libs/runtime/contracts/runtime-commands';
import { InMemoryRunProjectionStore } from '@libs/runtime/run/testing';

import { InMemoryEvidenceStore } from '../../shared/evidence/testing';
import { InMemoryOrganizationPurgeStore } from '../../shared/persistence/testing';
import { OrganizationPurgeNotReadyError, OrganizationPurgeRequestedHandler } from './organization-purge.handler';

const AT = '2026-11-20T10:00:00.000Z';
const STEP = '0b6f2c1e-7a4d-4c3b-9f1e-2d8a5c6b7e90';
const command = (over: Record<string, unknown> = {}) => ({ organizationId: 'org-a', requestedAt: AT, reason: 'organization_deleted', ...over });
const live = (runId: string, organizationId: string) => ({ runId, organizationId, attempt: 1, correlationId: `c-${runId}`, headSha: 'a'.repeat(40), state: 'testing' as const, updatedAt: AT });

function setup() {
    const projection = new InMemoryRunProjectionStore();
    const purge = new InMemoryOrganizationPurgeStore();
    const evidence = new InMemoryEvidenceStore();
    const released: string[] = [];
    const stopped: string[] = [];
    const engine = {
        // The finalization the engine starts: the Run ends and its claims with it, as the workflow would.
        stop: jest.fn(async (run: { runId: string; organizationId: string }, state: string) => {
            stopped.push(`${run.runId}:${state}`);
            await projection.upsert(run.runId, { state: 'cancelled' } as never);
            return 'stop';
        }),
    };
    const releaser = {
        release: jest.fn(async (ref: { claimId: string; organizationId: string }) => {
            released.push(ref.claimId);
            purge.release(ref.organizationId, ref.claimId);
        }),
    };
    const handler = new OrganizationPurgeRequestedHandler(engine, projection, purge, releaser, evidence);
    return { projection, purge, evidence, engine, releaser, handler, released, stopped };
}

const key = (organizationId: string, runId: string) => `${organizationId}/${runId}/pr/${STEP}/output`;

describe('OrganizationPurgeRequestedHandler', () => {
    it("deletes the organization's evidence and rows, and nothing of another organization", async () => {
        const { purge, evidence, handler } = setup();
        await evidence.put(key('org-a', 'run-1'), '{}', 'application/json');
        await evidence.put(key('org-ab', 'run-1'), '{}', 'application/json');
        purge.rows.set('org-a', { runtime_runs: 3, runtime_run_events: 40 });
        purge.rows.set('org-b', { runtime_runs: 5 });

        await expect(handler.handle(command())).resolves.toBeUndefined();

        expect([...evidence.objects.keys()]).toEqual([key('org-ab', 'run-1')]);
        expect(purge.rows.get('org-a')).toBeUndefined();
        expect(purge.rows.get('org-b')).toEqual({ runtime_runs: 5 });
        expect(purge.cordoned).toEqual(['org-a']);
    });

    it('cancels the live Runs of the organization only and releases its claims, then deletes in the same delivery once they ended', async () => {
        const { projection, purge, handler, released, stopped } = setup();
        await projection.upsert('run-a', live('run-a', 'org-a'));
        await projection.upsert('run-b', live('run-b', 'org-b'));
        purge.claims.set('org-a', [{ claimId: 'claim-1', runId: 'run-a' }, { claimId: 'claim-2', runId: null }]);
        purge.claims.set('org-b', [{ claimId: 'claim-3', runId: 'run-b' }]);
        purge.rows.set('org-a', { runtime_runs: 1 });

        await handler.handle(command());

        expect(stopped).toEqual(['run-a:cancelled']);
        expect(released).toEqual(['claim-1', 'claim-2']);
        expect(purge.deleteCalls).toBe(1);
        expect(purge.claims.get('org-b')).toHaveLength(1);
        expect((await projection.get('run-b', { organizationId: 'org-b' }))?.state).toBe('testing');
    });

    it('deletes nothing and fails the delivery while a Run or a claim is still live, so the broker retries it', async () => {
        const { projection, purge, evidence, engine, releaser, handler } = setup();
        // A finalization that has not ended the Run yet, and a hub that cannot release the claim now.
        engine.stop.mockImplementation(async () => 'stop');
        releaser.release.mockRejectedValue(new Error('hub unavailable'));
        await projection.upsert('run-a', live('run-a', 'org-a'));
        purge.claims.set('org-a', [{ claimId: 'claim-1', runId: 'run-a' }]);
        purge.rows.set('org-a', { runtime_runs: 1 });
        await evidence.put(key('org-a', 'run-a'), '{}', 'application/json');

        await expect(handler.handle(command())).rejects.toMatchObject({ liveRuns: 1, liveClaims: 1 });
        await expect(handler.handle(command())).rejects.toBeInstanceOf(OrganizationPurgeNotReadyError);

        expect(purge.deleteCalls).toBe(0);
        expect(purge.rows.get('org-a')).toEqual({ runtime_runs: 1 });
        expect(evidence.objects.size).toBe(1);
    });

    it('keeps every row when the evidence cannot be deleted, so the retry finds them', async () => {
        const { purge, evidence, handler } = setup();
        purge.rows.set('org-a', { runtime_runs: 1 });
        jest.spyOn(evidence, 'deletePrefix').mockRejectedValue(new Error('s3 delete_objects failed: 503'));
        await expect(handler.handle(command())).rejects.toThrow('503');
        expect(purge.rows.get('org-a')).toEqual({ runtime_runs: 1 });
    });

    it('is idempotent: a second command finds nothing and ends', async () => {
        const { purge, handler } = setup();
        purge.rows.set('org-a', { runtime_runs: 1 });
        await handler.handle(command());
        await expect(handler.handle(command({ reason: 'owner_requested', requestedBy: { userId: 'u-1' } }))).resolves.toBeUndefined();
        expect(purge.deleteCalls).toBe(2);
    });

    it('works without an evidence store configured', async () => {
        const { projection, purge, engine, releaser } = setup();
        purge.rows.set('org-a', { runtime_runs: 1 });
        await new OrganizationPurgeRequestedHandler(engine, projection, purge, releaser, null).handle(command());
        expect(purge.rows.get('org-a')).toBeUndefined();
    });

    it('logs the counts and never an evidence key, a token or a host', async () => {
        const { purge, evidence, handler } = setup();
        const logs: unknown[] = [];
        const logger = (handler as unknown as { logger: { log: (m: unknown) => void } }).logger;
        jest.spyOn(logger, 'log').mockImplementation((m) => logs.push(m));
        await evidence.put(key('org-a', 'run-1'), '{}', 'application/json');
        purge.rows.set('org-a', { runtime_runs: 2, runtime_run_events: 7 });
        await handler.handle(command());
        expect(logs).toEqual([
            { msg: 'organization_purge.done', organizationId: 'org-a', reason: 'organization_deleted', rows: 9, tables: { runtime_runs: 2, runtime_run_events: 7 }, evidenceObjects: 1, poolsCordoned: 1, hostsKept: 0 },
        ]);
    });

    it('sends a malformed command to the dead-letter queue and touches nothing', async () => {
        const { purge, handler } = setup();
        purge.rows.set('org-a', { runtime_runs: 1 });
        expect(await handler.handle({ requestedAt: AT, reason: 'organization_deleted' })).toMatchObject({ invalid: 'invalid organization purge' });
        expect(await handler.handle(command({ organizationId: '' }))).toMatchObject({ invalid: 'invalid organization purge' });
        expect(await handler.handle(command({ reason: 'because' }))).toMatchObject({ invalid: 'invalid organization purge' });
        expect(purge.deleteCalls).toBe(0);
    });

    it('is the handler of its command name on the control lane', () => {
        const message = runtimeCommandOutboxMessage(RuntimeCommandName.OrganizationPurgeRequested, { organizationId: 'org-a', requestedAt: AT, reason: 'owner_requested', requestedBy: { userId: 'u-1' } }, 'm-1');
        expect(message.routingKey).toBe(runtimeCommandRoute(RuntimeCommandName.StopRequested).routingKey);
        expect(isRunLaneEvent(RuntimeCommandName.OrganizationPurgeRequested)).toBe(false);
        expect(setup().handler.event).toBe('runtime.organization.purge_requested');
    });
});
