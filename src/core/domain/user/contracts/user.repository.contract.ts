import { STATUS } from '@/config/types/database/status.type';
import { UserEntity } from '../entities/user.entity';
import { UserRole } from '../enums/userRole.enum';
import { IUser } from '../interfaces/user.interface';

export const USER_REPOSITORY_TOKEN = Symbol('UserRepository');

export interface IUserRepository {
    find(filter: Partial<IUser>): Promise<UserEntity[]>;
    getLoginData(email: string): Promise<UserEntity | undefined>;
    find(filter: Partial<IUser>, statusArray?: STATUS[]): Promise<UserEntity[]>;
    findOne(filter: Partial<IUser>): Promise<UserEntity | undefined>;
    count(filter: Partial<IUser>): Promise<number>;
    // getLoginData(email: string): Promise<UserEntity | undefined>;
    getCryptedPassword(email: string): Promise<string | undefined>;
    findById(uuid: string): Promise<UserEntity | undefined>;
    create(userEntity: IUser): Promise<UserEntity | undefined>;
    update(
        filter: Partial<IUser>,
        data: Partial<IUser>,
    ): Promise<UserEntity | undefined>;
    delete(uuid: string): Promise<void>;

    findProfileIdsByOrganizationAndRole(
        organizationId: string,
        role: UserRole,
    ): Promise<string[]>;
    findUsersWithEmailsInDifferentOrganizations(
        emails: string[],
        organizationId: string,
    );
}
