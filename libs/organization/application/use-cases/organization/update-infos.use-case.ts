import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UpdateProfileUseCase } from '@libs/identity/application/use-cases/profile/update.use-case';
import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@libs/organization/domain/organization/contracts/organization.service.contract';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { TelemetryService } from '@libs/telemetry/application/services/telemetry.service';

export class UpdateInfoOrganizationAndPhoneUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        private readonly updateProfileUseCase: UpdateProfileUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },

        private readonly telemetry: TelemetryService,
    ) {}

    public async execute(payload: any): Promise<boolean> {
        try {
            const organizationId = this.request.user.organization.uuid;
            const userId = this.request.user.uuid;

            const organization = await this.organizationService.update(
                { uuid: organizationId },
                { name: payload.name },
            );

            if (payload?.phone) {
                await this.updateProfileUseCase.execute({
                    user: { uuid: userId },
                    phone: payload?.phone,
                });
            }

            if (organization?.uuid) {
                void this.telemetry.organizationUpdated({
                    organizationId: organization.uuid,
                    name: organization.name,
                    tenantName: organization.tenantName,
                });
            }

            return true;
        } catch {
            return false;
        }
    }
}
