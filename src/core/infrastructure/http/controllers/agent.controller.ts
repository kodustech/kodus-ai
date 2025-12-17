import { UserRequest } from '@/config/types/http/user-request.type';
import { ConversationAgentUseCase } from '@/core/application/use-cases/agent/conversation-agent.use-case';
import { createThreadId } from '@kodus/flow';
import { Body, Controller, Inject, Post } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { OrganizationAndTeamDataDto } from '../dtos/organizationAndTeamData.dto';

@Controller('agent')
export class AgentController {
    constructor(
        private readonly conversationAgentUseCase: ConversationAgentUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/conversation')
    public async conversation(
        @Body()
        body: {
            prompt: string;
            organizationAndTeamData: OrganizationAndTeamDataDto;
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID missing in user request');
        }

        const thread = createThreadId(
            {
                organizationId,
                teamId: body.organizationAndTeamData.teamId,
            },
            {
                prefix: 'cmc', // Code Management Chat
            },
        );

        return this.conversationAgentUseCase.execute({ ...body, thread });
    }
}
