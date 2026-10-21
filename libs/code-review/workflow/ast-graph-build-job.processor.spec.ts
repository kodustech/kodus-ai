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
        run: jest.fn().mockResolvedValue({ stdout: 'abc123\n', stderr: '', exitCode: 0 }),
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
    };

    const codeManagementService = {
        getCloneParams: jest.fn().mockResolvedValue({
            url: 'https://x/r.git',
            auth: { token: 'tok', username: 'x-access-token' },
        }),
    };

    const graphIndexer = {
        fullBuild: jest.fn().mockResolvedValue(undefined),
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
        );
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

        expect(sandbox.cleanup).toHaveBeenCalledTimes(1);
    });

    it('still cleans up the leased sandbox when the build fails after acquire', async () => {
        graphIndexer.fullBuild.mockRejectedValue(new Error('boom'));

        await processor.process('job-1');

        expect(sandbox.cleanup).toHaveBeenCalledTimes(1);
    });
});
