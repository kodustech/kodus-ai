import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class VerifyConnectionCommunicationListUseCase implements IUseCase {
    constructor(
        private readonly communication: CommunicationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(): Promise<any> {
        return await this.communication.verifyConnection({
            organizationId: this.request.user.organization.uuid,
        });
    }
}
