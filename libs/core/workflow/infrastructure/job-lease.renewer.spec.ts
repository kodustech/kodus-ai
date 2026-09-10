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
});