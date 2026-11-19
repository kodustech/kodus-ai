const warn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        warn: (...a: unknown[]) => warn(...a),
        log: jest.fn(),
        error: jest.fn(),
    }),
}));

import { runActivity, updateActivity } from './activity-registry';
import { SLOW_SYNC_MS, timeSync } from './time-sync';

const burn = (ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        /* hold the thread */
    }
};

describe('timeSync', () => {
    beforeEach(() => warn.mockClear());

    it('returns the result and logs nothing when fast', () => {
        expect(timeSync('fast', () => 42)).toBe(42);
        expect(warn).not.toHaveBeenCalled();
    });

    it('logs slow synchronous work with its label, size and job', async () => {
        await runActivity('job-9', {}, async () => {
            updateActivity({ repository: 'acme/app', prNumber: 7 });
            timeSync(
                'slow work',
                () => burn(SLOW_SYNC_MS + 50),
                () => ({ inputChars: 123 }),
            );
        });
        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    label: 'slow work',
                    inputChars: 123,
                    job: expect.objectContaining({
                        jobId: 'job-9',
                        repository: 'acme/app',
                        prNumber: 7,
                    }),
                }),
            }),
        );
    });

    it('rethrows the work error unchanged', () => {
        expect(() =>
            timeSync('boom', () => {
                throw new Error('x');
            }),
        ).toThrow('x');
    });
});
