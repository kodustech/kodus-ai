import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { UpdateProfileUseCase } from '../profile/update.use-case';

export class UpdateInfoOrganizationAndPhoneUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        private readonly updateProfileUseCase: UpdateProfileUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },
    ) {}

    public async execute(payload: any): Promise<boolean> {
        try {
            const organizationId = this.request.user.organization.uuid;
            const userId = this.request.user.uuid;

            await this.organizationService.update(
                { uuid: organizationId },
                { name: payload.name },
            );

            if (payload?.phone) {
                await this.updateProfileUseCase.execute({
                    user: { uuid: userId },
                    phone: payload?.phone,
                });
            }

            return true;
        } catch (error) {
            return false;
        }
    }
}
