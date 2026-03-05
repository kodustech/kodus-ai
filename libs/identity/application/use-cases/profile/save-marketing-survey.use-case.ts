import { Inject } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import {
    IProfileService,
    PROFILE_SERVICE_TOKEN,
} from '@libs/identity/domain/profile/contracts/profile.service.contract';

export class SaveMarketingSurveyUseCase implements IUseCase {
    constructor(
        @Inject(PROFILE_SERVICE_TOKEN)
        private readonly profileService: IProfileService,
    ) {}

    public async execute(
        userId: string,
        data: { referralSource?: string; primaryGoal?: string },
    ): Promise<void> {
        const updatePayload: { referralSource?: string; primaryGoal?: string } =
            {};

        if (data.referralSource !== undefined) {
            updatePayload.referralSource = data.referralSource;
        }
        if (data.primaryGoal !== undefined) {
            updatePayload.primaryGoal = data.primaryGoal;
        }

        if (Object.keys(updatePayload).length > 0) {
            await this.profileService.update(
                { user: { uuid: userId } },
                updatePayload,
            );
        }
    }
}
