import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { AuthResponse, StoredCredentials } from '../../types/auth.js';
import { AuthError } from '../../types/errors.js';

vi.mock('../api/index.js', () => ({
    api: {
        auth: {
            login: vi.fn(),
            refresh: vi.fn(),
            logout: vi.fn(),
            generateCIToken: vi.fn(),
            verify: vi.fn(),
        },
    },
}));

vi.mock('../../utils/credentials.js', () => ({
    loadCredentials: vi.fn(),
    saveCredentials: vi.fn(),
    clearCredentials: vi.fn(),
}));

vi.mock('../../utils/config.js', () => ({
    loadConfig: vi.fn(),
    clearConfig: vi.fn(),
}));

import { api } from '../api/index.js';
import {
    loadCredentials,
    saveCredentials,
    clearCredentials,
} from '../../utils/credentials.js';
import { loadConfig, clearConfig } from '../../utils/config.js';
import { AuthService } from '../auth.service.js';

const mockApi = vi.mocked(api);
const mockLoadCredentials = vi.mocked(loadCredentials);
const mockSaveCredentials = vi.mocked(saveCredentials);
const mockClearCredentials = vi.mocked(clearCredentials);
const mockLoadConfig = vi.mocked(loadConfig);
const mockClearConfig = vi.mocked(clearConfig);

function makeCredentials(
    overrides: Partial<StoredCredentials> = {},
): StoredCredentials {
    return {
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresAt: Date.now() + 3600 * 1000,
        user: { id: 'u1', email: 'test@example.com', orgs: [] },
        ...overrides,
    };
}

function makeAuthResponse(overrides: Partial<AuthResponse> = {}): AuthResponse {
    return {
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        expiresIn: 3600,
        user: { id: 'u1', email: 'test@example.com', orgs: [] },
        ...overrides,
    };
}

describe('AuthService', () => {
    let authService: AuthService;
    const originalKodusToken = process.env.KODUS_TOKEN;
    const originalKodusTeamKey = process.env.KODUS_TEAM_KEY;

    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.KODUS_TOKEN;
        delete process.env.KODUS_TEAM_KEY;
        authService = new AuthService();
    });

    afterAll(() => {
        if (originalKodusToken === undefined) {
            delete process.env.KODUS_TOKEN;
        } else {
            process.env.KODUS_TOKEN = originalKodusToken;
        }

        if (originalKodusTeamKey === undefined) {
            delete process.env.KODUS_TEAM_KEY;
        } else {
            process.env.KODUS_TEAM_KEY = originalKodusTeamKey;
        }
    });

    describe('login', () => {
        it('calls api.auth.login and saves credentials', async () => {
            const response = makeAuthResponse();
            mockApi.auth.login = vi.fn().mockResolvedValue(response);

            await authService.login('test@example.com', 'password123');

            expect(mockApi.auth.login).toHaveBeenCalledWith(
                'test@example.com',
                'password123',
            );
            expect(mockSaveCredentials).toHaveBeenCalledWith(
                expect.objectContaining({
                    accessToken: 'new-access-token',
                    refreshToken: 'new-refresh-token',
                }),
            );
            expect(mockClearConfig).toHaveBeenCalled();
        });
    });

    describe('logout', () => {
        it('calls api.auth.logout and clears credentials and cache', async () => {
            const creds = makeCredentials();
            mockLoadCredentials.mockResolvedValue(creds);
            mockApi.auth.logout = vi.fn().mockResolvedValue(undefined);

            await authService.logout();

            expect(mockApi.auth.logout).toHaveBeenCalledWith('access-token');
            expect(mockClearCredentials).toHaveBeenCalled();
            expect(mockClearConfig).toHaveBeenCalled();
        });

        it('ignores API errors during logout silently', async () => {
            const creds = makeCredentials();
            mockLoadCredentials.mockResolvedValue(creds);
            mockApi.auth.logout = vi
                .fn()
                .mockRejectedValue(new Error('Network error'));

            await authService.logout();

            expect(mockClearCredentials).toHaveBeenCalled();
            expect(mockClearConfig).toHaveBeenCalled();
        });
    });

    describe('isAuthenticated', () => {
        it('returns true when KODUS_TOKEN is set', async () => {
            process.env.KODUS_TOKEN = 'ci-token';

            const result = await authService.isAuthenticated();

            expect(result).toBe(true);
            expect(mockLoadCredentials).not.toHaveBeenCalled();
        });

        it('returns true when KODUS_TEAM_KEY is set', async () => {
            process.env.KODUS_TEAM_KEY = 'kodus_env_key';

            const result = await authService.isAuthenticated();

            expect(result).toBe(true);
            expect(mockLoadCredentials).not.toHaveBeenCalled();
        });

        it('returns true when credentials exist', async () => {
            mockLoadCredentials.mockResolvedValue(makeCredentials());

            const result = await authService.isAuthenticated();

            expect(result).toBe(true);
        });

        it('returns true when teamKey exists (no credentials)', async () => {
            mockLoadCredentials.mockResolvedValue(null);
            mockLoadConfig.mockResolvedValue({
                teamKey: 'kodus_abc123',
            } as any);

            const result = await authService.isAuthenticated();

            expect(result).toBe(true);
        });

        it('returns false when neither credentials nor teamKey exist', async () => {
            mockLoadCredentials.mockResolvedValue(null);
            mockLoadConfig.mockResolvedValue(null);

            const result = await authService.isAuthenticated();

            expect(result).toBe(false);
        });
    });

    describe('getValidToken', () => {
        it('returns KODUS_TOKEN from env when set', async () => {
            process.env.KODUS_TOKEN = 'ci-token';

            const token = await authService.getValidToken();

            expect(token).toBe('ci-token');
            expect(mockLoadCredentials).not.toHaveBeenCalled();
        });

        it('returns KODUS_TEAM_KEY from env when set', async () => {
            process.env.KODUS_TEAM_KEY = 'kodus_env_key';

            const token = await authService.getValidToken();

            expect(token).toBe('kodus_env_key');
            expect(mockLoadCredentials).not.toHaveBeenCalled();
        });

        it('prefers KODUS_TOKEN over KODUS_TEAM_KEY when both are set', async () => {
            process.env.KODUS_TOKEN = 'ci-token';
            process.env.KODUS_TEAM_KEY = 'kodus_env_key';

            const token = await authService.getValidToken();

            expect(token).toBe('ci-token');
            expect(mockLoadCredentials).not.toHaveBeenCalled();
        });

        it('returns teamKey when no personal credentials exist', async () => {
            mockLoadCredentials.mockResolvedValue(null);
            mockLoadConfig.mockResolvedValue({
                teamKey: 'kodus_team_key',
            } as any);
            mockLoadCredentials.mockResolvedValue(null);

            const token = await authService.getValidToken();

            expect(token).toBe('kodus_team_key');
        });

        it('prefers accessToken when credentials and teamKey both exist', async () => {
            mockLoadConfig.mockResolvedValue({
                teamKey: 'kodus_team_key',
            } as any);
            const creds = makeCredentials({
                expiresAt: Date.now() + 60 * 60 * 1000,
            });
            mockLoadCredentials.mockResolvedValue(creds);

            const token = await authService.getValidToken();

            expect(token).toBe('access-token');
        });

        it('returns accessToken when not expired', async () => {
            mockLoadConfig.mockResolvedValue(null);
            const creds = makeCredentials({
                expiresAt: Date.now() + 60 * 60 * 1000,
            });
            mockLoadCredentials.mockResolvedValue(creds);

            const token = await authService.getValidToken();

            expect(token).toBe('access-token');
        });

        it('refreshes token when expired and saves new credentials', async () => {
            mockLoadConfig.mockResolvedValue(null);
            const expiredCreds = makeCredentials({
                expiresAt: Date.now() - 1000,
            });
            mockLoadCredentials.mockResolvedValue(expiredCreds);

            const newResponse = makeAuthResponse({
                accessToken: 'refreshed-token',
            });
            mockApi.auth.refresh = vi.fn().mockResolvedValue(newResponse);

            const token = await authService.getValidToken();

            expect(token).toBe('refreshed-token');
            expect(mockApi.auth.refresh).toHaveBeenCalledWith('refresh-token');
            expect(mockSaveCredentials).toHaveBeenCalledWith(
                expect.objectContaining({ accessToken: 'refreshed-token' }),
            );
        });

        it('throws AuthError and clears credentials when refresh fails', async () => {
            mockLoadConfig.mockResolvedValue(null);
            const expiredCreds = makeCredentials({
                expiresAt: Date.now() - 1000,
            });
            mockLoadCredentials.mockResolvedValue(expiredCreds);

            mockApi.auth.refresh = vi
                .fn()
                .mockRejectedValue(new Error('refresh failed'));

            await expect(authService.getValidToken()).rejects.toThrow(
                AuthError,
            );
            expect(mockClearCredentials).toHaveBeenCalled();
        });

        it('falls back to teamKey when refresh fails and teamKey exists', async () => {
            mockLoadConfig.mockResolvedValue({
                teamKey: 'kodus_team_key',
            } as any);
            const expiredCreds = makeCredentials({
                expiresAt: Date.now() - 1000,
            });
            mockLoadCredentials.mockResolvedValue(expiredCreds);
            mockApi.auth.refresh = vi
                .fn()
                .mockRejectedValue(new Error('refresh failed'));

            const token = await authService.getValidToken();

            expect(token).toBe('kodus_team_key');
            expect(mockClearCredentials).toHaveBeenCalled();
        });

        it('deduplicates concurrent refresh requests', async () => {
            mockLoadConfig.mockResolvedValue(null);
            const expiredCreds = makeCredentials({
                expiresAt: Date.now() - 1000,
            });
            mockLoadCredentials.mockResolvedValue(expiredCreds);
            const refreshed = makeAuthResponse({
                accessToken: 'single-refresh-token',
            });
            mockApi.auth.refresh = vi.fn().mockResolvedValue(refreshed);

            const [a, b] = await Promise.all([
                authService.getValidToken(),
                authService.getValidToken(),
            ]);

            expect(a).toBe('single-refresh-token');
            expect(b).toBe('single-refresh-token');
            expect(mockApi.auth.refresh).toHaveBeenCalledTimes(1);
        });

        it('throws AuthError when no credentials exist', async () => {
            mockLoadConfig.mockResolvedValue(null);
            mockLoadCredentials.mockResolvedValue(null);

            await expect(authService.getValidToken()).rejects.toThrow(
                AuthError,
            );
        });
    });

    describe('getCredentials', () => {
        it('caches credentials after first load', async () => {
            const creds = makeCredentials();
            mockLoadCredentials.mockResolvedValue(creds);

            const first = await authService.getCredentials();
            const second = await authService.getCredentials();

            expect(first).toBe(second);
            expect(mockLoadCredentials).toHaveBeenCalledTimes(1);
        });
    });

    describe('verifyToken', () => {
        it('returns { valid: false } when no credentials exist', async () => {
            mockLoadCredentials.mockResolvedValue(null);

            const result = await authService.verifyToken();

            expect(result).toEqual({ valid: false });
        });

        it('delegates to api.auth.verify with accessToken', async () => {
            const creds = makeCredentials();
            mockLoadCredentials.mockResolvedValue(creds);
            mockApi.auth.verify = vi
                .fn()
                .mockResolvedValue({ valid: true, user: { id: 'u1' } });

            const result = await authService.verifyToken();

            expect(mockApi.auth.verify).toHaveBeenCalledWith('access-token');
            expect(result).toEqual({ valid: true, user: { id: 'u1' } });
        });
    });
});
