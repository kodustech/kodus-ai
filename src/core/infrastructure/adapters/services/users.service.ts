import { Inject, Injectable } from '@nestjs/common';
import {
    IUserRepository,
    USER_REPOSITORY_TOKEN,
} from '@/core/domain/user/contracts/user.repository.contract';
import { v4 as uuidv4 } from 'uuid';
import { UserEntity } from '@/core/domain/user/entities/user.entity';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import {
    AUTH_SERVICE_TOKEN,
    IAuthService,
} from '@/core/domain/auth/contracts/auth.service.contracts';
import { UserRole } from '@/core/domain/user/enums/userRole.enum';
import { STATUS } from '@/config/types/database/status.type';

@Injectable()
export class UsersService {
    constructor(
        @Inject(AUTH_SERVICE_TOKEN)
        private readonly authService: IAuthService,
        @Inject(USER_REPOSITORY_TOKEN)
        private readonly userRepository: IUserRepository,
    ) {}

    public find(
        filter: Partial<IUser>,
        statusArray?: STATUS[],
    ): Promise<UserEntity[]> {
        return this.userRepository.find(filter, statusArray);
    }

    public findOne(filter: Partial<IUser>, statusA): Promise<UserEntity> {
        return this.userRepository.findOne(filter);
    }

    public count(filter: Partial<IUser>): Promise<number> {
        return this.userRepository.count(filter);
    }

    public getLoginData(email: string): Promise<UserEntity> {
        return this.userRepository.getLoginData(email);
    }

    public findById(uuid: string): Promise<UserEntity> {
        return this.userRepository.findById(uuid);
    }

    public async checkPassword(
        email: string,
        password: string,
    ): Promise<boolean> {
        const cryptedPassword =
            await this.userRepository.getCryptedPassword(email);
        if (cryptedPassword) {
            const passwordMatches = await this.authService.match(
                password,
                cryptedPassword,
            );

            return passwordMatches;
        }

        return false;
    }

    public async register(payload: Omit<IUser, 'uuid'>): Promise<UserEntity> {
        const uuid = uuidv4();
        const password = await this.authService.hashPassword(
            payload.password,
            10,
        );

        return this.userRepository.create({
            ...payload,
            uuid,
            password,
        });
    }

    // public updateProfile(
    //     userId: string,
    //     data: Partial<ProfileEntity>,
    // ): Promise<IProfile> {
    //     return this.userRepository.updateProfile(userId, data);
    // }

    public update(
        filter: Partial<IUser>,
        data: Partial<IUser>,
    ): Promise<UserEntity> {
        return this.userRepository.update(filter, data);
    }

    public async delete(uuid: string): Promise<void> {
        await this.userRepository.delete(uuid);
    }

    async findProfileIdsByOrganizationAndRole(
        organizationId: string,
        role: UserRole,
    ): Promise<string[]> {
        return this.userRepository.findProfileIdsByOrganizationAndRole(
            organizationId,
            role,
        );
    }

    async findUsersWithEmailsInDifferentOrganizations(
        emails: string[],
        organizationId: string,
    ) {
        return this.userRepository.findUsersWithEmailsInDifferentOrganizations(
            emails,
            organizationId,
        );
    }
}
