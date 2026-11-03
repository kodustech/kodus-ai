const warn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ warn, log: jest.fn(), error: jest.fn() }),
}));

import { parseDrainTimeoutMs } from './drain-timeout';

describe('parseDrainTimeoutMs warnings', () => {
    const prev = process.env.API_WORKER_DRAIN_TIMEOUT_MS;

    afterEach(() => {
        warn.mockClear();
        if (prev === undefined) delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;
        else process.env.API_WORKER_DRAIN_TIMEOUT_MS = prev;
    });

    it('uses the default quietly when the variable is unset', () => {
        delete process.env.API_WORKER_DRAIN_TIMEOUT_MS;

        expect(parseDrainTimeoutMs()).toBe(25_000);
        expect(warn).not.toHaveBeenCalled();
    });

    it.each(['30s', '2.4e5', '10.5', '12abc', '-5', '0', '   '])(
        'falls back to the default for the malformed value %p instead of reading a prefix',
        (configured) => {
            process.env.API_WORKER_DRAIN_TIMEOUT_MS = configured;

            expect(parseDrainTimeoutMs()).toBe(25_000);
            expect(warn).toHaveBeenCalledTimes(1);
        },
    );

    it('reads a whole number of milliseconds, surrounding spaces aside', () => {
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = ' 240000 ';

        expect(parseDrainTimeoutMs()).toBe(240_000);
        expect(warn).not.toHaveBeenCalled();
    });

    it('warns with the configured value, the ceiling and the default when out of range', () => {
        process.env.API_WORKER_DRAIN_TIMEOUT_MS = '2400000';

        expect(parseDrainTimeoutMs()).toBe(25_000);
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: {
                    configured: '2400000',
                    max: 600_000,
                    default: 25_000,
                },
            }),
        );
    });
});
