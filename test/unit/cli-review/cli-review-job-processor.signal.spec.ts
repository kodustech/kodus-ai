/**
 * Mirrors webhook-processing-job.processor.spec.ts: validates that
 * CliReviewJobProcessorService honors `AbortSignal` aborted AFTER the
 * inner use-case starts. PR #1 wired signal through the contract, but
 * the processor itself does not race the inner call — same gap pattern.
 */
import { CliReviewJobProcessorService } from '@libs/cli-review/workflow/cli-review-job-processor.service';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { IWorkflowJobRepository } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { ExecuteCliReviewUseCase } from '@libs/cli-review/application/use-cases/execute-cli-review.use-case';

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
        id: 'job-cli-1',
        correlationId: 'corr_cli',
        status: JobStatus.PENDING,
        payload: {
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            input: { foo: 'bar' },
        },
    };
}

describe('CliReviewJobProcessorService — AbortSignal propagation', () => {
    let processor: CliReviewJobProcessorService;
    let useCaseExecute: jest.Mock;

    const mockJobRepository = {
        findOne: jest.fn(),
        update: jest.fn(),
    } as unknown as jest.Mocked<IWorkflowJobRepository>;

    beforeEach(() => {
        jest.clearAllMocks();
        useCaseExecute = jest.fn(() => new Promise<void>(() => {}));
        const mockUseCase = {
            execute: useCaseExecute,
        } as unknown as ExecuteCliReviewUseCase;

        processor = new CliReviewJobProcessorService(
            mockJobRepository,
            mockUseCase,
            { check: jest.fn().mockResolvedValue(undefined) } as any,
        );

        (mockJobRepository.findOne as jest.Mock).mockResolvedValue(makeJob());
        (mockJobRepository.update as jest.Mock).mockResolvedValue(undefined);
    });

    it('signal aborted AFTER use-case starts must short-circuit the processor', async () => {
        const controller = new AbortController();
        const work = processor.process('job-cli-1', controller.signal);

        await new Promise((r) => setTimeout(r, 20));
        expect(useCaseExecute).toHaveBeenCalledTimes(1);

        controller.abort();

        const winner = await whoWins(work, TIMER_BUDGET_MS);
        expect(winner).toBe('work');
    });

    it('contract check: signal aborted BEFORE start short-circuits', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            processor.process('job-cli-1', controller.signal),
        ).rejects.toThrow(/aborted before start/);

        expect(useCaseExecute).not.toHaveBeenCalled();
    });
});
