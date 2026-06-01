/**
 * Validates AbortSignal propagation in ImplementationVerificationProcessor.
 * Same pattern as the other processor signal-spec files: the processor
 * receives `signal` from the router but does not race the inner work
 * against it. Mock the first awaited dependency to never-resolve and
 * watch the processor stay pending despite an `abort()`.
 */
import { ImplementationVerificationProcessor } from '@libs/code-review/workflow/implementation-verification.processor';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';

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
        id: 'job-iv-1',
        correlationId: 'corr_iv',
        status: JobStatus.PENDING,
        workflowType: WorkflowType.CHECK_SUGGESTION_IMPLEMENTATION,
        payload: {
            pullRequestNumber: 1,
            repository: { id: 'r' },
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
        },
    };
}

describe('ImplementationVerificationProcessor — AbortSignal propagation', () => {
    let processor: ImplementationVerificationProcessor;
    let pullRequestsFindOne: jest.Mock;

    const jobRepo = { findOne: jest.fn(), update: jest.fn() };
    const suggestionService = {};
    const pullRequestManagerService = {};
    const automationExecutionService = {};
    const teamAutomationService = {};

    beforeEach(() => {
        jest.clearAllMocks();
        // First long await inside the processor's try block:
        //   const savedPr = await this.pullRequestsService.findOne(...)
        pullRequestsFindOne = jest.fn(() => new Promise(() => {}));
        const pullRequestsService = { findOne: pullRequestsFindOne };

        processor = new ImplementationVerificationProcessor(
            suggestionService as any,
            jobRepo as any,
            pullRequestsService as any,
            pullRequestManagerService as any,
            automationExecutionService as any,
            teamAutomationService as any,
        );

        jobRepo.findOne.mockResolvedValue(makeJob());
        jobRepo.update.mockResolvedValue(undefined);
    });

    it('signal aborted AFTER work starts must short-circuit the processor', async () => {
        const controller = new AbortController();
        const work = processor.process('job-iv-1', controller.signal);

        await new Promise((r) => setTimeout(r, 20));
        expect(pullRequestsFindOne).toHaveBeenCalledTimes(1);

        controller.abort();

        const winner = await whoWins(work, TIMER_BUDGET_MS);
        expect(winner).toBe('work');
    });

    it('contract check: signal aborted BEFORE start short-circuits', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            processor.process('job-iv-1', controller.signal),
        ).rejects.toThrow(/aborted before start/);

        expect(pullRequestsFindOne).not.toHaveBeenCalled();
    });
});
