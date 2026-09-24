import { CodeReviewJobProcessorService } from './code-review-job-processor.service';

/**
 * Tell the author once, and do not stop telling them because of a crash.
 *
 * `process()` does not check job status on entry, so a redelivery — a broker
 * retry, or the stale-job reaper picking the row back up — runs the exhausted
 * branch again. `notifyReviewFailed` reaches the pull request author, so a
 * repeat is visible to a customer.
 *
 * Gating that on `status === FAILED` looked like the fix and was a trap:
 * `handleFailure` writes that status whether or not anyone was ever told. A
 * crash between the two, or a notify that failed inside its own catch, leaves
 * the job FAILED forever and every later attempt skips the notice — which is
 * the "review failed and nobody was told" defect this branch exists to
 * prevent, reintroduced by its own guard.
 *
 * The marker therefore records the NOTIFICATION, and lives somewhere the
 * failure path does not write.
 */
const jobRow = (over: Record<string, unknown>) => ({
    id: 'job-1',
    correlationId: 'corr-1',
    status: 'pending',
    metadata: {},
    payload: {
        codeManagementPayload: {},
        event: 'opened',
        platformType: 'github',
        organizationAndTeamData: { organizationId: 'org-1', teamId: 't-1' },
        teamAutomationId: 'ta-1',
    },
    ...over,
});

const makeService = (persistedJob: Record<string, unknown>) => {
    const jobRepository = {
        // `process(jobId)` loads the row itself, so this IS the job under test.
        findOne: jest.fn().mockResolvedValue(persistedJob),
        update: jest.fn().mockResolvedValue(undefined),
    };

    const service = Object.create(
        CodeReviewJobProcessorService.prototype,
    ) as CodeReviewJobProcessorService;

    const notifyReviewFailed = jest.fn().mockResolvedValue(undefined);
    const handleFailure = jest.fn().mockResolvedValue(undefined);

    Object.assign(service, {
        jobRepository,
        logger: {
            log: jest.fn(),
            warn: jest.fn(),
            error: jest.fn(),
            debug: jest.fn(),
        },
        rateLimitGate: { check: jest.fn().mockResolvedValue(undefined) },
        byokConcurrencyGateService: {
            tryEnter: jest
                .fn()
                .mockResolvedValue({ kind: 'exhausted', deferredCount: 452 }),
            deferJob: jest.fn(),
        },
        metricsCollector: { recordCounter: jest.fn() },
    });

    (service as never as { notifyReviewFailed: unknown }).notifyReviewFailed =
        notifyReviewFailed;
    (service as never as { handleFailure: unknown }).handleFailure =
        handleFailure;

    return { service, jobRepository, notifyReviewFailed, handleFailure };
};

const run = (service: CodeReviewJobProcessorService) =>
    (service as never as {
        process: (jobId: string) => Promise<unknown>;
    }).process('job-1');

describe('CodeReviewJobProcessorService — reporting an exhausted BYOK slot', () => {
    it('tells the author and records that it did', async () => {
        const { service, notifyReviewFailed, jobRepository, handleFailure } =
            makeService(jobRow({ metadata: { existing: true } }));

        await run(service);

        expect(handleFailure).toHaveBeenCalledTimes(1);
        expect(notifyReviewFailed).toHaveBeenCalledTimes(1);

        const marker = jobRepository.update.mock.calls.at(-1)?.[1] as {
            metadata: Record<string, any>;
        };
        expect(marker.metadata.byokSlotExhausted.notifiedAt).toEqual(
            expect.any(String),
        );
        // Existing metadata survives the marker write.
        expect(marker.metadata.existing).toBe(true);
    });

    it('does not tell the author twice on a redelivery', async () => {
        const { service, notifyReviewFailed } = makeService(
            jobRow({
                status: 'failed',
                metadata: {
                    byokSlotExhausted: {
                        notifiedAt: '2026-09-03T12:00:00.000Z',
                    },
                },
            }),
        );

        await run(service);

        expect(notifyReviewFailed).not.toHaveBeenCalled();
    });

    it('still tells the author when the job is FAILED but was never notified', async () => {
        // The crash window: handleFailure wrote the status, then the worker
        // died. Gating on status would have silenced this forever.
        const { service, notifyReviewFailed } = makeService(
            jobRow({ status: 'failed', metadata: {} }),
        );

        await run(service);

        expect(notifyReviewFailed).toHaveBeenCalledTimes(1);
    });

    it('records how many deferrals it took, for the next investigation', async () => {
        // 452 against a cap of 10 is what made this branch necessary; losing
        // the number would lose the reason it exists.
        const { service, jobRepository } = makeService(jobRow({}));

        await run(service);

        const marker = jobRepository.update.mock.calls.at(-1)?.[1] as {
            metadata: Record<string, any>;
        };
        expect(marker.metadata.byokSlotExhausted.deferredCount).toBe(452);
    });
});
