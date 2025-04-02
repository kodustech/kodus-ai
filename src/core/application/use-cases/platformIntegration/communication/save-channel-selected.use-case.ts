import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { ActiveCommunicationManagementTeamAutomationsUseCase } from '../../teamAutomation/active-communication-management-automations.use-case';
import { CreateOrUpdateParametersUseCase } from '../../parameters/create-or-update-use-case';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

export class SaveChannelSelectedUseCase implements IUseCase {
    constructor(
        private readonly communication: CommunicationService,
        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,
        private readonly activeCommunicationManagementTeamAutomationsUseCase: ActiveCommunicationManagementTeamAutomationsUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) { }

    public async execute(params: any) {
        const teamId = params.teamId;
        const organizationId = this.request?.user?.organization?.uuid;

        try {
            const isChannelSelected = await this.communication.saveChannelSelected({
                ...params,
                organizationAndTeamData: {
                    organizationId: organizationId,
                    teamId: teamId,
                },
            });

            await this.saveParameters(teamId, organizationId);

            await this.activeCommunicationManagementTeamAutomationsUseCase.execute(
                teamId,
            );

            return isChannelSelected;
        } catch (err) {
            throw err;
        }
    }

    private async saveParameters(teamId: string, organizationId: string) {
        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.CHECKIN_CONFIG,
            this.prepareCheckinConfig(),
            {
                teamId: teamId,
                organizationId: organizationId,
            },
        );
    }

    private prepareCheckinConfig() {
        return [
            {
                checkinId: 'weekly-checkin',
                checkinName: 'Check-in Semanal',
                frequency: {
                    sun: false,
                    mon: false,
                    tue: false,
                    wed: false,
                    thu: false,
                    fri: true,
                    sat: false,
                },
                sections: [
                    { id: 'teamDoraMetrics', order: 1, active: true },
                    { id: 'teamFlowMetrics', order: 2, active: true },
                    { id: 'releaseNotes', order: 3, active: true },
                    { id: 'lateWorkItems', order: 4, active: true },
                    { id: 'teamArtifacts', order: 5, active: true },
                    { id: 'pullRequestsOpened', order: 6, active: true },
                ],
                checkinTime: '14:00',
            },
            {
                checkinId: 'daily-checkin',
                checkinName: 'Check-in Diário',
                frequency: {
                    sun: false,
                    mon: true,
                    tue: true,
                    wed: true,
                    thu: true,
                    fri: true,
                    sat: false,
                },
                sections: [
                    { id: 'lateWorkItems', order: 1, active: true },
                    { id: 'pullRequestsOpened', order: 2, active: true },
                    { id: 'teamArtifacts', order: 3, active: true },
                    { id: 'releaseNotes', order: 4, active: false },
                    { id: 'teamDoraMetrics', order: 5, active: false },
                    { id: 'teamFlowMetrics', order: 6, active: false },
                ],
                checkinTime: '12:00',
            },
        ];
    }
}
