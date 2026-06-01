import { AuthProvider } from '@libs/core/domain/enums';

import { IUser } from '../../user/interfaces/user.interface';

export const AUTH_SERVICE_TOKEN = Symbol.for('AuthService');

export interface IAuthService {
    validateUser(
        userEntity: Partial<IUser>,
    ): Promise<Partial<IUser>> | undefined;
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
