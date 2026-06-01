/**
 * Validates AbortSignal propagation in AstGraphIncrementalJobProcessor.
 */
import { AstGraphIncrementalJobProcessor } from '@libs/code-review/workflow/ast-graph-incremental-job.processor';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const TIMER_BUDGET_MS = 200;

async function whoWins(
    work: Promise<unknown>,
    timeoutMs: number,
): Promise<'work' | 'timer'> {
    let t: ReturnType<typeof setTimeout> | undefined;
    const timer = new Promise<'timer'>((resolve) => {
        t = setTimeout(() => resolve('timer'), timeoutMs);
    });
    const result = (await Promise.race([
        work.then(
            () => 'work',
            () => 'work',
        ),
        timer,
    ])) as 'work' | 'timer';
    if (t) clearTimeout(t);
    return result;
}

function makeJob() {
    return {
        id: 'job-ast-incr-1',
        correlationId: 'corr_ast_incr',
        status: JobStatus.PENDING,
        payload: {
            repositoryId: 'r',
            changedFiles: ['a.ts'],
            newSha: 'sha123',
            cloneUrl: 'https://x/r.git',
            defaultBranch: 'main',
            fullName: 'org/r',
            platform: 'GITHUB',
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        },
    };
}

describe('AstGraphIncrementalJobProcessor — AbortSignal propagation', () => {
    let processor: AstGraphIncrementalJobProcessor;
    let repositoryFindById: jest.Mock;

    const jobRepo = { findOne: jest.fn(), update: jest.fn() };
    const sandboxProvider = {};
    const codeManagementService = {};
    const graphIndexer = {};

    beforeEach(() => {
        jest.clearAllMocks();
        repositoryFindById = jest.fn(() => new Promise(() => {}));
        const repositoryService = { findById: repositoryFindById };

        processor = new AstGraphIncrementalJobProcessor(
            jobRepo as any,
            sandboxProvider as any,
            codeManagementService as any,
            graphIndexer as any,
            repositoryService as any,
        );

        jobRepo.findOne.mockResolvedValue(makeJob());
        jobRepo.update.mockResolvedValue(undefined);
    });

    it('signal aborted AFTER work starts must short-circuit the processor', async () => {
        const controller = new AbortController();
        const work = processor.process('job-ast-incr-1', controller.signal);

        await new Promise((r) => setTimeout(r, 20));
        expect(repositoryFindById).toHaveBeenCalledTimes(1);

        controller.abort();

        const winner = await whoWins(work, TIMER_BUDGET_MS);
        expect(winner).toBe('work');
    });

    it('contract check: signal aborted BEFORE start short-circuits', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            processor.process('job-ast-incr-1', controller.signal),
        ).rejects.toThrow(/aborted before start/);

        expect(repositoryFindById).not.toHaveBeenCalled();
    });
});
