import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { Inject, Injectable } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ISprintService,
    SPRINT_SERVICE_TOKEN,
} from '@/core/domain/sprint/contracts/sprint.service.contract';

@Injectable()
export class SprintRetroUseCase implements IUseCase {
    constructor(
        @Inject(SPRINT_SERVICE_TOKEN)
        private readonly sprintService: ISprintService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        return await this.sprintService.getCurrentAndPreviousSprintForRetro(
            organizationAndTeamData,
        );
    }
}
