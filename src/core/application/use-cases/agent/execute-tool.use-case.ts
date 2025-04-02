import {
    AGENT_SERVICE_TOKEN,
    IAgentService,
} from '@/core/domain/agents/contracts/agent.service.contracts';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class ExecuteToolUseCase {
    constructor(
        @Inject(AGENT_SERVICE_TOKEN)
        private readonly agentService: IAgentService,
    ) {}

    async execute(params: any) {
        const organizationAndTeamData = {
            organizationId: params.organizationId,
            teamId: params.teamId,
        };

        return await this.agentService.executeTools(
            'codereview',
            organizationAndTeamData,
        );
    }
}
