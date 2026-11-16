import { getEventListeners } from 'node:events';

import type { AcquireRequest, Blocked, Claim } from '@libs/runtime/environment';

import { CellUnavailableError } from '../../shared/errors';
import { devSealKey } from '../../testing/dev-seal-key';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { acquireWaitingForRoom, CELL_LOST_WAIT_MS, type CapacityWaitOptions } from './capacity-wait';
import { HubClient, HubEnvironmentClient } from './hub-environment-runtime';

const refused: Blocked = {
    status: 'blocked',
    blockers: [{ kind: 'resources', signature: 'no_capacity', message: 'no room' }],
};
const ready: Claim = {
    claimId: 'claim-1',
    cellId: 'cell-1',
    cellOwner: 'kodus',
    observer: { id: 'observer-1', state: 'ready' },
    manifest: { services: [], expose: [], imageId: 'image-1', seedSha: 'sha-1' },
    leaseExpiresAt: '2026-11-07T12:45:00Z',
    hardExpiresAt: '2026-11-07T13:00:00Z',
};
const request = {} as AcquireRequest;

describe('capacity wait cancellation and deadline', () => {
    afterEach(() => {
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    it('does not acquire when already cancelled, and preserves the cancellation reason', async () => {
        const controller = new AbortController();
        const cancellation = new Error('workflow cancelled');
        controller.abort(cancellation);
        const acquire = jest.fn(async () => ready);
        const options: CapacityWaitOptions = {
            until: 30_000,
            now: () => new Date(0),
            signal: controller.signal,
        };

        await expect(acquireWaitingForRoom({ acquire }, request, options)).rejects.toBe(cancellation);
        expect(acquire).not.toHaveBeenCalled();
    });

    it('interrupts a pause when cancelled without waiting for another acquire', async () => {
        jest.useFakeTimers({ now: 0 });
        const controller = new AbortController();
        const cancellation = new Error('workflow cancelled');
        const acquire = jest.fn(async () => refused);
        const options: CapacityWaitOptions = {
            until: 30_000,
            now: () => new Date(),
            signal: controller.signal,
            jitter: () => 1,
        };
        const result = acquireWaitingForRoom({ acquire }, request, options).then(
            () => 'resolved',
            (error: unknown) => error,
        );
        await jest.advanceTimersByTimeAsync(0);
        expect(acquire).toHaveBeenCalledTimes(1);

        controller.abort(cancellation);
        await jest.advanceTimersByTimeAsync(0);

        expect(await Promise.race([result, Promise.resolve('pending')])).toBe(cancellation);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(jest.getTimerCount()).toBe(0);
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    });

    it('removes the cancellation listener after a pause completes normally', async () => {
        jest.useFakeTimers({ now: 0 });
        const controller = new AbortController();
        const acquire = jest.fn().mockResolvedValueOnce(refused).mockResolvedValue(ready);
        const result = acquireWaitingForRoom({ acquire }, request, {
            until: 30_000,
            now: () => new Date(),
            signal: controller.signal,
            jitter: () => 1,
        });

        await jest.advanceTimersByTimeAsync(5_000);

        await expect(result).resolves.toEqual({ claim: ready, waitedMs: 5_000, rounds: 2 });
        expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
        expect(jest.getTimerCount()).toBe(0);
    });

    it('observes cancellation during a progress update even when the update throws', async () => {
        const controller = new AbortController();
        const cancellation = new Error('workflow cancelled');
        const acquire = jest.fn(async () => refused);
        const sleep = jest.fn(async () => undefined);
        const result = acquireWaitingForRoom({ acquire }, request, {
            until: 30_000,
            now: () => new Date(0),
            signal: controller.signal,
            sleep,
            onWait: async () => {
                controller.abort(cancellation);
                throw new Error('progress unavailable');
            },
        });

        await expect(result).rejects.toBe(cancellation);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('observes cancellation after an acquire already in flight returns', async () => {
        const controller = new AbortController();
        const cancellation = new Error('workflow cancelled');
        const acquire = jest.fn(async () => {
            controller.abort(cancellation);
            return refused;
        });
        const sleep = jest.fn(async () => undefined);

        await expect(acquireWaitingForRoom({ acquire }, request, {
            until: 30_000,
            now: () => new Date(0),
            signal: controller.signal,
            sleep,
        })).rejects.toBe(cancellation);
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(sleep).not.toHaveBeenCalled();
    });

    it('returns the last refusal if a pause wakes after the deadline', async () => {
        let clock = 0;
        const acquire = jest.fn().mockResolvedValueOnce(refused).mockResolvedValue(ready);
        const result = await acquireWaitingForRoom({ acquire }, request, {
            until: 10_000,
            now: () => new Date(clock),
            jitter: () => 1,
            sleep: async () => void (clock = 20_000),
        });

        expect(result).toEqual({ claim: refused, waitedMs: 20_000, rounds: 1 });
        expect(acquire).toHaveBeenCalledTimes(1);
    });
});

const cellLost: Blocked = {
    status: 'blocked',
    blockers: [{ kind: 'platform', signature: 'cell_lost', message: 'the cell disconnected while the claim was booting' }],
};

describe('a cell lost while the claim boots', () => {
    const clock = () => {
        let t = 0;
        return { now: () => new Date(t), sleep: async (ms: number) => void (t += ms), at: () => t, pass: (ms: number) => void (t += ms) };
    };

    it('asks again with the same request until the cell is back, past the budget for room', async () => {
        const c = clock();
        const answers: Array<() => Promise<Claim | Blocked>> = [
            // The boot ran for 14 min before the cell dropped: the budget for room (10 min) is long gone.
            async () => (c.pass(14 * 60_000), cellLost),
            async () => { throw new CellUnavailableError('no cell is connected for this organization'); },
            async () => ready,
        ];
        const acquire = jest.fn((_req: AcquireRequest) => answers.shift()!());
        const onWait = jest.fn();

        const r = await acquireWaitingForRoom({ acquire }, request, { until: 10 * 60_000, now: c.now, sleep: c.sleep, jitter: () => 1, onWait });

        expect(r.claim).toBe(ready);
        expect(r.rounds).toBe(3);
        expect(acquire.mock.calls.every(([req]) => req === request)).toBe(true);
        // Never reported as a wait for room.
        expect(onWait).not.toHaveBeenCalled();
    });

    it('returns cell_lost when the cell is not back in CELL_LOST_WAIT_MS', async () => {
        const c = clock();
        const acquire = jest.fn(async () => cellLost);

        const r = await acquireWaitingForRoom({ acquire }, request, { until: 0, now: c.now, sleep: c.sleep, jitter: () => 1 });

        expect(r.claim).toBe(cellLost);
        expect(c.at()).toBeLessThanOrEqual(CELL_LOST_WAIT_MS);
        expect(c.at()).toBeGreaterThan(CELL_LOST_WAIT_MS - 15_000);
    });

    it('goes back to the budget for room when the cell returns and has no room', async () => {
        const c = clock();
        const answers = [cellLost, refused, refused, ready];
        const acquire = jest.fn(async () => answers.shift()!);
        const onWait = jest.fn();

        const r = await acquireWaitingForRoom({ acquire }, request, { until: 60_000, now: c.now, sleep: c.sleep, jitter: () => 1, onWait });

        expect(r.claim).toBe(ready);
        expect(onWait).toHaveBeenCalledTimes(2);
    });

    it('still throws when the first answer is an unreachable cell', async () => {
        const c = clock();
        const acquire = jest.fn(async () => { throw new CellUnavailableError('cell-1'); });

        await expect(acquireWaitingForRoom({ acquire }, request, { until: 60_000, now: c.now, sleep: c.sleep })).rejects.toBeInstanceOf(CellUnavailableError);
        expect(acquire).toHaveBeenCalledTimes(1);
    });
});

// A hub replica restarting (a deploy) while a claim boots drops the worker's acquire: the
// cell keeps preparing the claim and joins it again when asked with the same key.
describe('a hub that restarts while the claim boots', () => {
    const secrets = new SealedSecretOpener(devSealKey());
    const clock = () => {
        let t = 0;
        return { now: () => new Date(t), sleep: async (ms: number) => void (t += ms), at: () => t };
    };
    const env = (post: () => Promise<{ status: number; text: string }>) =>
        new HubEnvironmentClient(
            new HubClient({
                cellDirectory: { reserveCell: async () => ({ cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const }), replicaForClaim: async () => null },
                hubBaseUrl: 'https://hub',
                postImpl: post,
                refusedRetryDelaysMs: [],
            }),
            secrets,
            {
                correlationId: 'corr',
                organizationId: 'org-a',
                repo: { provider: 'github', fullName: 'acme/shop', apiBase: 'https://api.github.com' } as any,
                sealedRepoToken: secrets.seal('ghs_plain', 'setup-key'),
                tokenBinding: 'setup-key',
                imageId: 'setup',
                expose: [],
            },
        );
    const setupAcquire = { organizationId: 'org-a', environmentId: 'env-1', idempotencyKey: 'setup:key-1', consumer: 'setup', ref: { side: 'setup', sha: 'a'.repeat(40) } } as AcquireRequest;
    const dropped = () => Promise.reject(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }));

    it('gets the claim the cell was preparing when the first acquire is dropped mid-boot', async () => {
        const c = clock();
        const bodies: string[] = [];
        const answers = [dropped, async () => ({ status: 200, text: JSON.stringify(ready) })];
        const hubEnv = env(() => answers.shift()!());
        const acquire = jest.fn((req: AcquireRequest) => (bodies.push(req.idempotencyKey), hubEnv.acquire(req)));

        const r = await acquireWaitingForRoom({ acquire }, setupAcquire, { until: 60_000, now: c.now, sleep: c.sleep, jitter: () => 1 });

        expect(r.claim).toEqual(ready);
        expect(bodies).toEqual(['setup:key-1', 'setup:key-1']);
    });

    it('ends with the hub unreachable once it stays away past CELL_LOST_WAIT_MS', async () => {
        const c = clock();
        const acquire = jest.fn((req: AcquireRequest) => env(dropped).acquire(req));

        await expect(acquireWaitingForRoom({ acquire }, setupAcquire, { until: 0, now: c.now, sleep: c.sleep, jitter: () => 1 })).rejects.toBeInstanceOf(CellUnavailableError);
        expect(acquire.mock.calls.length).toBeGreaterThan(1);
        expect(c.at()).toBeLessThanOrEqual(CELL_LOST_WAIT_MS);
    });
});
