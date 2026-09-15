jest.mock('e2b', () => ({
    Sandbox: { kill: jest.fn() },
}));

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { Sandbox } from 'e2b';
import { SandboxLeaseReaperService } from './sandbox-lease-reaper.service';

const mockKill = Sandbox.kill as jest.Mock;

describe('SandboxLeaseReaperService', () => {
    let service: SandboxLeaseReaperService;

    const leaseRepository = {
        findExpired: jest.fn(),
        findReadyToKill: jest.fn(),
        delete: jest.fn().mockResolvedValue(undefined),
        findByPrKey: jest.fn(),
        resetStaleCleanup: jest.fn(),
        claimCleanup: jest.fn(),
        completeCleanup: jest.fn(),
        failCleanup: jest.fn(),
        bumpKillRetry: jest.fn().mockResolvedValue(undefined),
    };

    const distributedLockService = {
        acquire: jest.fn().mockResolvedValue({ release: jest.fn() }),
    };

    const configService = {
        get: jest.fn().mockReturnValue('fake-api-key'),
    };

    beforeEach(() => {
        jest.clearAllMocks();
        distributedLockService.acquire.mockResolvedValue({
            release: jest.fn(),
        });
        configService.get.mockReturnValue('fake-api-key');
        leaseRepository.bumpKillRetry.mockResolvedValue(undefined);
        service = new SandboxLeaseReaperService(
            leaseRepository as any,
            distributedLockService as any,
            configService as any,
        );
    });

    describe('reapExpiredLeases', () => {
        it('deletes the lease when Sandbox.kill succeeds', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', state: 'READY' },
            ]);
            mockKill.mockResolvedValue(undefined);

            await service.reapExpiredLeases();

            expect(mockKill).toHaveBeenCalledWith('sbx-1', {
                apiKey: 'fake-api-key',
            });
            expect(leaseRepository.delete).toHaveBeenCalledWith('org:repo:1');
        });

        it('deletes the lease when the sandbox is already gone', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', state: 'READY' },
            ]);
            mockKill.mockRejectedValue(new Error('sandbox not found'));

            await service.reapExpiredLeases();

            expect(leaseRepository.delete).toHaveBeenCalledWith('org:repo:1');
        });

        // The bug this session found in production: a real Sandbox.kill
        // failure (timeout, upstream error, etc.) used to delete the lease
        // doc unconditionally, permanently orphaning the E2B sandbox with no
        // Mongo trace left to retry or reconcile against. Confirmed via prod
        // CloudWatch logs (2 occurrences / 7 days: TimeoutError, 503 no
        // healthy upstream) alongside a much larger population of untracked
        // graph-build/graph-incremental sandboxes.
        it('does NOT delete the lease when Sandbox.kill fails for a real reason', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', state: 'READY' },
            ]);
            mockKill.mockRejectedValue(
                new Error('TimeoutError: The operation was aborted due to timeout'),
            );

            await service.reapExpiredLeases();

            expect(leaseRepository.delete).not.toHaveBeenCalled();
        });

        it('bumps and does not delete when a real failure is well within the retry window', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    state: 'READY',
                    killRetryCount: 1,
                },
            ]);
            mockKill.mockRejectedValue(new Error('TimeoutError'));

            await service.reapExpiredLeases();

            expect(leaseRepository.bumpKillRetry).toHaveBeenCalledWith(
                'org:repo:1',
            );
            expect(leaseRepository.delete).not.toHaveBeenCalled();
        });

        // The soft cap (MAX_KILL_RETRIES) only escalates the log — it must
        // NOT stop the retry loop, or a lease whose kill keeps failing pins
        // forever (the bug this exact review comment caught: an earlier
        // version of this fix left no way out of this branch at all).
        it('still bumps and retries past the soft escalation threshold, well under the hard cap', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    state: 'READY',
                    killRetryCount: 5,
                    organizationId: 'org-uuid',
                },
            ]);
            mockKill.mockRejectedValue(new Error('TimeoutError'));

            await service.reapExpiredLeases();

            expect(leaseRepository.bumpKillRetry).toHaveBeenCalledWith(
                'org:repo:1',
            );
            expect(leaseRepository.delete).not.toHaveBeenCalled();
        });

        it('still retries at exactly the hard retry limit, one attempt short of giving up', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    state: 'READY',
                    killRetryCount: 19, // attempts becomes 20 === HARD_KILL_RETRY_LIMIT
                    organizationId: 'org-uuid',
                },
            ]);
            mockKill.mockRejectedValue(new Error('TimeoutError'));

            await service.reapExpiredLeases();

            expect(leaseRepository.bumpKillRetry).toHaveBeenCalledWith(
                'org:repo:1',
            );
            expect(leaseRepository.delete).not.toHaveBeenCalled();
        });

        // Only past this second, higher cap does the reaper give up and
        // force-delete — bounding the retry loop the soft cap deliberately
        // left open, while the sandbox itself may still be orphaned. The
        // small risk here is accepted in exchange for the doc never
        // pinning forever (confirmed prod failures were transient anyway:
        // TimeoutError/503, 2 occurrences / 7 days).
        it('gives up and force-deletes once the hard retry limit is exceeded', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    state: 'READY',
                    killRetryCount: 20, // attempts becomes 21 > HARD_KILL_RETRY_LIMIT
                    organizationId: 'org-uuid',
                },
            ]);
            mockKill.mockRejectedValue(new Error('TimeoutError'));

            await service.reapExpiredLeases();

            expect(leaseRepository.bumpKillRetry).not.toHaveBeenCalled();
            expect(leaseRepository.delete).toHaveBeenCalledWith('org:repo:1');
        });

        it('does not call Sandbox.kill for an INVALIDATED lease, but still deletes it', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', state: 'INVALIDATED' },
            ]);

            await service.reapExpiredLeases();

            expect(mockKill).not.toHaveBeenCalled();
            expect(leaseRepository.delete).toHaveBeenCalledWith('org:repo:1');
        });

        it('no-ops when there is nothing expired', async () => {
            leaseRepository.findExpired.mockResolvedValue([]);

            await service.reapExpiredLeases();

            expect(mockKill).not.toHaveBeenCalled();
            expect(leaseRepository.delete).not.toHaveBeenCalled();
        });

        it('skips the whole pass when the distributed lock is not acquired', async () => {
            distributedLockService.acquire.mockResolvedValue(null);
            leaseRepository.findExpired.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', state: 'READY' },
            ]);

            await service.reapExpiredLeases();

            expect(leaseRepository.findExpired).not.toHaveBeenCalled();
        });
    });

    describe('killIdleSandboxes', () => {
        it('deletes the lease when Sandbox.kill succeeds', async () => {
            leaseRepository.findReadyToKill.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', killAt: new Date() },
            ]);
            mockKill.mockResolvedValue(undefined);

            await service.killIdleSandboxes();

            expect(leaseRepository.delete).toHaveBeenCalledWith('org:repo:1');
        });

        it('does NOT delete the lease when Sandbox.kill fails for a real reason', async () => {
            leaseRepository.findReadyToKill.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', killAt: new Date() },
            ]);
            mockKill.mockRejectedValue(new Error('503: no healthy upstream'));

            await service.killIdleSandboxes();

            expect(leaseRepository.delete).not.toHaveBeenCalled();
        });

        it('still bumps and retries past the soft escalation threshold, well under the hard cap', async () => {
            leaseRepository.findReadyToKill.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    killAt: new Date(),
                    killRetryCount: 5,
                    organizationId: 'org-uuid',
                },
            ]);
            mockKill.mockRejectedValue(new Error('503: no healthy upstream'));

            await service.killIdleSandboxes();

            expect(leaseRepository.bumpKillRetry).toHaveBeenCalledWith(
                'org:repo:1',
            );
            expect(leaseRepository.delete).not.toHaveBeenCalled();
        });

        it('gives up and force-deletes once the hard retry limit is exceeded', async () => {
            leaseRepository.findReadyToKill.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    killAt: new Date(),
                    killRetryCount: 20, // attempts becomes 21 > HARD_KILL_RETRY_LIMIT
                    organizationId: 'org-uuid',
                },
            ]);
            mockKill.mockRejectedValue(new Error('503: no healthy upstream'));

            await service.killIdleSandboxes();

            expect(leaseRepository.bumpKillRetry).not.toHaveBeenCalled();
            expect(leaseRepository.delete).toHaveBeenCalledWith('org:repo:1');
        });

        it('deletes the lease when the sandbox is already gone', async () => {
            leaseRepository.findReadyToKill.mockResolvedValue([
                { _id: 'org:repo:1', sandboxId: 'sbx-1', killAt: new Date() },
            ]);
            mockKill.mockRejectedValue(new Error('sandbox already deleted'));

            await service.killIdleSandboxes();

            expect(leaseRepository.delete).toHaveBeenCalledWith('org:repo:1');
        });
    });
});
