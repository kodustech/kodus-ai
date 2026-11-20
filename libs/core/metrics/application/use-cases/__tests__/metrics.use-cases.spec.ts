import { GetErrorRatesUseCase } from '../get-error-rates.use-case';
import { GetMetricsSummaryUseCase } from '../get-metrics-summary.use-case';
import { GetPipelinePerformanceUseCase } from '../get-pipeline-performance.use-case';
import { GetReviewResponseTimesUseCase } from '../get-review-response-times.use-case';

const repository = () => ({
    sumHttpCountsByComponent: jest.fn().mockResolvedValue([]),
    findReviewDurations: jest.fn().mockResolvedValue([]),
    countReviewErrors: jest.fn().mockResolvedValue(0),
    averageStageDurations: jest.fn().mockResolvedValue([]),
});
const minutesBefore = (since: Date) =>
    Math.round((Date.now() - since.getTime()) / 60_000);

describe('GetErrorRatesUseCase', () => {
    it('turns the per-component counts into an error rate', async () => {
        const repo = repository();
        repo.sumHttpCountsByComponent.mockResolvedValue([
            { component: 'api', name: 'http_request_total', count: 400 },
            { component: 'api', name: 'http_errors_total', count: 3 },
            { component: 'worker', name: 'http_errors_total', count: 2 },
        ]);

        const rates = await new GetErrorRatesUseCase(repo).execute({});

        expect(rates).toEqual([
            {
                component: 'api',
                totalRequests: 400,
                totalErrors: 3,
                errorRate: 0.75,
                windowMinutes: 15,
            },
            // Errors with no request recorded: no rate to divide.
            {
                component: 'worker',
                totalRequests: 0,
                totalErrors: 2,
                errorRate: 0,
                windowMinutes: 15,
            },
        ]);
    });

    it.each([
        [undefined, 15],
        [Number.NaN, 15],
        [0, 15],
        [-5, 1],
        [60, 60],
        [5000, 1440],
    ])('reads a window of %p minutes as %p', async (windowMinutes, used) => {
        const repo = repository();

        const [rate] = await new GetErrorRatesUseCase(repo).execute({
            windowMinutes,
        });

        expect(rate).toBeUndefined();
        expect(
            minutesBefore(repo.sumHttpCountsByComponent.mock.calls[0][0]),
        ).toBe(used);
    });
});

describe('GetReviewResponseTimesUseCase', () => {
    it('reports percentiles, average and max of the review durations', async () => {
        const repo = repository();
        repo.findReviewDurations.mockResolvedValue([
            50, 10, 40, 20, 30, 100, 60, 70, 80, 90,
        ]);

        await expect(
            new GetReviewResponseTimesUseCase(repo).execute({ hours: 2 }),
        ).resolves.toEqual({
            p50: 50,
            p95: 100,
            avg: 55,
            max: 100,
            count: 10,
            windowHours: 2,
        });
    });

    it('reports zeros when no review was recorded, over at most a week', async () => {
        const repo = repository();

        await expect(
            new GetReviewResponseTimesUseCase(repo).execute({ hours: 900 }),
        ).resolves.toEqual({
            p50: 0,
            p95: 0,
            avg: 0,
            max: 0,
            count: 0,
            windowHours: 168,
        });
    });
});

describe('GetPipelinePerformanceUseCase', () => {
    it('names unlabelled stages and rounds the averages', async () => {
        const repo = repository();
        repo.averageStageDurations.mockResolvedValue([
            {
                pipeline: 'review',
                stage: 'finder',
                avgDurationMs: 1234.6,
                count: 3,
            },
            { avgDurationMs: 10.2, count: 1 },
        ]);

        await expect(
            new GetPipelinePerformanceUseCase(repo).execute({}),
        ).resolves.toEqual([
            {
                pipeline: 'review',
                stage: 'finder',
                avgDurationMs: 1235,
                count: 3,
            },
            {
                pipeline: 'unknown',
                stage: 'unknown',
                avgDurationMs: 10,
                count: 1,
            },
        ]);
        expect(minutesBefore(repo.averageStageDurations.mock.calls[0][0])).toBe(
            24 * 60,
        );
    });
});

describe('GetMetricsSummaryUseCase', () => {
    it("combines the last 15 minutes' error rates with the last hour's reviews", async () => {
        const repo = repository();
        repo.findReviewDurations.mockResolvedValue([100, 201]);
        repo.countReviewErrors.mockResolvedValue(4);
        const errorRates = new GetErrorRatesUseCase(repo);
        jest.spyOn(errorRates, 'execute');

        const summary = await new GetMetricsSummaryUseCase(
            repo,
            errorRates,
        ).execute();

        expect(errorRates.execute).toHaveBeenCalledWith({ windowMinutes: 15 });
        expect(minutesBefore(repo.countReviewErrors.mock.calls[0][0])).toBe(60);
        expect(summary).toMatchObject({
            errorRate: [],
            reviewsProcessed: 2,
            reviewsFailed: 4,
            avgReviewDurationMs: 151,
        });
    });
});
