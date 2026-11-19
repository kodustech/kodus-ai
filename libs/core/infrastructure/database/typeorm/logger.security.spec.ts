/**
 * The TypeORM query logger must never put bound values in a log line: it
 * logged them for every failed and every slow statement, which put a live
 * refresh token in production logs (2026-11-16/17).
 *
 * A failing assertion here is a REAL leak, NOT a test to relax.
 */
const emitted: unknown[] = [];
jest.mock('@libs/core/log/logger', () => ({
    ...jest.requireActual('@libs/core/log/logger'),
    createLogger: () => ({
        log: (entry: unknown) => emitted.push(entry),
        debug: (entry: unknown) => emitted.push(entry),
        warn: (entry: unknown) => emitted.push(entry),
        error: (entry: unknown) => emitted.push(entry),
    }),
}));

import { TypeOrmCustomLogger } from './logger';

const SECRET = 'not-a-real-refresh-token-0123456789abcdef';
const QUERY = 'INSERT INTO "auth"("uuid", "refreshToken") VALUES ($1, $2)';

describe('TypeOrmCustomLogger', () => {
    beforeEach(() => {
        emitted.length = 0;
    });

    it.each([
        [
            'a failed statement',
            (l: TypeOrmCustomLogger) =>
                l.logQueryError('boom', QUERY, ['id', SECRET]),
        ],
        [
            'a slow statement',
            (l: TypeOrmCustomLogger) =>
                l.logQuerySlow(5000, QUERY, ['id', SECRET]),
        ],
        [
            'a debug statement',
            (l: TypeOrmCustomLogger) => l.logQuery(QUERY, ['id', SECRET]),
        ],
    ])('logs %s with its query but not its bound values', (_case, log) => {
        log(new TypeOrmCustomLogger(true));

        const line = JSON.stringify(emitted);
        expect(line).not.toContain(SECRET);
        expect(line).toContain('INSERT INTO');
    });
});
