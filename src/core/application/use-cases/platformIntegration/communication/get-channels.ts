import { Inject } from '@nestjs/common';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';

export class GetChannelsUseCase implements IUseCase {
    constructor(
        private readonly communication: CommunicationService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}
    public async execute(teamId: any) {
        return this.communication.getChannel({
            organizationAndTeamData: {
                organizationId: this.request?.user?.organization?.uuid,
                teamId,
            },
        });
    }
}
