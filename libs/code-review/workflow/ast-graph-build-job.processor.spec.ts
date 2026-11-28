import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { RecordedJobFailure } from '@libs/core/workflow/domain/errors/recorded-job-failure.error';
import { StaleGraphJobError } from '@libs/code-review/domain/graph-job-attempt';
import { GraphJobSandbox } from './graph-job-sandbox';
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

import { AstGraphBuildJobProcessor } from './ast-graph-build-job.processor';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

// This session found the production bug this pins: a worker crash between
// createSandboxWithRepo() and the finally-block cleanup left an untracked
// E2B sandbox that no lease/reaper cron could ever find (no Mongo doc
// referenced it at all). The fix routes creation through the lease manager
// with a job-unique prKey, so a crash mid-build still leaves a lease doc the
// existing 30min TTL + 5min reaper cron cleans up on its own.
describe('AstGraphBuildJobProcessor — sandbox creation via lease manager', () => {
    let processor: AstGraphBuildJobProcessor;

    const jobRepository = {
        findOne: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
    };

    const sandbox = {
        repoDir: '/home/user/repo',
        sandboxId: 'sbx-1',
        type: 'e2b',
        cleanup: jest.fn().mockResolvedValue(undefined),
        run: jest
            .fn()
            .mockResolvedValue({ stdout: 'abc123\n', stderr: '', exitCode: 0 }),
    };

    const leaseManager = {
        acquire: jest.fn().mockResolvedValue({
            sandbox,
            leaseId: 'lease-1',
            sandboxId: 'sbx-1',
            wasCreated: true,
        }),
        release: jest.fn(),
        invalidate: jest.fn(),
        retireSingleUseCheckout: jest.fn(),
    };

    const codeManagementService = {
        getCloneParams: jest.fn().mockResolvedValue({
            url: 'https://x/r.git',
            auth: { token: 'tok', username: 'x-access-token' },
        }),
    };

    const graphIndexer = {
        failBuildForAttempt: jest.fn(),
        fullBuild: jest.fn().mockResolvedValue(undefined),
    };

    const repositoryService = {
        findById: jest.fn().mockResolvedValue({
            externalId: 'ext-1',
            defaultBranch: 'main',
            fullName: 'org/repo',
        }),
        updateGraphStatus: jest.fn().mockResolvedValue(undefined),
        clearMergeDeferredDuringBuild: jest.fn().mockResolvedValue(undefined),
    };
    const jobQueue = { enqueue: jest.fn() };

    const job = {
        id: 'job-1',
        correlationId: 'corr-1',
        status: JobStatus.PENDING,
        payload: {
            repositoryId: 'repo-1',
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
        sandbox.run.mockResolvedValue({
            stdout: 'abc123\n',
            stderr: '',
            exitCode: 0,
        });
        leaseManager.acquire.mockResolvedValue({
            sandbox,
            leaseId: 'lease-1',
            sandboxId: 'sbx-1',
            wasCreated: true,
        });
        codeManagementService.getCloneParams.mockResolvedValue({
            url: 'https://x/r.git',
            auth: { token: 'tok', username: 'x-access-token' },
        });
        graphIndexer.fullBuild.mockResolvedValue(undefined);
        repositoryService.findById.mockResolvedValue({
            externalId: 'ext-1',
            defaultBranch: 'main',
            fullName: 'org/repo',
        });

        processor = new AstGraphBuildJobProcessor(
            jobRepository as any,
            leaseManager as any,
            codeManagementService as any,
            graphIndexer as any,
            repositoryService as any,
            new GraphJobSandbox(),
            jobQueue as any,
        );
    });

    it('queues the catch-up for a deferred merge before completing the job', async () => {
        graphIndexer.fullBuild.mockResolvedValueOnce('unknown:1');
        const completed = () =>
            jobRepository.update.mock.calls.some(
                ([, data]) => data?.status === JobStatus.COMPLETED,
            );
        jobQueue.enqueue.mockImplementationOnce(async () => {
            expect(completed()).toBe(false);
            return 'catch-up';
        });

        await processor.process('job-1');

        expect(jobQueue.enqueue).toHaveBeenCalledTimes(1);
        expect(jobQueue.enqueue.mock.calls[0][0]).toEqual({
            workflowType: 'AST_GRAPH_INCREMENTAL',
            handlerType: 'SIMPLE_FUNCTION',
            correlationId: 'repo-1',
            payload: {
                repositoryId: 'repo-1',
                changedFiles: [],
                newSha: undefined,
                cloneUrl: '',
                defaultBranch: 'main',
                fullName: 'org/repo',
                platform: 'GITHUB',
                organizationAndTeamData: {
                    organizationId: 'org-uuid',
                    teamId: 'team-1',
                },
            },
            status: JobStatus.PENDING,
            priority: 0,
            retryCount: 0,
            maxRetries: 3,
        });
        expect(
            repositoryService.clearMergeDeferredDuringBuild,
        ).toHaveBeenCalledWith('repo-1', 'unknown:1');
        expect(completed()).toBe(true);
    });

    it('acquires the sandbox through the lease manager with a job-unique prKey', async () => {
        await processor.process('job-1');

        expect(leaseManager.acquire).toHaveBeenCalledTimes(1);
        const [prKey, consumer, ttl, cloneParams] =
            leaseManager.acquire.mock.calls[0];

        expect(prKey).toBe('org-uuid:repo-1:graph:job-1');
        expect(consumer).toBe('graph-build');
        // Explicit, well past the lease manager's own 30-min default: a
        // full-repo AST build can legitimately run long, and the reaper
        // kills any lease past its expiresAt regardless of leaseCount, so
        // the default would kill an actively building sandbox mid-index.
        expect(ttl).toBe(2 * 60 * 60 * 1000);
        expect(cloneParams).toMatchObject({
            cloneUrl: 'https://x/r.git',
            authToken: 'tok',
            authUsername: 'x-access-token',
            branch: 'main',
            sandboxMetadata: { stage: 'graph-build' },
        });
    });

    it('cleans up the leased sandbox on completion', async () => {
        await processor.process('job-1');

        // Single-use graph sandbox: the final release stops compute now,
        // instead of leaving it warm for the 5-minute default (#2626).
        expect(leaseManager.release).toHaveBeenCalledWith('lease-1', {
            idleMs: 0,
        });
        expect(sandbox.cleanup).not.toHaveBeenCalled();
    });

    it('still cleans up the leased sandbox when the build fails after acquire', async () => {
        graphIndexer.fullBuild.mockRejectedValue(new Error('boom'));

        await processor.process('job-1');

        // Single-use graph sandbox: the final release stops compute now,
        // instead of leaving it warm for the 5-minute default (#2626).
        expect(leaseManager.release).toHaveBeenCalledWith('lease-1', {
            idleMs: 0,
        });
        expect(sandbox.cleanup).not.toHaveBeenCalled();
    });

    it.each([
        [
            'invalid parser output quoting 503 timeout ECONNRESET',
            ErrorClassification.PERMANENT,
            'Repository graph build failed',
        ],
        [
            'ECONNRESET',
            ErrorClassification.RETRYABLE,
            'Repository graph build failed temporarily',
        ],
    ])(
        'keeps provider details out of the stored and rethrown %s error',
        async (reason, classification, message) => {
            graphIndexer.fullBuild.mockRejectedValueOnce(
                Object.assign(
                    new Error(`${reason}: private-provider-query`),
                    reason === 'ECONNRESET'
                        ? { cause: { code: 'ECONNRESET' } }
                        : {},
                ),
            );
            const result = processor.process('job-1');
            if (classification === ErrorClassification.RETRYABLE) {
                await expect(result).rejects.toBeInstanceOf(RecordedJobFailure);
                await expect(result).rejects.toMatchObject({ message });
            } else {
                await result;
            }
            const attemptId =
                jobRepository.update.mock.calls[0][1].metadata.attemptId;
            expect(jobRepository.update).toHaveBeenLastCalledWith(
                'job-1',
                {
                    status: JobStatus.FAILED,
                    errorClassification: classification,
                    lastError: message,
                    completedAt: expect.any(Date),
                    currentStage: 'FAILED',
                    metadata: {
                        attemptId,
                        sandboxId: 'sbx-1',
                        stage: 'FAILED',
                    },
                },
                [JobStatus.PROCESSING, JobStatus.FAILED],
                attemptId,
            );
        },
    );

    it('replaces a stale joined checkout within the same delivery', async () => {
        leaseManager.acquire.mockResolvedValueOnce({
            sandbox,
            leaseId: 'reused',
            sandboxId: 'existing',
            wasCreated: false,
        });
        await processor.process('job-1');
        expect(leaseManager.retireSingleUseCheckout).toHaveBeenCalledWith(
            'org-uuid:repo-1:graph:job-1',
            'existing',
        );
        expect(leaseManager.release.mock.calls.map(([id]) => id)).toEqual([
            'reused',
            'lease-1',
        ]);
        expect(graphIndexer.fullBuild).toHaveBeenCalledTimes(1);
    });

    it('bounds stale checkout replacements per delivery', async () => {
        const joined = {
            sandbox,
            leaseId: 'reused',
            sandboxId: 'existing',
            wasCreated: false,
        };
        leaseManager.acquire
            .mockResolvedValueOnce(joined)
            .mockResolvedValueOnce(joined);
        await expect(processor.process('job-1')).rejects.toBeInstanceOf(
            RecordedJobFailure,
        );
        expect(leaseManager.acquire).toHaveBeenCalledTimes(2);
        expect(graphIndexer.fullBuild).not.toHaveBeenCalled();
    });

    // The build runs clone + many /contents reads + indexing, any of which
    // can stall on a retry-after; without the race the worker slot stayed
    // held past the router timeout.
    describe('AbortSignal', () => {
        it('keeps FAILED when indexing returns after cancellation', async () => {
            let finishIndexing: () => void;
            const indexing = new Promise<void>((started) => {
                graphIndexer.fullBuild.mockImplementationOnce(
                    () =>
                        new Promise<void>((finish) => {
                            finishIndexing = finish;
                            started();
                        }),
                );
            });
            const controller = new AbortController();
            const job = processor.process('job-1', controller.signal);
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
            expect(graphIndexer.fullBuild).toHaveBeenCalledWith(
                expect.objectContaining({ signal: controller.signal }),
            );
            expect(leaseManager.release).toHaveBeenCalledTimes(1);
        });

        it('fails promptly if cancellation arrives during the completion write', async () => {
            let finishCompletion: () => void;
            let persisted = JobStatus.PENDING;
            const writing = new Promise<void>((started) => {
                jobRepository.update.mockImplementation(
                    async (_id, patch, expected) => {
                        if (patch.status === JobStatus.COMPLETED) {
                            await new Promise<void>((finish) => {
                                finishCompletion = finish;
                                started();
                            });
                        }
                        if (
                            patch.status &&
                            (!expected || [expected].flat().includes(persisted))
                        )
                            persisted = patch.status;
                    },
                );
            });
            const controller = new AbortController();
            const job = processor.process('job-1', controller.signal);
            await writing;
            controller.abort();
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(persisted).toBe(JobStatus.FAILED);
            finishCompletion();
            await job;
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(persisted).toBe(JobStatus.FAILED);
        });

        it('leaves a replacement attempt running when the graph write loses ownership', async () => {
            graphIndexer.fullBuild.mockRejectedValueOnce(
                new StaleGraphJobError('job-1'),
            );
            await processor.process('job-1');
            expect(
                jobRepository.update.mock.calls.map(
                    ([, patch]) => patch.status,
                ),
            ).not.toContain(JobStatus.FAILED);
            expect(graphIndexer.failBuildForAttempt).not.toHaveBeenCalled();
            expect(leaseManager.release).toHaveBeenCalledTimes(1);
        });

        it('only lets a processing job write its completion', async () => {
            await processor.process('job-1');
            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({ status: JobStatus.COMPLETED }),
                JobStatus.PROCESSING,
                expect.any(String),
            );
        });

        it('unblocks when the signal fires mid-work', async () => {
            repositoryService.findById.mockImplementation(
                () => new Promise(() => {}),
            );
            const controller = new AbortController();
            const work = processor.process('job-1', controller.signal);

            await new Promise((r) => setTimeout(r, 20));
            expect(repositoryService.findById).toHaveBeenCalledTimes(1);

            controller.abort();

            await expect(work).resolves.toBeUndefined();
        });

        it('does not start when the signal is already aborted', async () => {
            const controller = new AbortController();
            controller.abort();

            await expect(
                processor.process('job-1', controller.signal),
            ).rejects.toThrow(/aborted before start/);
            expect(repositoryService.findById).not.toHaveBeenCalled();
        });
    });
});
