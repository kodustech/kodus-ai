import { __test__, isMongoQueryTimeout } from './query-timeout';

describe('query-timeout', () => {
    const { resolveMaxTimeMs, DEFAULT_MONGO_QUERY_MAX_TIME_MS } = __test__;

    it('defaults to 50s', () => {
        expect(DEFAULT_MONGO_QUERY_MAX_TIME_MS).toBe(50_000);
        expect(resolveMaxTimeMs(undefined)).toBe(50_000);
    });

    it('accepts a positive integer override', () => {
        expect(resolveMaxTimeMs('15000')).toBe(15_000);
    });

    it.each(['', 'abc', '0', '-5', '1.5'])(
        'falls back to the default on invalid override %p',
        (raw) => {
            expect(resolveMaxTimeMs(raw)).toBe(50_000);
        },
    );

    it('recognises mongod MaxTimeMSExpired by code or codeName', () => {
        expect(isMongoQueryTimeout({ code: 50 })).toBe(true);
        expect(isMongoQueryTimeout({ codeName: 'MaxTimeMSExpired' })).toBe(
            true,
        );
        expect(isMongoQueryTimeout({ code: 11000 })).toBe(false);
        expect(isMongoQueryTimeout(new Error('boom'))).toBe(false);
        expect(isMongoQueryTimeout(null)).toBe(false);
    });
});
