import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';
import {
    IProfileConfigRepository,
    PROFILE_CONFIG_REPOSITORY_TOKEN,
} from '@libs/identity/domain/profile-configs/contracts/profileConfig.repository.contract';
import { IProfileConfigService } from '@libs/identity/domain/profile-configs/contracts/profileConfig.service.contract';
import { ProfileConfigEntity } from '@libs/identity/domain/profile-configs/entities/profileConfig.entity';
import { ProfileConfigKey } from '@libs/identity/domain/profile-configs/enum/profileConfigKey.enum';
import { IProfileConfig } from '@libs/identity/domain/profile-configs/interfaces/profileConfig.interface';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@libs/identity/domain/user/contracts/user.service.contract';

@Injectable()
export class ProfileConfigService implements IProfileConfigService {
    constructor(
        @Inject(PROFILE_CONFIG_REPOSITORY_TOKEN)
        private readonly profileConfigRepository: IProfileConfigRepository,

        @Inject(USER_SERVICE_TOKEN)
        private readonly usersService: IUsersService,

        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,
    ) {}

    findProfileIdsByOrganizationAndRole(
        organizationId: string,
        role: Role,
    ): Promise<string[]> {
        throw new Error('Method not implemented.');
    }

    async createOrUpdateConfig(
        profileConfigKey: ProfileConfigKey,
        payload: any,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const profileIds =
                await this.usersService.findProfileIdsByOrganizationAndRole(
                    organizationAndTeamData.organizationId,
                    Role.OWNER,
                );

            profileIds.forEach(async (profileId) => {
                const profileConfig = await this.findOne({
                    profile: { uuid: profileId },
                    configKey: profileConfigKey,
                });

                if (!profileConfig) {
                    const uuid = uuidv4();

                    return this.create({
                        uuid: uuid,
                        configKey: profileConfigKey,
                        configValue: payload,
                        status: true,
                        profile: { uuid: profileId },
                    });
                } else {
                    return this.update(
                        {
                            uuid: profileConfig?.uuid,
                            profile: { uuid: profileId },
                        },
                        {
                            configKey: profileConfigKey,
                            configValue: payload,
                            status: true,
                            profile: { uuid: profileId },
                        },
                    );
                }
            });
        } catch (err) {
            throw new BadRequestException(err);
        }
    }

    findProfileConfigFormatted<T>(
        configKey: ProfileConfigKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<T> {
        try {
            // const data = await this.findOneIntegrationConfigWithIntegrations(
            //     configKey,
            //     organizationAndTeamData,
            // );

            // if (!data?.configValue) {
            //     return null;
            // }

            // // Check if payload is an array and return as such
            // if (Array.isArray(data.configValue)) {
            //     return [...data.configValue] as T;
            // }

            // // If not an array, return as an object
            // return { ...data.configValue } as T;
            return null;
        } catch (error) {
            console.log(error);
        }
    }

    find(filter?: Partial<IProfileConfig>): Promise<ProfileConfigEntity[]> {
        return this.profileConfigRepository.find(filter);
    }

    async findProfileConfigOrganizationOwner(
        organization_id: string,
    ): Promise<ProfileConfigEntity> {
        try {
            const owner = await this.usersService.findOne({
                organization: {
                    uuid: organization_id,
                },
                role: Role.OWNER,
            });

            const ownerProfile = await this.profileService.findOne({
                user: { uuid: owner.uuid },
            });

            const ownerProfileConfig = await this.findOne({
                profile: {
                    uuid: ownerProfile.uuid,
                },
            });

            return ownerProfileConfig;
        } catch (err) {
            console.error(
                'Error while fetching the owner profile configuration:',
                err,
            );

            throw new Error(
                'Failed to retrieve the organization owner profile configuration',
                { cause: err },
            );
        }
    }

    findOne(filter?: Partial<IProfileConfig>): Promise<ProfileConfigEntity> {
        return this.profileConfigRepository.findOne(filter);
    }
    create(profileConfig: IProfileConfig): Promise<ProfileConfigEntity> {
        return this.profileConfigRepository.create(profileConfig);
    }
    update(
        filter: Partial<IProfileConfig>,
        data: Partial<IProfileConfig>,
    ): Promise<ProfileConfigEntity> {
        return this.profileConfigRepository.update(filter, data);
    }
    delete(uuid: string): Promise<void> {
        return this.profileConfigRepository.delete(uuid);
    }
}
