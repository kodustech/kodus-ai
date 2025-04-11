import {
    AGENT_EXECUTION_SERVICE_TOKEN,
    IAgentExecutionService,
} from '@/core/domain/agents/contracts/agent-execution.service.contracts';
import {
    AGENT_SERVICE_TOKEN,
    IAgentService,
} from '@/core/domain/agents/contracts/agent.service.contracts';
import {
    ISessionService,
    SESSION_SERVICE_TOKEN,
} from '@/core/domain/automation/contracts/session.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { PlatformType } from '@/shared/domain/enums/platform-type.enum';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { CreateOrUpdateParametersUseCase } from '../parameters/create-or-update-use-case';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

@Injectable()
export class ExecutionAgentPromptUseCase {
    constructor(
        @Inject(AGENT_SERVICE_TOKEN)
        private readonly agentService: IAgentService,

        @Inject(AGENT_EXECUTION_SERVICE_TOKEN)
        private readonly agentExecutionService: IAgentExecutionService,

        @Inject(SESSION_SERVICE_TOKEN)
        private readonly sessionService: ISessionService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string };
        },

        private readonly createOrUpdateParametersUseCase: CreateOrUpdateParametersUseCase,

        private logger: PinoLoggerService,
    ) {}

    async execute(params: any) {
        const userId = this.request.user?.uuid;
        const organizationId = this.request.user?.organization.uuid;
        const { type, teamId } = params;

        if (!type) {
            throw new Error('Router not found');
        }

        const agentExecution = await this.agentExecutionService.findOne({
            teamId,
            platformUserId: userId,
            platformName: PlatformType.KODUS_WEB,
            metaData: { processType: type },
        });

        if (agentExecution && agentExecution?.sessionId) {
            return agentExecution.responseMessage;
        } else {
            const newSession = await this.sessionService.register({
                platformUserId: userId,
                platformName: PlatformType.KODUS_WEB,
                route: 'default',
                date: Date.now(),
                teamId: teamId,
                organizationId: organizationId,
            });

            const result = await this.agentService.executionRouterPrompt({
                router: { route: type } as any,
                message: '',
                userId: userId,
                channel: params.channel,
                sessionId: newSession?.uuid,
                userName: params.userName,
                organizationAndTeamData: {
                    organizationId,
                    teamId,
                },
                platformType: PlatformType.KODUS_WEB,
                metaData: { processType: type },
            });

            await this.savePlatformConfig({ teamId, organizationId });

            return result;
        }
    }

    async executeRouterPrompt(params: any) {
        return await this.agentService.executionRouterPrompt(params);
    }

    private async savePlatformConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        await this.createOrUpdateParametersUseCase.execute(
            ParametersKey.PLATFORM_CONFIGS,
            {
                finishOnboard: true,
                finishProjectManagementConnection: false,
            },
            organizationAndTeamData,
        );
    }
}
