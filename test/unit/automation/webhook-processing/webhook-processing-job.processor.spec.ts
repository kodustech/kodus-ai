/**
 * Documents the bug in WebhookProcessingJobProcessorService where the
 * `AbortSignal` passed by JobProcessorRouterService is only consulted ONCE
 * (before the handler starts) and is never propagated into the work that
 * actually blocks — `handler.execute(webhookParams)`. When that work
 * stalls in `octokit` waiting on a GitHub `retry-after` (up to ~1h on an
 * exhausted installation bucket), aborting the signal has no effect:
 * the processor stays pending, the worker slot stays held, and the
 * RabbitMQ delivery stays unacked until the underlying request finally
 * resolves.
 *
 * Test strategy (red → green):
 *   1) Mock the GitHub handler so `execute()` returns a promise that
 *      never resolves on its own — same observable behavior as octokit
 *      sleeping in retry-after.
 *   2) Start `processor.process(jobId, signal)`.
 *   3) Abort the signal a few ms later.
 *   4) Race the processor promise against a short timer. If the
 *      processor honors the signal, it loses the race against the
 *      timer (rejects fast). If it ignores the signal, the timer wins.
 *
 * Today (no fix): the timer wins → test below marked `BUG` passes.
 * After fix (raceWithAbortSignal at the handler call site): the processor
 * loses the race → test marked `FIX` passes.
 */
import { WebhookProcessingJobProcessorService } from '@libs/automation/webhook-processing/webhook-processing-job.processor';
import { WorkflowType } from '@libs/core/workflow/domain/enums/workflow-type.enum';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';
import { ErrorClassification } from '@libs/core/workflow/domain/enums/error-classification.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { IWebhookEventHandler } from '@libs/platform/domain/platformIntegrations/interfaces/webhook-event-handler.interface';
import { IWorkflowJobRepository } from '@libs/core/workflow/domain/contracts/workflow-job.repository.contract';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

const TIMER_BUDGET_MS = 200;

function neverResolvingHandler(): {
    handler: IWebhookEventHandler;
    executeCalled: jest.Mock;
} {
    const executeCalled = jest.fn(
        () =>
            new Promise<void>(() => {
                /* never resolves — mimics octokit sleeping retry-after */
            }),
    );
    return {
        executeCalled,
        handler: {
            canHandle: jest.fn().mockReturnValue(true),
            execute: executeCalled as unknown as IWebhookEventHandler['execute'],
        },
    };
}

function makeJob() {
    return {
        id: 'job-webhook-1',
        workflowType: WorkflowType.WEBHOOK_PROCESSING,
        status: JobStatus.PENDING,
        correlationId: 'corr_test',
        payload: { whatever: true },
        metadata: {
            platformType: PlatformType.GITHUB,
            event: 'pull_request',
        },
    };
}

/**
 * Promise.race wrapper that resolves with `'work'` if `work` wins, or
 * `'timer'` if the timer wins. Used to detect whether the processor
 * actually unblocked on signal abort or not — never throws so we can
 * inspect either outcome inside `expect()`.
 */
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

describe('WebhookProcessingJobProcessorService — AbortSignal propagation', () => {
    let processor: WebhookProcessingJobProcessorService;
    let executeCalled: jest.Mock;

    const mockJobRepository = {
        findOne: jest.fn(),
        update: jest.fn(),
    };

    const otherHandlers = {
        gitlab: { canHandle: jest.fn(), execute: jest.fn() },
        bitbucket: { canHandle: jest.fn(), execute: jest.fn() },
        azure: { canHandle: jest.fn(), execute: jest.fn() },
        forgejo: { canHandle: jest.fn(), execute: jest.fn() },
    };

    beforeEach(() => {
        jest.clearAllMocks();
        const { handler, executeCalled: ec } = neverResolvingHandler();
        executeCalled = ec;

        // Manual instantiation avoids dragging in nestjs DI (the processor's
        // constructor expects 6 handler tokens plus a couple of optional
        // collaborators that we don't need to faithfully reproduce here).
        processor = new WebhookProcessingJobProcessorService(
            mockJobRepository as unknown as IWorkflowJobRepository,
            handler,
            otherHandlers.gitlab as unknown as IWebhookEventHandler,
            otherHandlers.bitbucket as unknown as IWebhookEventHandler,
            otherHandlers.azure as unknown as IWebhookEventHandler,
            otherHandlers.forgejo as unknown as IWebhookEventHandler,
        );

        mockJobRepository.findOne.mockResolvedValue(makeJob());
        mockJobRepository.update.mockResolvedValue(undefined);
    });

    it('signal aborted AFTER handler.execute() starts must short-circuit the processor', async () => {
        const controller = new AbortController();
        const work = processor.process('job-webhook-1', controller.signal);

        // Let the processor reach the `await handler.execute(...)` line.
        await new Promise((r) => setTimeout(r, 20));
        expect(executeCalled).toHaveBeenCalledTimes(1);

        // Abort AFTER handler.execute started. The processor MUST react —
        // the never-resolving handler simulates octokit sleeping retry-after
        // for ~1h, so if the processor doesn't honor the signal, the worker
        // slot is stuck for the full sleep window even though the router
        // timeout already fired.
        controller.abort();

        // Race the processor against a short timer. The processor must
        // unblock (lose against the timer) — if the timer wins, the bug
        // is still present: the work promise stays pending.
        const winner = await whoWins(work, TIMER_BUDGET_MS);

        expect(winner).toBe('work');
    });

    it('contract check: signal aborted BEFORE start short-circuits (already working)', async () => {
        const controller = new AbortController();
        controller.abort();

        await expect(
            processor.process('job-webhook-1', controller.signal),
        ).rejects.toThrow(/aborted before start/);

        // Handler should never be reached.
        expect(executeCalled).not.toHaveBeenCalled();
    });
});

/**
 * Regression coverage for "fix(github): fail fast + requeue on rate limit
 * instead of sleeping silently" (PR #1658, 2026-08-05): before this fix,
 * ANY error from the GitHub handler — including a rate limit — marked the
 * job PERMANENT, which DLQ's it (no retry). The whole point of the fix is
 * that a rate-limit-shaped error must instead be classified RATE_LIMITED
 * and rethrown as the typed RateLimitError, so RabbitMQErrorHandler
 * requeues it with a reset-aligned delay instead of dropping the review on
 * the floor. classify-github-error.spec.ts (test/unit/core/workflow/errors)
 * already pins the pure classifier; this pins that
 * WebhookProcessingJobProcessorService actually USES it — the wiring that
 * had zero coverage, and the actual point of the incident (the review was
 * "silently LOST", not "the classifier returned the wrong type").
 */
describe('WebhookProcessingJobProcessorService — rate-limit classification wiring', () => {
    let processor: WebhookProcessingJobProcessorService;

    const mockJobRepository = {
        findOne: jest.fn(),
        update: jest.fn(),
    };

    const otherHandlers = {
        gitlab: { canHandle: jest.fn(), execute: jest.fn() },
        bitbucket: { canHandle: jest.fn(), execute: jest.fn() },
        azure: { canHandle: jest.fn(), execute: jest.fn() },
        forgejo: { canHandle: jest.fn(), execute: jest.fn() },
    };

    function handlerRejectingWith(error: unknown): IWebhookEventHandler {
        return {
            canHandle: jest.fn().mockReturnValue(true),
            execute: jest.fn().mockRejectedValue(error),
        };
    }

    function githubRateLimitError() {
        const resetUnixSeconds = Math.floor(Date.now() / 1000) + 1800;
        return {
            status: 403,
            response: {
                headers: {
                    'x-ratelimit-remaining': '0',
                    'x-ratelimit-reset': String(resetUnixSeconds),
                },
            },
        };
    }

    beforeEach(() => {
        jest.clearAllMocks();
        mockJobRepository.findOne.mockResolvedValue(makeJob());
        mockJobRepository.update.mockResolvedValue(undefined);
    });

    it('marks the job RATE_LIMITED (not PERMANENT) and rethrows a RateLimitError on a rate-limit-shaped failure', async () => {
        processor = new WebhookProcessingJobProcessorService(
            mockJobRepository as unknown as IWorkflowJobRepository,
            handlerRejectingWith(githubRateLimitError()),
            otherHandlers.gitlab as unknown as IWebhookEventHandler,
            otherHandlers.bitbucket as unknown as IWebhookEventHandler,
            otherHandlers.azure as unknown as IWebhookEventHandler,
            otherHandlers.forgejo as unknown as IWebhookEventHandler,
        );

        await expect(
            processor.process('job-webhook-1'),
        ).rejects.toMatchObject({ name: 'RateLimitError' });

        expect(mockJobRepository.update).toHaveBeenCalledWith(
            'job-webhook-1',
            expect.objectContaining({
                status: JobStatus.FAILED,
                errorClassification: ErrorClassification.RATE_LIMITED,
            }),
        );
        // The PERMANENT path (DLQ, no retry) must NOT have been taken for a
        // rate limit — that is precisely the bug (review silently lost).
        expect(mockJobRepository.update).not.toHaveBeenCalledWith(
            'job-webhook-1',
            expect.objectContaining({ errorClassification: ErrorClassification.PERMANENT }),
        );
    });

    it('keeps a genuine (non-rate-limit) failure PERMANENT — the fix must not blanket-retry every error', async () => {
        processor = new WebhookProcessingJobProcessorService(
            mockJobRepository as unknown as IWorkflowJobRepository,
            handlerRejectingWith(new Error('Repository not found')),
            otherHandlers.gitlab as unknown as IWebhookEventHandler,
            otherHandlers.bitbucket as unknown as IWebhookEventHandler,
            otherHandlers.azure as unknown as IWebhookEventHandler,
            otherHandlers.forgejo as unknown as IWebhookEventHandler,
        );

        await expect(processor.process('job-webhook-1')).rejects.toThrow(
            'Repository not found',
        );

        expect(mockJobRepository.update).toHaveBeenCalledWith(
            'job-webhook-1',
            expect.objectContaining({
                status: JobStatus.FAILED,
                errorClassification: ErrorClassification.PERMANENT,
            }),
        );
    });
});
