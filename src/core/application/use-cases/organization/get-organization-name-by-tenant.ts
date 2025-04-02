import {
    IOrganizationService,
    ORGANIZATION_SERVICE_TOKEN,
} from '@/core/domain/organization/contracts/organization.service.contract';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

export class GetOrganizationNameByTenantUseCase implements IUseCase {
    constructor(
        @Inject(ORGANIZATION_SERVICE_TOKEN)
        private readonly organizationService: IOrganizationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(tenantName: string): Promise<string> {
        try {
            if (!tenantName) {
                throw new Error('Organization not found!');
            }

            const org = await this.organizationService.findOne({ tenantName });

            return org?.name;
        } catch (error) {
            throw error;
        }
    }
}
