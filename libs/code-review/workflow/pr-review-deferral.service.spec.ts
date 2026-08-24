import { PrReviewDeferralService } from './pr-review-deferral.service';
import { JobStatus } from '@libs/core/workflow/domain/enums/job-status.enum';

const BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 5 * 60_000;
const MAX_DEFERRALS = 10;

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

        // Total backoff has to outlast the 30-minute window the
        // active-execution check refuses inside, or the last retry lands
        // while the holder still blocks it.
        it('keeps retrying for at least 30 minutes', () => {
            let total = 0;
            for (let i = 0; i < MAX_DEFERRALS; i++) {
                total += service.next(withDeferrals(i))!.delayMs;
            }
            expect(total).toBeGreaterThanOrEqual(30 * 60_000);
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
