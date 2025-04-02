import { Inject, Injectable } from '@nestjs/common';

import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

import { ActiveTeamAutomationsUseCase } from '../teamAutomation/activeTeamAutomationsUseCase';
import { ActiveOrganizationAutomationsUseCase } from '../organizationAutomation/activeOrganizationAutomationsUseCase';

@Injectable()
export class ActiveAllAutomationsUseCase {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private readonly activeTeamAutomationsUseCase: ActiveTeamAutomationsUseCase,

        private readonly activeOrganizationAutomationsUseCase: ActiveOrganizationAutomationsUseCase,
    ) {}

    async execute(teamId: string) {
        if (!teamId) {
            throw new Error('Team ID not provided');
        }

        const orgUuid = this.request.user?.organization?.uuid;

        if (!orgUuid) {
            throw new Error('Organization UUID not found');
        }

        // Update team automations
        await this.activeTeamAutomationsUseCase.execute(teamId);

        // Update organization automations
        await this.activeOrganizationAutomationsUseCase.execute();
    }
}
