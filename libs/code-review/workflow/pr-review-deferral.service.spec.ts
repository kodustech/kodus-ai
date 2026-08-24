import { PrReviewDeferralService } from './pr-review-deferral.service';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 60_000;
const MAX_DEFERRALS = 26;
const GATE_LOOKBACK_MS = 30 * 60_000;

const makeJob = (overrides: Partial<any> = {}): any => ({
    id: 'job-1',
    correlationId: 'corr-1',
    workflowType: 'code_review',
    handlerType: 'pipeline_sync',
    organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' },
    metadata: {},
    ...overrides,
});

const withDeferrals = (count: number) =>
    makeJob({ metadata: { prReviewDeferral: { deferredCount: count } } });

describe('PrReviewDeferralService', () => {
    let service: PrReviewDeferralService;
    let jobRepository: { update: jest.Mock };
    let outboxRepository: { create: jest.Mock };
    let messageBroker: { transformMessageToMessageBroker: jest.Mock };

    beforeEach(() => {
        jobRepository = { update: jest.fn().mockResolvedValue(undefined) };
        outboxRepository = { create: jest.fn().mockResolvedValue(undefined) };
        messageBroker = {
            transformMessageToMessageBroker: jest.fn(
                ({ message }) => message as unknown,
            ),
        };

        service = new PrReviewDeferralService(
            jobRepository as any,
            outboxRepository as any,
            messageBroker as any,
        );
    });

    describe('next', () => {
        it('backs off exponentially from the base delay', () => {
            expect(service.next(withDeferrals(0))).toEqual({
                deferredCount: 1,
                delayMs: BASE_DELAY_MS,
            });
            expect(service.next(withDeferrals(1))).toEqual({
                deferredCount: 2,
                delayMs: BASE_DELAY_MS * 2,
            });
            expect(service.next(withDeferrals(2))).toEqual({
                deferredCount: 3,
                delayMs: BASE_DELAY_MS * 4,
            });
        });

        it('caps the delay', () => {
            expect(service.next(withDeferrals(8))?.delayMs).toBe(MAX_DELAY_MS);
        });

        // Retrying past the active-execution lookback is worse than giving
        // up: the holder's row stops being visible there while it is still
        // running, and its lock TTL expired minutes earlier, so the retry
        // clears both gates and starts a second concurrent review.
        it('gives up before the holder stops being visible to the gate', () => {
            let total = 0;
            for (let i = 0; i < MAX_DEFERRALS; i++) {
                total += service.next(withDeferrals(i))!.delayMs;
            }
            expect(total).toBeLessThan(GATE_LOOKBACK_MS);
            // ...but still long enough to outlast an ordinary review.
            expect(total).toBeGreaterThan(20 * 60_000);
        });

        it('gives up once the deferral cap is reached', () => {
            expect(service.next(withDeferrals(MAX_DEFERRALS))).toBeNull();
        });

        it('treats a job with no deferral metadata as a first attempt', () => {
            expect(service.next(makeJob({ metadata: null }))).toEqual({
                deferredCount: 1,
                delayMs: BASE_DELAY_MS,
            });
        });
    });

    describe('defer', () => {
        it('reschedules the job instead of failing it', async () => {
            await service.defer(makeJob(), {
                deferredCount: 1,
                delayMs: BASE_DELAY_MS,
            });

            expect(jobRepository.update).toHaveBeenCalledWith(
                'job-1',
                expect.objectContaining({
                    status: JobStatus.PENDING,
                    scheduledAt: expect.any(Date),
                }),
            );
        });

        it('carries the deferral count forward', async () => {
            await service.defer(
                withDeferrals(1),
                { deferredCount: 2, delayMs: BASE_DELAY_MS * 2 },
            );

            const [, update] = jobRepository.update.mock.calls[0];
            expect(update.metadata.prReviewDeferral.deferredCount).toBe(2);
        });

        it('preserves unrelated job metadata', async () => {
            await service.defer(
                makeJob({ metadata: { somethingElse: 'keep-me' } }),
                { deferredCount: 1, delayMs: BASE_DELAY_MS },
            );

            const [, update] = jobRepository.update.mock.calls[0];
            expect(update.metadata.somethingElse).toBe('keep-me');
        });

        it('publishes through the outbox so the relay re-delivers it', async () => {
            await service.defer(makeJob(), {
                deferredCount: 1,
                delayMs: BASE_DELAY_MS,
            });

            expect(outboxRepository.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    jobId: 'job-1',
                    nextAttemptAt: expect.any(Date),
                }),
            );
        });
    });
});
