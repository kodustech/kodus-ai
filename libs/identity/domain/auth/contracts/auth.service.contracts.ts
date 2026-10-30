import { AuthProvider } from '@libs/core/domain/enums';

import { IUser } from '../../user/interfaces/user.interface';

export const AUTH_SERVICE_TOKEN = Symbol.for('AuthService');

export interface IAuthService {
    validateUser(
        userEntity: Partial<IUser>,
    ): Promise<Partial<IUser>> | undefined;
    /**
     * Verify an OAuth provider access token against that provider's own API
     * and return the identity the provider vouches for. Throws
     * UnauthorizedException if the token is missing, invalid, or the provider
     * reports no verified email. The returned email — never a client-supplied
     * one — is the only trustworthy identity for an OAuth login.
     */
    verifyOAuthProviderEmail(
        authProvider: AuthProvider,
        accessToken: string,
    ): Promise<{ email: string; name?: string }>;
    login(
        userEntity: Partial<IUser>,
        authProvider: AuthProvider,
        authDetails?: any,
    ): Promise<any>;
    logout(refreshToken: string): Promise<any>;
    refreshToken(oldRefreshToken: string): Promise<any>;
    hashPassword(password: string, saltOrRounds: number): Promise<string>;
    match(enteredPassword: string, hashedPassword: string): Promise<boolean>;
    createForgotPassToken(userId: string, email: string): Promise<string>;
    verifyForgotPassToken(token: string): Promise<any>;
    verifyEmailToken(token: string): Promise<any>;
    createEmailToken(userId: string, email: string): Promise<string>;
    createHelpdeskToken(user: Partial<IUser>): Promise<string>;
}
