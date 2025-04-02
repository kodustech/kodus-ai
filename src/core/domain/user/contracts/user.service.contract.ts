import { UserEntity } from '../entities/user.entity';
import { IUser } from '../interfaces/user.interface';
import { IUserRepository } from './user.repository.contract';

export const USER_SERVICE_TOKEN = Symbol('UserService');

export interface IUsersService extends IUserRepository {
    checkPassword(email: string, password: string): Promise<boolean>;
    register(payload: Omit<IUser, 'uuid'>): Promise<UserEntity>;
}
