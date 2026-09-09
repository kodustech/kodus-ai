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

        it('bumps the kill-retry counter on a real failure under the retry cap', async () => {
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

        // Without this cap, an outage that keeps Sandbox.kill failing pins
        // the lease doc forever: findExpired returns it every tick, with
        // unbounded kill fan-out and no reconciliation.
        it('force-deletes the lease once the kill-retry cap is exceeded, without bumping further', async () => {
            leaseRepository.findExpired.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    state: 'READY',
                    killRetryCount: 3,
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

        it('force-deletes the lease once the kill-retry cap is exceeded', async () => {
            leaseRepository.findReadyToKill.mockResolvedValue([
                {
                    _id: 'org:repo:1',
                    sandboxId: 'sbx-1',
                    killAt: new Date(),
                    killRetryCount: 3,
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
