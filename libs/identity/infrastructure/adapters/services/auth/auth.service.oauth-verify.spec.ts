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

    it('returns the GitHub verified primary email (lowercased)', async () => {
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
        expect(out).toEqual({ email: 'real@x.com', name: 'Octo' });
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

    it('rejects a Google token whose email is not verified', async () => {
        const svc = makeService();
        mockedGet.mockResolvedValue({
            data: { email: 'user@gmail.com', email_verified: false },
        });
        await expect(
            svc.verifyOAuthProviderEmail(AuthProvider.GOOGLE, 'valid'),
        ).rejects.toBeInstanceOf(UnauthorizedException);
    });
});
