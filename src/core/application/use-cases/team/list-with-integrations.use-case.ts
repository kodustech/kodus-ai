
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { TEAM_SERVICE_TOKEN, ITeamService } from '@/core/domain/team/contracts/team.service.contract';
import { REQUEST } from '@nestjs/core';
import { STATUS } from '@/config/types/database/status.type';
import { IntegrationStatusFilter, ITeamWithIntegrations } from '@/core/domain/team/interfaces/team.interface';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

@Injectable()
export class ListTeamsWithIntegrationsUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(): Promise<ITeamWithIntegrations[]> {
        return await this.teamService.findTeamsWithIntegrations(
            {
                organizationId: this.request.user.organization.uuid,
                status: STATUS.ACTIVE,
                integrationStatus: IntegrationStatusFilter.INTEGRATED,
                integrationCategories: [
                    IntegrationCategory.CODE_MANAGEMENT,
                    IntegrationCategory.PROJECT_MANAGEMENT,
                    IntegrationCategory.COMMUNICATION,
                ],
            },
        );
    }
}
