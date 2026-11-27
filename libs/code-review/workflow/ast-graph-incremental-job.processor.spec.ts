jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { AstGraphIncrementalJobProcessor } from './ast-graph-incremental-job.processor';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

// Sibling of ast-graph-build-job.processor.spec.ts — pins the same
// crash-safety fix: sandbox creation goes through the lease manager (not the
// raw provider) so a worker crash mid-update leaves a lease doc the existing
// reaper cron can clean up, instead of an untracked, permanently-paused
// E2B sandbox.
describe('AstGraphIncrementalJobProcessor — sandbox creation via lease manager', () => {
    let processor: AstGraphIncrementalJobProcessor;

    const jobRepository = {
        findOne: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
    };

    const sandbox = {
        repoDir: '/home/user/repo',
        sandboxId: 'sbx-2',
        type: 'e2b',
        cleanup: jest.fn().mockResolvedValue(undefined),
    };

    const leaseManager = {
        acquire: jest.fn().mockResolvedValue({
            sandbox,
            leaseId: 'lease-2',
            sandboxId: 'sbx-2',
            wasCreated: true,
        }),
        release: jest.fn(),
        invalidate: jest.fn(),
    };

    const codeManagementService = {
        getCloneParams: jest.fn().mockResolvedValue({
            url: 'https://x/r.git',
            auth: { token: 'tok', username: 'x-access-token' },
        }),
    };

    const graphIndexer = {
        incrementalUpdate: jest.fn().mockResolvedValue(undefined),
    };

    const repositoryService = {
        findById: jest.fn().mockResolvedValue({
            externalId: 'ext-1',
            defaultBranch: 'main',
            fullName: 'org/repo',
        }),
        updateGraphStatus: jest.fn().mockResolvedValue(undefined),
    };

    const job = {
        id: 'job-2',
        correlationId: 'corr-2',
        status: JobStatus.PENDING,
        payload: {
            repositoryId: 'repo-1',
            changedFiles: ['src/a.ts'],
            newSha: 'sha123',
            cloneUrl: 'https://x/r.git',
            defaultBranch: 'main',
            fullName: 'org/repo',
            platform: 'GITHUB',
            organizationAndTeamData: {
                organizationId: 'org-uuid',
                teamId: 'team-1',
            },
        },
    };

    beforeEach(() => {
        jest.clearAllMocks();
        jobRepository.findOne.mockResolvedValue(job);
        jobRepository.update.mockResolvedValue(undefined);
        sandbox.cleanup.mockResolvedValue(undefined);
        leaseManager.acquire.mockResolvedValue({
            sandbox,
            leaseId: 'lease-2',
            sandboxId: 'sbx-2',
            wasCreated: true,
        });
        codeManagementService.getCloneParams.mockResolvedValue({
            url: 'https://x/r.git',
            auth: { token: 'tok', username: 'x-access-token' },
        });
        graphIndexer.incrementalUpdate.mockResolvedValue(undefined);
        repositoryService.findById.mockResolvedValue({
            externalId: 'ext-1',
            defaultBranch: 'main',
            fullName: 'org/repo',
        });

        processor = new AstGraphIncrementalJobProcessor(
            jobRepository as any,
            leaseManager as any,
            codeManagementService as any,
            graphIndexer as any,
            repositoryService as any,
        );
    });

    it('acquires the sandbox through the lease manager with a job-unique prKey', async () => {
        await processor.process('job-2');

        expect(leaseManager.acquire).toHaveBeenCalledTimes(1);
        const [prKey, consumer, ttl, cloneParams] =
            leaseManager.acquire.mock.calls[0];

        expect(prKey).toBe('org-uuid:repo-1:graph:job-2');
        expect(consumer).toBe('graph-incremental');
        // Explicit, well past the lease manager's own 30-min default: an
        // incremental AST update on a large changeset can legitimately run
        // long, and the reaper kills any lease past its expiresAt
        // regardless of leaseCount, so the default would kill an actively
        // updating sandbox mid-index.
        expect(ttl).toBe(2 * 60 * 60 * 1000);
        expect(cloneParams).toMatchObject({
            cloneUrl: 'https://x/r.git',
            authToken: 'tok',
            authUsername: 'x-access-token',
            branch: 'main',
            sandboxMetadata: { stage: 'graph-incremental' },
        });
    });

    it('cleans up the leased sandbox on completion', async () => {
        await processor.process('job-2');

        // Single-use graph sandbox: the final release stops compute now,
        // instead of leaving it warm for the 5-minute default (#2626).
        expect(leaseManager.release).toHaveBeenCalledWith('lease-2', {
            idleMs: 0,
        });
        expect(sandbox.cleanup).not.toHaveBeenCalled();
    });

    it('still cleans up the leased sandbox when the update fails after acquire', async () => {
        graphIndexer.incrementalUpdate.mockRejectedValue(new Error('boom'));

        await processor.process('job-2');

        // Single-use graph sandbox: the final release stops compute now,
        // instead of leaving it warm for the 5-minute default (#2626).
        expect(leaseManager.release).toHaveBeenCalledWith('lease-2', {
            idleMs: 0,
        });
        expect(sandbox.cleanup).not.toHaveBeenCalled();
    });

    // The build runs clone + many /contents reads + indexing, any of which
    // can stall on a retry-after; without the race the worker slot stayed
    // held past the router timeout.
    describe('AbortSignal', () => {
        it('keeps FAILED when indexing returns after cancellation', async () => {
            let finishIndexing: () => void;
            const indexing = new Promise<void>((started) => {
                graphIndexer.incrementalUpdate.mockImplementationOnce(
                    () =>
                        new Promise<void>((finish) => {
                            finishIndexing = finish;
                            started();
                        }),
                );
            });
            const controller = new AbortController();
            const job = processor.process('job-2', controller.signal);
            await indexing;
            controller.abort();
            await job;
            finishIndexing();
            await new Promise<void>((resolve) => setImmediate(resolve));

            const statuses = jobRepository.update.mock.calls.map(
                ([, update]) => update.status,
            );
            expect(statuses.at(-1)).toBe(JobStatus.FAILED);
            expect(statuses).not.toContain(JobStatus.COMPLETED);
            expect(graphIndexer.incrementalUpdate).toHaveBeenCalledWith(
                expect.objectContaining({ signal: controller.signal }),
            );
            expect(leaseManager.release).toHaveBeenCalledTimes(1);
        });

        it('fails promptly if cancellation arrives during the completion write', async () => {
            let finishCompletion: () => void;
            const writing = new Promise<void>((started) => {
                jobRepository.update.mockImplementation(async (_id, patch) => {
                    if (patch.status === JobStatus.COMPLETED) {
                        await new Promise<void>((finish) => {
                            finishCompletion = finish;
                            started();
                        });
                    }
                });
            });
            const controller = new AbortController();
            const job = processor.process('job-2', controller.signal);
            await writing;
            controller.abort();
            await new Promise<void>((resolve) => setImmediate(resolve));
            const terminal = jobRepository.update.mock.calls.at(-1)[1].status;
            finishCompletion();
            await job;
            expect(terminal).toBe(JobStatus.FAILED);
        });

        it('only lets a processing job write its completion', async () => {
            await processor.process('job-2');
            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-2',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
                JobStatus.PROCESSING,
            );
        });

        it('unblocks when the signal fires mid-work', async () => {
            repositoryService.findById.mockImplementation(
                () => new Promise(() => {}),
            );
            const controller = new AbortController();
            const work = processor.process('job-2', controller.signal);

            await new Promise((r) => setTimeout(r, 20));
            expect(repositoryService.findById).toHaveBeenCalledTimes(1);

            controller.abort();

            await expect(work).resolves.toBeUndefined();
        });

        it('does not start when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                processor.process('job-2', controller.signal),
            ).rejects.toThrow(/aborted before start/);
            expect(repositoryService.findById).not.toHaveBeenCalled();
        });
    });
});
