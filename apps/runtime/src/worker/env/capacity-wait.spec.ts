import { getEventListeners } from 'node:events';

import type { AcquireRequest, Blocked, Claim } from '@libs/runtime/environment';

import { acquireWaitingForRoom, type CapacityWaitOptions } from './capacity-wait';

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
