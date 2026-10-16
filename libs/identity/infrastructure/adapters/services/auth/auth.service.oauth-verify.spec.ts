import { UnauthorizedException } from '@nestjs/common';
import axios from 'axios';

import { AuthProvider } from '@libs/core/domain/enums';

import { AuthService } from './auth.service';

jest.mock('axios');

/**
 * GHSA-95hw-cx5j-2pg8 — the verification step `/auth/oauth` was missing:
 * resolve the identity from the provider's own API using the supplied access
 * token, and never accept a token the provider rejects.
 */
describe('AuthService.verifyOAuthProviderEmail (GHSA-95hw)', () => {
    const mockedGet = axios.get as unknown as jest.Mock;

    const makeService = () => {
        const configService = { get: jest.fn().mockReturnValue({}) };
        return new AuthService(
            configService as any,
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );
    };

    beforeEach(() => {
        mockedGet.mockReset();
    });

    it('rejects a missing token', async () => {
        const svc = makeService();
        await expect(
            svc.verifyOAuthProviderEmail(AuthProvider.GITHUB, ''),
        ).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mockedGet).not.toHaveBeenCalled();
    });

    it('rejects an unsupported provider', async () => {
        const svc = makeService();
        await expect(
            svc.verifyOAuthProviderEmail(
                AuthProvider.CREDENTIALS,
                'tok',
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when the provider API fails (invalid token)', async () => {
        const svc = makeService();
        mockedGet.mockRejectedValue(new Error('401'));
        await expect(
            svc.verifyOAuthProviderEmail(AuthProvider.GITHUB, 'fake'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns the GitHub primary verified email as-is when the profile email is absent', async () => {
        const svc = makeService();
        mockedGet.mockImplementation((url: string) => {
            if (url.endsWith('/user')) {
                return Promise.resolve({
                    data: { login: 'octocat', name: 'Octo', email: null },
                });
            }
            if (url.endsWith('/user/emails')) {
                return Promise.resolve({
                    data: [
                        { email: 'other@x.com', primary: false, verified: true },
                        { email: 'Real@X.com', primary: true, verified: true },
                    ],
                });
            }
            return Promise.reject(new Error('unexpected url'));
        });

        const out = await svc.verifyOAuthProviderEmail(
            AuthProvider.GITHUB,
            'valid',
        );
        // As-is, not lower-cased: `getLoginData` is case-sensitive, so
        // lower-casing would miss a mixed-case account and create a new one.
        expect(out).toEqual({ email: 'Real@X.com', name: 'Octo' });
    });

    it('keeps the account identity: returns the profile email as-is when it is itself verified, not the primary', async () => {
        // The web historically keyed the account on GitHub's public profile
        // email. When that address is confirmed verified, return it unchanged
        // so the existing account is found — do not switch to the primary.
        const svc = makeService();
        mockedGet.mockImplementation((url: string) => {
            if (url.endsWith('/user')) {
                return Promise.resolve({
                    data: {
                        login: 'octocat',
                        name: 'Octo',
                        email: 'Dev@Corp.com',
                    },
                });
            }
            if (url.endsWith('/user/emails')) {
                return Promise.resolve({
                    data: [
                        { email: 'primary@corp.com', primary: true, verified: true },
                        { email: 'dev@corp.com', primary: false, verified: true },
                    ],
                });
            }
            return Promise.reject(new Error('unexpected url'));
        });

        const out = await svc.verifyOAuthProviderEmail(
            AuthProvider.GITHUB,
            'valid',
        );
        expect(out).toEqual({ email: 'Dev@Corp.com', name: 'Octo' });
    });

    it('does NOT return the profile email when it is present but unverified — falls back to the primary verified (GHSA-95hw)', async () => {
        // The profile email is only ever trusted when it also appears in the
        // verified list. A spoofed-but-unverified profile email must never win.
        const svc = makeService();
        mockedGet.mockImplementation((url: string) => {
            if (url.endsWith('/user')) {
                return Promise.resolve({
                    data: {
                        login: 'attacker',
                        name: 'A',
                        email: 'victim@corp.com',
                    },
                });
            }
            if (url.endsWith('/user/emails')) {
                return Promise.resolve({
                    data: [
                        { email: 'victim@corp.com', primary: false, verified: false },
                        { email: 'attacker@real.com', primary: true, verified: true },
                    ],
                });
            }
            return Promise.reject(new Error('unexpected url'));
        });

        const out = await svc.verifyOAuthProviderEmail(
            AuthProvider.GITHUB,
            'valid',
        );
        expect(out).toEqual({ email: 'attacker@real.com', name: 'A' });
    });

    it('rejects and logs a sanitized reason that never leaks the token when /user/emails fails', async () => {
        const svc = makeService();
        const warn = jest
            .spyOn((svc as any).logger, 'warn')
            .mockImplementation(() => undefined);
        const TOKEN = 'ghp_super_secret_token_value';
        mockedGet.mockImplementation((url: string) => {
            if (url.endsWith('/user')) {
                return Promise.resolve({
                    data: { login: 'u', email: 'x@y.com' },
                });
            }
            // A realistic axios error: the bearer token lives in config.headers,
            // never in `.message`. The log must carry the reason, not the token.
            const axiosErr: any = new Error(
                'Request failed with status code 403',
            );
            axiosErr.config = {
                headers: { Authorization: `Bearer ${TOKEN}` },
            };
            return Promise.reject(axiosErr);
        });

        await expect(
            svc.verifyOAuthProviderEmail(AuthProvider.GITHUB, TOKEN),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        expect(warn).toHaveBeenCalledTimes(1);
        const logged = warn.mock.calls[0][0] as any;
        expect(logged.message).toContain('no verified email');
        expect(JSON.stringify(logged)).not.toContain(TOKEN);
    });

    it('rejects a GitHub token with no verified email', async () => {
        const svc = makeService();
        mockedGet.mockImplementation((url: string) => {
            if (url.endsWith('/user')) {
                return Promise.resolve({ data: { login: 'x', email: null } });
            }
            return Promise.resolve({ data: [] });
        });
        await expect(
            svc.verifyOAuthProviderEmail(AuthProvider.GITHUB, 'valid'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects a GitHub token whose only email is the unverified public profile email', async () => {
        // The attack (GHSA-95hw): a real token that cannot read verified emails
        // (no `user:email` scope, so /user/emails is denied) carrying a public
        // profile email set to the victim's address. The identity must NOT fall
        // back to that unverified email.
        const svc = makeService();
        mockedGet.mockImplementation((url: string) => {
            if (url.endsWith('/user')) {
                return Promise.resolve({
                    data: { login: 'attacker', email: 'victim@corp.com' },
                });
            }
            return Promise.reject(new Error('403'));
        });
        await expect(
            svc.verifyOAuthProviderEmail(
                AuthProvider.GITHUB,
                'real_but_unscoped',
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns the GitLab account email', async () => {
        const svc = makeService();
        mockedGet.mockResolvedValue({
            data: { email: 'dev@gitlab.example', name: 'Dev', username: 'dev' },
        });
        const out = await svc.verifyOAuthProviderEmail(
            AuthProvider.GITLAB,
            'valid',
        );
        expect(out).toEqual({ email: 'dev@gitlab.example', name: 'Dev' });
    });

    it('rejects a GitLab token whose profile has no email', async () => {
        const svc = makeService();
        mockedGet.mockResolvedValue({
            data: { name: 'Dev', username: 'dev' },
        });
        await expect(
            svc.verifyOAuthProviderEmail(AuthProvider.GITLAB, 'valid'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('validates a self-hosted GitLab token against WEB_GITLAB_OAUTH_URL', async () => {
        // A self-hosted install sets only WEB_GITLAB_OAUTH_URL (the documented
        // variable the web uses); API_GITLAB_TOKEN_URL ships empty. The token
        // must be checked against that instance, not gitlab.com.
        const svc = makeService();
        const prev = process.env.WEB_GITLAB_OAUTH_URL;
        process.env.WEB_GITLAB_OAUTH_URL =
            'https://gitlab.acme.internal/oauth/authorize';
        mockedGet.mockResolvedValue({
            data: { email: 'dev@acme.internal', name: 'Dev', username: 'dev' },
        });
        try {
            const out = await svc.verifyOAuthProviderEmail(
                AuthProvider.GITLAB,
                'valid',
            );
            expect(out).toEqual({ email: 'dev@acme.internal', name: 'Dev' });
            expect(mockedGet).toHaveBeenCalledWith(
                'https://gitlab.acme.internal/api/v4/user',
                expect.anything(),
            );
        } finally {
            if (prev === undefined) delete process.env.WEB_GITLAB_OAUTH_URL;
            else process.env.WEB_GITLAB_OAUTH_URL = prev;
        }
    });

    it('falls back to the public gitlab.com API when WEB_GITLAB_OAUTH_URL is not set', async () => {
        // The inactive direction of the guard: with no self-hosted URL the
        // token must be validated against gitlab.com, not against
        // `undefined/api/v4/user`.
        const svc = makeService();
        const prev = process.env.WEB_GITLAB_OAUTH_URL;
        delete process.env.WEB_GITLAB_OAUTH_URL;
        mockedGet.mockResolvedValue({
            data: { email: 'dev@gitlab.example', name: 'Dev', username: 'dev' },
        });
        try {
            await svc.verifyOAuthProviderEmail(AuthProvider.GITLAB, 'valid');
            expect(mockedGet).toHaveBeenCalledWith(
                'https://gitlab.com/api/v4/user',
                expect.anything(),
            );
        } finally {
            if (prev !== undefined) process.env.WEB_GITLAB_OAUTH_URL = prev;
        }
    });

    it('rejects a Google token whose email is not verified', async () => {
        const svc = makeService();
        mockedGet.mockResolvedValue({
            data: { email: 'user@gmail.com', email_verified: false },
        });
        await expect(
            svc.verifyOAuthProviderEmail(AuthProvider.GOOGLE, 'valid'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('returns the Google verified email as-is', async () => {
        const svc = makeService();
        mockedGet.mockResolvedValue({
            data: { email: 'User@Gmail.com', email_verified: true, name: 'U' },
        });
        const out = await svc.verifyOAuthProviderEmail(
            AuthProvider.GOOGLE,
            'valid',
        );
        expect(out).toEqual({ email: 'User@Gmail.com', name: 'U' });
    });

    it('accepts the Google email_verified string "true"', async () => {
        const svc = makeService();
        mockedGet.mockResolvedValue({
            data: { email: 'g@gmail.com', email_verified: 'true', name: 'G' },
        });
        const out = await svc.verifyOAuthProviderEmail(
            AuthProvider.GOOGLE,
            'valid',
        );
        expect(out).toEqual({ email: 'g@gmail.com', name: 'G' });
    });
});
