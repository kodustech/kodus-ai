/**
 * Companion test to webhook-processing-job.processor.spec.ts. Validates
 * whether the SAME signal-propagation bug exists in CodeReviewJobProcessor.
 *
 * Hypothesis: yes. The processor passes `signal` into
 * `runCodeReviewAutomationUseCase.execute(..., signal)` (PR #1 wired it),
 * but the processor itself does not race the use case call against the
 * signal — so if any link of the LLM chain ignores the signal and stays
 * blocked (e.g. HTTP sleep, queued task in a custom executor, etc.), the
 * processor stays pending and the worker slot leaks. The same minimalist
 * fix that we applied to the webhook processor — wrap the inner call in
 * `raceWithAbortSignal` — closes the gap independently of how deep the
 * downstream chain is.
 */
import { CodeReviewJobProcessorService } from '@libs/code-review/workflow/code-review-job-processor.service';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { IWorkflowJobRepository } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';
import { RunCodeReviewAutomationUseCase } from '@libs/ee/automation/runCodeReview.use-case';
import { ByokConcurrencyGateService } from '@libs/code-review/workflow/byok-concurrency-gate.service';
import { NotificationService } from '@libs/notifications/application/notification.service';
import { PrAuthorRecipientResolver } from '@libs/notifications/application/pr-author-recipient.resolver';

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

function makeJob() {
    return {
        id: 'job-cr-1',
        correlationId: 'corr_cr_test',
        status: JobStatus.PENDING,
        payload: {
            codeManagementPayload: { number: 42 },
            event: 'pull_request',
            platformType: 'GITHUB',
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            teamAutomationId: 'ta',
        },
        metadata: {},
    };
}

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

describe('CodeReviewJobProcessorService — AbortSignal propagation', () => {
    let processor: CodeReviewJobProcessorService;
    let useCaseExecute: jest.Mock;

    const mockJobRepository: jest.Mocked<IWorkflowJobRepository> = {
        findOne: jest.fn(),
        update: jest.fn(),
        // unused below — type-tighten with `as any` if the contract grows
    } as unknown as jest.Mocked<IWorkflowJobRepository>;

    const mockByokGate: Partial<ByokConcurrencyGateService> = {
        tryEnter: jest.fn().mockResolvedValue({ kind: 'acquired', lock: null }),
        deferJob: jest.fn(),
    };

    const mockNotificationService = {
        notify: jest.fn(),
    } as unknown as NotificationService;

    const mockPrAuthorResolver = {
        resolve: jest.fn(),
    } as unknown as PrAuthorRecipientResolver;

    beforeEach(() => {
        jest.clearAllMocks();
        useCaseExecute = jest.fn(
            () =>
                new Promise<void>(() => {
                    /* never resolves — mimics LLM / octokit stuck on retry-after */
                }),
        );
        const mockUseCase = {
            execute: useCaseExecute,
        } as unknown as RunCodeReviewAutomationUseCase;

        processor = new CodeReviewJobProcessorService(
            mockJobRepository,
            mockUseCase,
            mockByokGate as ByokConcurrencyGateService,
            mockNotificationService,
            mockPrAuthorResolver,
            { check: jest.fn().mockResolvedValue(undefined) } as any,
        );

        (mockJobRepository.findOne as jest.Mock).mockResolvedValue(makeJob());
        (mockJobRepository.update as jest.Mock).mockResolvedValue(undefined);
    });

    it('signal aborted AFTER use-case starts must short-circuit the processor', async () => {
        const controller = new AbortController();
        const work = processor.process('job-cr-1', controller.signal);

        // Let the processor reach the `await runCodeReviewAutomationUseCase.execute(...)` line.
        await new Promise((r) => setTimeout(r, 20));
        expect(useCaseExecute).toHaveBeenCalledTimes(1);

        // Abort — simulates the 1h45min router timeout firing while
        // the LLM chain is sleeping on a GitHub retry-after.
        controller.abort();

        const winner = await whoWins(work, TIMER_BUDGET_MS);

        // Processor must unblock. If timer wins, the same bug we fixed
        // in the webhook processor is alive here too.
        expect(winner).toBe('work');
    });

    it('contract check: signal aborted BEFORE start short-circuits', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            processor.process('job-cr-1', controller.signal),
        ).rejects.toThrow(/aborted before start/);

        expect(useCaseExecute).not.toHaveBeenCalled();
    });
});
