import { RunParams } from '@/config/types/general/agentRouter.type';

import { IAgentRouterStrategy } from '@/shared/domain/contracts/agent-router.strategy.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { CommunicationService } from '../../platformIntegration/communication.service';
import { PinoLoggerService } from '../../logger/pino.service';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { STATUS } from '@/config/types/database/status.type';

@Injectable()
export class TeamSelectionAgentProvider
    implements Omit<IAgentRouterStrategy, 'runTools'>
{
    name: 'TeamSelectionAgent';

    constructor(
        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
        private readonly communication: CommunicationService,

        private logger: PinoLoggerService,
    ) {}

    async run(runParams: RunParams): Promise<any> {
        try {
            const { parameters } = runParams;

            if (parameters && parameters.length > 0) {
                const error = parameters.find((item) => item.hasError);

                if (error && error.type === 'Engineer') {
                    return {
                        response:
                            'You do not have permission to view information about this team, please contact the administrator',
                    };
                }
            }

            const teams = await this.teamService.find(
                {
                    organization: {
                        uuid: runParams.organizationAndTeamData.organizationId,
                    },
                },
                [STATUS.ACTIVE],
            );

            const template = await this.communication.handlerTemplateMessage(
                {
                    methodName: 'getContextConversationTeam',
                    organizationAndTeamData: runParams.organizationAndTeamData,
                    message: runParams.message,
                    teams,
                },
                runParams.platformType,
            );

            return {
                response: template,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error while executing sendMessageContextTeam',
                context: TeamSelectionAgentProvider.name,
                error: error,
            });
        }
    }
}
