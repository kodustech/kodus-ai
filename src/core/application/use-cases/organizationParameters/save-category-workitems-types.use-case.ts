import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { OrganizationParametersService } from '@/core/infrastructure/adapters/services/organizationParameters.service';
import { OrganizationParametersKey } from '@/shared/domain/enums/organization-parameters-key.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

export class SaveCategoryWorkItemsTypesUseCase implements IUseCase {
    constructor(
        private readonly organizationParametersService: OrganizationParametersService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid };
        },
    ) {}

    execute(organizationAndTeamData: OrganizationAndTeamData): Promise<any> {
        return this.organizationParametersService.createOrUpdateWorkItemsConfig(
            OrganizationParametersKey.CATEGORY_WORKITEM_TYPES,
            organizationAndTeamData,
        );
    }
}
