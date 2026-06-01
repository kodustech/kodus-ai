import { describe, expect, it, vi } from 'vitest';
import { RealAuthApi } from '../auth.api.js';

describe('RealAuthApi', () => {
    it('posts credentials on login and maps the response into CLI auth shape', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
        });

        const api = new RealAuthApi(requestWithRetry);
        await expect(api.login('wellington@test.com', 'secret')).resolves.toEqual(
            expect.objectContaining({
                accessToken: 'access-token',
                refreshToken: 'refresh-token',
                expiresIn: 3600,
                user: expect.objectContaining({
                    email: 'wellington@test.com',
                }),
            }),
        );

        expect(requestWithRetry).toHaveBeenCalledWith('/auth/login', {
            method: 'POST',
            body: JSON.stringify({
                email: 'wellington@test.com',
                password: 'secret',
            }),
        });
    });

    it('uses bearer auth when generating CI token', async () => {
        const requestWithRetry = vi.fn().mockResolvedValue({
            token: 'ci-token',
        });

        const api = new RealAuthApi(requestWithRetry);
        await expect(api.generateCIToken('eyJ.test.token')).resolves.toBe(
            'ci-token',
        );

        expect(requestWithRetry).toHaveBeenCalledWith('/auth/ci-token', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer eyJ.test.token',
            },
        });
    });

    it('marks non-jwt access tokens as invalid in verify', async () => {
        const requestWithRetry = vi.fn();
        const api = new RealAuthApi(requestWithRetry);

        await expect(api.verify('kodus_team_key')).resolves.toEqual({
            valid: false,
        });
        expect(requestWithRetry).not.toHaveBeenCalled();
    });
});
