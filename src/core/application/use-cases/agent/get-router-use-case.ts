import {
    AGENT_SERVICE_TOKEN,
    IAgentService,
} from '@/core/domain/agents/contracts/agent.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class GetRouterUseCase {
    constructor(
        @Inject(AGENT_SERVICE_TOKEN)
        private readonly agentService: IAgentService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: any) {
        return await this.agentService.getRouter({
            message: params.message,
            memory: params.memory,
            organizationAndTeamData: params.organizationAndTeamData,
            authDetailsParams: params.authDetailsParams,
            sessionId: params?.sessionId,
            route: params?.route,
            platformType: params?.platformType,
        });
    }
}
