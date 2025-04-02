import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetWorkspaceIdUseCase implements IUseCase {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}
    public async execute(
        platformType: PlatformType,
        teamId: string,
    ): Promise<any> {
        const organizationAndTeamData = {
            organizationId: this.request.user.organization.uuid,
            teamId,
        };

        const integration =
            (await this.integrationService.getFullIntegrationDetails(
                organizationAndTeamData,
                platformType,
            )) as any;

        return platformType === PlatformType.SLACK
            ? integration?.authIntegration?.authDetails.slackTeamId
            : {
                  guildId: integration?.authIntegration?.authDetails?.guildId,
                  channelId:
                      integration?.integrationConfigs[0]?.configValue
                          ?.channelId,
              };
    }
}
