import { describe, expect, it } from 'vitest';
import { ApiError, AuthError } from '../errors.js';

describe('types/errors', () => {
    it('exports ApiError and AuthError runtime classes', () => {
        const apiError = new ApiError(403, 'Access denied');
        const authError = new AuthError('Not authenticated');

        expect(apiError).toBeInstanceOf(Error);
        expect(apiError.name).toBe('ApiError');
        expect(apiError.statusCode).toBe(403);

        expect(authError).toBeInstanceOf(Error);
        expect(authError.name).toBe('AuthError');
    });
});
