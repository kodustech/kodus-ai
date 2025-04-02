import { AuthModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/auth.model';
import { AuthEntity } from '../entities/auth.entity';
import { IAuth } from '../interfaces/auth.interface';

export const AUTH_REPOSITORY_TOKEN = Symbol('AuthRepository');

export interface IAuthRepository {
    saveRefreshToken(auth: IAuth): Promise<AuthEntity | undefined>;

    updateRefreshToken(auth: Partial<IAuth>): Promise<AuthEntity | undefined>;

    findRefreshToken(auth: Partial<IAuth>): Promise<AuthModel | undefined>;

    deactivateRefreshToken(auth: Partial<IAuth>): Promise<void>;
}
