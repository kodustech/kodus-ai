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

        expect(sandbox.cleanup).toHaveBeenCalledTimes(1);
    });

    it('still cleans up the leased sandbox when the update fails after acquire', async () => {
        graphIndexer.incrementalUpdate.mockRejectedValue(new Error('boom'));

        await processor.process('job-2');

        expect(sandbox.cleanup).toHaveBeenCalledTimes(1);
    });
});
