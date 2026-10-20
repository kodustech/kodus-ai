import { UnauthorizedException } from '@nestjs/common';

import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';

import { OAuthLoginUseCase } from './oauth-login.use-case';

/**
 * Provider token gating — `/auth/oauth` issued a JWT based only on a
 * client-supplied email, never validating the OAuth token against the
 * provider. The use case must now (1) verify the token with the provider and
 * (2) key the account off the provider-returned email, never the request body.
 */
describe('OAuthLoginUseCase — provider token gating', () => {
    const makeDeps = () => {
        const authService = {
            verifyOAuthProviderEmail: jest.fn(),
            validateUser: jest.fn(),
            login: jest.fn(),
        };
        const signUpUseCase = { execute: jest.fn() };
        const telemetry = { userLoggedIn: jest.fn() };
        const useCase = new OAuthLoginUseCase(
            authService as any,
            signUpUseCase as any,
            telemetry as any,
        );
        return { useCase, authService, signUpUseCase, telemetry };
    };

    it('rejects when the provider token cannot be verified — no JWT issued', async () => {
        const { useCase, authService, signUpUseCase } = makeDeps();
        authService.verifyOAuthProviderEmail.mockRejectedValue(
            new UnauthorizedException('bad token'),
        );

        await expect(
            useCase.execute(
                'Any Name',
                'victim@example.com',
                'completely_fake',
                AuthProvider.GITHUB,
            ),
        ).rejects.toBeInstanceOf(UnauthorizedException);

        expect(authService.login).not.toHaveBeenCalled();
        expect(signUpUseCase.execute).not.toHaveBeenCalled();
        // The provider token (not the body email) is what gets verified, in
        // (provider, token) order — swapping or dropping it must fail here.
        expect(authService.verifyOAuthProviderEmail).toHaveBeenCalledWith(
            AuthProvider.GITHUB,
            'completely_fake',
        );
    });

    it('keys the account off the provider email, not the request body', async () => {
        const { useCase, authService } = makeDeps();
        // Attacker claims the victim's email in the body, but the token the
        // provider validates belongs to attacker@evil.com.
        authService.verifyOAuthProviderEmail.mockResolvedValue({
            email: 'attacker@evil.com',
            name: 'Attacker',
        });
        authService.validateUser.mockResolvedValue({
            uuid: 'u1',
            organization: { uuid: 'o1' },
        });
        authService.login.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
        });

        const out = await useCase.execute(
            'Victim',
            'victim@example.com', // body email — must be ignored
            'valid_token',
            AuthProvider.GITHUB,
        );

        expect(authService.verifyOAuthProviderEmail).toHaveBeenCalledWith(
            AuthProvider.GITHUB,
            'valid_token',
        );
        expect(authService.validateUser).toHaveBeenCalledWith({
            email: 'attacker@evil.com',
        });
        expect(out).toEqual({ accessToken: 'a', refreshToken: 'r' });
    });

    it('auto-registers with the verified email when the user is new', async () => {
        const { useCase, authService, signUpUseCase } = makeDeps();
        authService.verifyOAuthProviderEmail.mockResolvedValue({
            email: 'new@example.com',
            name: 'New User',
        });
        authService.validateUser.mockResolvedValue(undefined);
        signUpUseCase.execute.mockResolvedValue({
            uuid: 'u2',
            organization: { uuid: 'o2' },
        });
        authService.login.mockResolvedValue({
            accessToken: 'a',
            refreshToken: 'r',
        });

        await useCase.execute(
            'ignored',
            'body@example.com',
            'valid_token',
            AuthProvider.GITHUB,
        );

        expect(signUpUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({ email: 'new@example.com' }),
        );
    });
});
