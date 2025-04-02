import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';

import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@/core/domain/profile/contracts/profile.service.contract';
import { IProfile } from '@/core/domain/profile/interfaces/profile.interface';

export class CreateProfileUseCase implements IUseCase {
    constructor(
        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,
    ) { }

    public async execute(
        payload: Partial<IProfile>,
    ): Promise<void> {
        await this.profileService.updateByUserId(payload.user.uuid, {
            ...payload,
            name: payload?.name,
            status: true,
            user: {
                uuid: payload?.user?.uuid,
            },
        });
    }
}
