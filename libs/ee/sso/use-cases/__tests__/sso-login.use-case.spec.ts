import { AuthProvider } from '@libs/core/domain/enums/auth-provider.enum';
import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';

import { SSOLoginUseCase } from '../sso-login.use-case';

describe('SSOLoginUseCase', () => {
    const email = 'sso-user@kodus-test.com';
    const organizationId = 'org-1';
    const profile = { email, firstName: 'Sso', lastName: 'User' };
    const tokens = { accessToken: 'access', refreshToken: 'refresh' };

    const makeSut = () => {
        const authService = {
            validateUser: jest.fn(),
            login: jest.fn().mockResolvedValue(tokens),
        };

        const signUpUseCase = {
            execute: jest.fn(),
        };

        const usersService = {
            update: jest.fn(),
        };

        const useCase = new SSOLoginUseCase(
            authService as any,
            signUpUseCase as any,
            usersService as any,
        );

        return { useCase, authService, signUpUseCase, usersService };
    };

    it('creates a pre-verified (ACTIVE) user when the SSO identity is new', async () => {
        const { useCase, authService, signUpUseCase, usersService } = makeSut();

        authService.validateUser.mockResolvedValue(undefined);
        signUpUseCase.execute.mockResolvedValue({
            uuid: 'u-new',
            email,
            status: STATUS.ACTIVE,
            organization: { uuid: organizationId },
        });

        const result = await useCase.execute(profile, organizationId);

        expect(signUpUseCase.execute).toHaveBeenCalledWith(
            expect.objectContaining({ email, organizationId }),
            { preVerified: true },
        );
        // New users are already ACTIVE — no reconciliation needed.
        expect(usersService.update).not.toHaveBeenCalled();
        expect(authService.login).toHaveBeenCalledWith(
            expect.objectContaining({ status: STATUS.ACTIVE }),
            AuthProvider.SSO,
        );
        expect(result).toEqual(tokens);
    });

    it('does not change the status of an existing ACTIVE user', async () => {
        const { useCase, authService, usersService } = makeSut();

        authService.validateUser.mockResolvedValue({
            uuid: 'u-1',
            email,
            status: STATUS.ACTIVE,
            organization: { uuid: organizationId },
        });

        await useCase.execute(profile, organizationId);

        expect(usersService.update).not.toHaveBeenCalled();
        expect(authService.login).toHaveBeenCalledWith(
            expect.objectContaining({ status: STATUS.ACTIVE }),
            AuthProvider.SSO,
        );
    });

    // --- Regression: the Azure AD "Confirm your email" bug ---
    // An existing user whose email was never confirmed (status PENDING /
    // PENDING_EMAIL) logs in through the IdP. SSO authentication is itself
    // proof of email ownership, so the token minted now must already carry
    // status=ACTIVE. Otherwise the web middleware reads `pending` from the
    // JWT and redirects to /confirm-email.
    it.each([STATUS.PENDING, STATUS.PENDING_EMAIL])(
        'reconciles an existing %s user to ACTIVE on SSO login',
        async (initialStatus) => {
            const { useCase, authService, usersService } = makeSut();

            // 1st call: the stale PENDING entity. 2nd call: the re-fetch
            // after the status is persisted, now ACTIVE.
            authService.validateUser
                .mockResolvedValueOnce({
                    uuid: 'u-1',
                    email,
                    status: initialStatus,
                    organization: { uuid: organizationId },
                })
                .mockResolvedValueOnce({
                    uuid: 'u-1',
                    email,
                    status: STATUS.ACTIVE,
                    organization: { uuid: organizationId },
                });

            await useCase.execute(profile, organizationId);

            // Persisted so future logins / token refreshes stay ACTIVE.
            expect(usersService.update).toHaveBeenCalledWith(
                { email },
                { status: STATUS.ACTIVE },
            );
            // Re-fetched (not spread/mutated) so the entity stays intact.
            expect(authService.validateUser).toHaveBeenCalledTimes(2);
            // And the token minted right now already reflects ACTIVE.
            expect(authService.login).toHaveBeenCalledWith(
                expect.objectContaining({ status: STATUS.ACTIVE }),
                AuthProvider.SSO,
            );
        },
    );

    // `validateUser` returns a UserEntity whose `status` is a read-only
    // getter and whose relations (organization) are non-enumerable — so it
    // can be neither mutated nor spread. Reconciliation must re-fetch the
    // entity so `authService.login` → createToken gets a usable object
    // (status ACTIVE *and* organization intact). Regression for the e2e
    // failures "which has only a getter" / "reading 'uuid'".
    it('re-fetches the entity (status + organization intact) when reconciling', async () => {
        const { useCase, authService } = makeSut();

        const makeEntity = (status: STATUS) => {
            const u: Record<string, unknown> = { uuid: 'u-1', email };
            Object.defineProperty(u, 'status', {
                get: () => status, // read-only, like the entity getter
                enumerable: true,
                configurable: true,
            });
            Object.defineProperty(u, 'organization', {
                value: { uuid: organizationId },
                enumerable: false, // relation, not spread-copied
                writable: false,
                configurable: true,
            });
            return u;
        };

        authService.validateUser
            .mockResolvedValueOnce(makeEntity(STATUS.PENDING))
            .mockResolvedValueOnce(makeEntity(STATUS.ACTIVE));

        await useCase.execute(profile, organizationId);

        const loggedInUser = authService.login.mock.calls[0][0];
        expect(loggedInUser.organization).toEqual({ uuid: organizationId });
        expect(loggedInUser.status).toBe(STATUS.ACTIVE);
    });
});
