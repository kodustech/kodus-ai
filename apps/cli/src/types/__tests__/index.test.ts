import { describe, expect, it } from 'vitest';
import { ApiError, AuthError } from '../index.js';

describe('types/index barrel', () => {
    it('re-exports ApiError and AuthError', () => {
        expect(new ApiError(500, 'Boom').name).toBe('ApiError');
        expect(new AuthError('No auth').name).toBe('AuthError');
    });
});
