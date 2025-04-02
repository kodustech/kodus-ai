import { AuthProvider } from '@/shared/domain/enums/auth-provider.enum';
import { IUser } from '../../user/interfaces/user.interface';

export const AUTH_SERVICE_TOKEN = Symbol('AuthService');

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
}
