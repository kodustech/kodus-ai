import { MONGO_QUERY_MAX_TIME_MS } from '@libs/core/infrastructure/database/mongo/query-timeout';
import { ANALYTICS_READ_PREFERENCE } from '@libs/core/infrastructure/database/mongo/read-preference';

import { MetricsRepository } from './metrics.repository';

// Every metrics read is analytics: off the primary and bounded. The two finds
// had neither before they moved here from the controller.
describe('MetricsRepository read routing', () => {
    const since = new Date('2026-11-20T00:00:00Z');
    const chain = (result: unknown) => {
        const query: any = {
            read: jest.fn(() => query),
            maxTimeMS: jest.fn(() => query),
            option: jest.fn(() => query),
            lean: jest.fn(() => query),
            exec: jest.fn(async () => result),
            then: (resolve: any, reject: any) =>
                Promise.resolve(result).then(resolve, reject),
        };
        return query;
    };
    const build = () => {
        const queries: any[] = [];
        const track = (result: unknown) => {
            const q = chain(result);
            queries.push(q);
            return q;
        };
        const model = {
            aggregate: jest.fn(() => track([])),
            find: jest.fn(() => track([])),
            countDocuments: jest.fn(() => track(0)),
        };
        return { repository: new MetricsRepository(model as any), queries };
    };

    it.each([
        ['sumHttpCountsByComponent'],
        ['findReviewDurations'],
        ['countReviewErrors'],
        ['averageStageDurations'],
    ])(
        '%s reads the analytics member with the query time bound',
        async (method) => {
            const { repository, queries } = build();

            await (repository as any)[method](since);

            const [query] = queries;
            expect(query.read).toHaveBeenCalledWith(ANALYTICS_READ_PREFERENCE);
            const bounded =
                query.maxTimeMS.mock.calls.some(
                    ([ms]: [number]) => ms === MONGO_QUERY_MAX_TIME_MS,
                ) ||
                query.option.mock.calls.some(
                    ([o]: [any]) => o?.maxTimeMS === MONGO_QUERY_MAX_TIME_MS,
                );
            expect(bounded).toBe(true);
        },
    );
});
