import { describe, expect, it } from 'vitest';
import { ApiError, AuthError } from '../../types/errors.js';
import { CommandError, normalizeCommandError } from '../command-errors.js';

describe('command errors', () => {
    it('keeps explicit CommandError code', () => {
        const normalized = normalizeCommandError(
            new CommandError('INVALID_INPUT', 'bad input', 1, {
                flag: '--foo',
            }),
        );

        expect(normalized.code).toBe('INVALID_INPUT');
        expect(normalized.message).toBe('bad input');
        expect(normalized.exitCode).toBe(1);
        expect(normalized.details).toEqual({ flag: '--foo' });
    });

    it('maps auth errors to AUTH_REQUIRED', () => {
        const normalized = normalizeCommandError(
            new AuthError('Not authenticated'),
        );
        expect(normalized.code).toBe('AUTH_REQUIRED');
    });

    it('maps api errors to API_REQUEST_FAILED', () => {
        const normalized = normalizeCommandError(
            new ApiError(500, 'server down'),
        );
        expect(normalized.code).toBe('API_REQUEST_FAILED');
    });

    it('maps unknown errors to INTERNAL_ERROR', () => {
        const normalized = normalizeCommandError(new Error('boom'));
        expect(normalized.code).toBe('INTERNAL_ERROR');
    });

    it('maps review validation errors to INVALID_INPUT', () => {
        expect(
            normalizeCommandError(
                new Error(
                    'The `--interactive` and `--fix` options cannot be used together.',
                ),
            ).code,
        ).toBe('INVALID_INPUT');

        expect(
            normalizeCommandError(
                new Error(
                    'Invalid value for `--fail-on`: `nope`. Use one of: info, warning, error, critical.',
                ),
            ).code,
        ).toBe('INVALID_INPUT');
    });

    it('maps network fetch failures to a user-friendly API unavailable message', () => {
        const error = new TypeError('fetch failed') as TypeError & {
            cause?: { code?: string };
        };
        error.cause = { code: 'ECONNREFUSED' };
        process.env.KODUS_API_URL = 'http://localhost:3001';

        const normalized = normalizeCommandError(error);

        expect(normalized).toMatchObject({
            code: 'API_REQUEST_FAILED',
            exitCode: 1,
        });
        expect(normalized.message).toContain(
            'Could not reach the Kodus API at http://localhost:3001.',
        );
        expect(normalized.message).toContain(
            'If you are using the local API, make sure it is running.',
        );

        delete process.env.KODUS_API_URL;
    });
});
