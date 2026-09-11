import {
    JOB_LEASE_TTL_MS,
    JOB_LEASE_RENEW_INTERVAL_MS,
    startJobLeaseRenewal,
} from './job-lease.renewer';

describe('startJobLeaseRenewal (#1830)', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });
    afterEach(() => {
        jest.useRealTimers();
    });

    it('renews the lease on the configured cadence', () => {
        const renew = jest.fn();
        const controller = new AbortController();
        startJobLeaseRenewal({ signal: controller.signal, renew });

        expect(renew).not.toHaveBeenCalled();
        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS);
        expect(renew).toHaveBeenCalledTimes(1);
        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS * 3);
        expect(renew).toHaveBeenCalledTimes(4);

        controller.abort();
        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS * 2);
        expect(renew).toHaveBeenCalledTimes(4);
    });

    it('stops renewing when the caller calls stop() (work completed)', () => {
        const renew = jest.fn();
        const controller = new AbortController();
        const renewal = startJobLeaseRenewal({
            signal: controller.signal,
            renew,
        });

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS);
        expect(renew).toHaveBeenCalledTimes(1);

        renewal.stop();
        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS * 3);
        expect(renew).toHaveBeenCalledTimes(1);
    });

    it('surfaces an async renewal failure via onRenewError without crashing', async () => {
        const onError = jest.fn();
        const renew = jest
            .fn()
            .mockRejectedValueOnce(new Error('db down'))
            .mockResolvedValue(undefined);
        const controller = new AbortController();
        startJobLeaseRenewal({
            signal: controller.signal,
            renew,
            onRenewError: onError,
        });

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS);
        await Promise.resolve(); // flush the rejection microtask
        expect(onError).toHaveBeenCalledWith(
            expect.objectContaining({ message: 'db down' }),
        );
        controller.abort();
    });

    it('the renew interval is well below the lease TTL', () => {
        expect(JOB_LEASE_RENEW_INTERVAL_MS).toBeLessThan(JOB_LEASE_TTL_MS);
    });

    it('logs every renewal failure (never silent) with context + metadata', async () => {
        const logger = { error: jest.fn() };
        const renew = jest.fn().mockRejectedValueOnce(new Error('db down'));
        const controller = new AbortController();

        startJobLeaseRenewal({
            signal: controller.signal,
            renew,
            logger: logger as any,
            jobId: 'job-1',
            organizationId: 'org-1',
        });

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS);
        await Promise.resolve();

        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                message: 'Failed to renew workflow job lease',
                context: 'startJobLeaseRenewal',
                error: expect.objectContaining({ message: 'db down' }),
                metadata: expect.objectContaining({
                    intervalMs: JOB_LEASE_RENEW_INTERVAL_MS,
                    jobId: 'job-1',
                    organizationId: 'org-1',
                }),
            }),
        );

        controller.abort();
    });

    it('treats the lease as lost after N consecutive failures and fires onLeaseLost once, then stops', async () => {
        const onLeaseLost = jest.fn();
        const renew = jest.fn().mockRejectedValue(new Error('db down'));
        const controller = new AbortController();

        startJobLeaseRenewal({
            signal: controller.signal,
            renew,
            maxConsecutiveFailures: 2,
            onLeaseLost,
        });

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS); // 1st failure
        await Promise.resolve();
        expect(onLeaseLost).not.toHaveBeenCalled();

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS); // 2nd failure → lost
        await Promise.resolve();
        expect(onLeaseLost).toHaveBeenCalledTimes(1);

        // Renewal stops: a lost lease is terminal for the caller.
        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS * 3);
        await Promise.resolve();
        expect(renew).toHaveBeenCalledTimes(2);
        expect(onLeaseLost).toHaveBeenCalledTimes(1);

        controller.abort();
    });

    it('resets the consecutive-failure count on a successful tick', async () => {
        const onLeaseLost = jest.fn();
        const renew = jest
            .fn()
            .mockRejectedValueOnce(new Error('blip'))
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('blip-2'));
        const controller = new AbortController();

        startJobLeaseRenewal({
            signal: controller.signal,
            renew,
            maxConsecutiveFailures: 2,
            onLeaseLost,
        });

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS); // failure 1
        await Promise.resolve();
        expect(onLeaseLost).not.toHaveBeenCalled();

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS); // success resets
        await Promise.resolve();

        jest.advanceTimersByTime(JOB_LEASE_RENEW_INTERVAL_MS); // failure 1 again
        await Promise.resolve();
        expect(onLeaseLost).not.toHaveBeenCalled();

        controller.abort();
    });
});
