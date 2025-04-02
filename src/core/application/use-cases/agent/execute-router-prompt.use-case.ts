import {
    AGENT_SERVICE_TOKEN,
    IAgentService,
} from '@/core/domain/agents/contracts/agent.service.contracts';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ExecutionRouterPromptUseCase {
    constructor(
        @Inject(AGENT_SERVICE_TOKEN)
        private readonly agentService: IAgentService,
    ) {}

    async execute(params: any) {
        return await this.agentService.executionRouterPrompt({
            router: params.router,
            message: params.message,
            userId: params.userId,
            channel: params.channel,
            sessionId: params.sessionId,
            userName: params.userName,
            organizationAndTeamData: params.organizationAndTeamData,
            platformType: params?.platformType,
        });
    }
}
