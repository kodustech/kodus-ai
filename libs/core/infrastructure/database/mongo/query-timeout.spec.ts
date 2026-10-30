import { __test__, isMongoQueryTimeout } from './query-timeout';

describe('query-timeout', () => {
    const {
        resolveMaxTimeMs,
        DEFAULT_MONGO_QUERY_MAX_TIME_MS,
        MAX_MONGO_QUERY_MAX_TIME_MS,
    } = __test__;

    it('defaults to 50s without warning when the override is unset', () => {
        const warn = jest.fn();
        expect(DEFAULT_MONGO_QUERY_MAX_TIME_MS).toBe(50_000);
        expect(resolveMaxTimeMs(undefined, warn)).toBe(50_000);
        expect(resolveMaxTimeMs('', warn)).toBe(50_000);
        expect(warn).not.toHaveBeenCalled();
    });

    it('accepts an integer override within [1, max]', () => {
        const warn = jest.fn();
        expect(resolveMaxTimeMs('15000', warn)).toBe(15_000);
        expect(
            resolveMaxTimeMs(String(MAX_MONGO_QUERY_MAX_TIME_MS), warn),
        ).toBe(MAX_MONGO_QUERY_MAX_TIME_MS);
        expect(warn).not.toHaveBeenCalled();
    });

    it.each(['abc', '0', '-5', '1.5', String(10 * 60_000 + 1), '500000000'])(
        'falls back to the default and warns on override %p',
        (raw) => {
            const warn = jest.fn();
            expect(resolveMaxTimeMs(raw, warn)).toBe(50_000);
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0][0].metadata).toEqual({
                configured: raw,
                max: MAX_MONGO_QUERY_MAX_TIME_MS,
                default: DEFAULT_MONGO_QUERY_MAX_TIME_MS,
            });
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
