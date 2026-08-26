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

        // Retrying past the point where the holder stops being visible is
        // worse than giving up: its row has aged out of the gate's lookback
        // and its lock TTL expired minutes earlier, so the retry clears both
        // gates while the holder still runs and starts a second review.
        it('stops once the next attempt would land past the holder deadline', () => {
            const almostUp = new Date(Date.now() + 5_000);

            expect(service.next(withDeferrals(0), almostUp)).toBeNull();
        });

        it('keeps going while the holder is still comfortably visible', () => {
            const plentyLeft = new Date(Date.now() + GATE_LOOKBACK_MS);

            expect(service.next(withDeferrals(0), plentyLeft)).toEqual({
                deferredCount: 1,
                delayMs: BASE_DELAY_MS,
            });
        });

        // The deadline is anchored to the HOLDER's start, not to the
        // collision, so a command arriving late into a long review gets a
        // correspondingly smaller budget than one arriving immediately.
        it('gives a late collision less budget than an early one', () => {
            const holderJustStarted = new Date(Date.now() + GATE_LOOKBACK_MS);
            const holderNearlyAgedOut = new Date(Date.now() + 30_000);

            // Same attempt number, opposite answers — the holder's age
            // decides, not how many times we have already retried.
            expect(
                service.next(withDeferrals(3), holderJustStarted),
            ).not.toBeNull();
            expect(
                service.next(withDeferrals(3), holderNearlyAgedOut),
            ).toBeNull();
        });

        it('falls back to the attempt cap when no deadline is known', () => {
            expect(service.next(withDeferrals(MAX_DEFERRALS - 1))).not.toBeNull();
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
