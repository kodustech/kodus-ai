import { AuthMode } from '@/core/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { CreateAuthIntegrationStatus } from '@/shared/domain/enums/create-auth-integration-status.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class CreateIntegrationUseCase implements IUseCase {
    constructor(
        private readonly codeManagementService: CodeManagementService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private readonly logger: PinoLoggerService,
    ) {}

    public async execute(params: any): Promise<any> {
        const authMode = params?.authMode ?? AuthMode.OAUTH;

        return await this.codeManagementService.createAuthIntegration(
            {
                ...params,
                organizationAndTeamData: {
                    organizationId:
                        params?.organizationAndTeamData?.organizationId ||
                        this.request.user?.organization?.uuid,
                    teamId: params?.organizationAndTeamData?.teamId,
                },
                authMode,
            },
            params.integrationType,
        );
    }
}
