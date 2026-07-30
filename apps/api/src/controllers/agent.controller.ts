import { createThreadId } from '@libs/common/utils/thread-id';
import { ConversationAgentUseCase } from '@libs/agents/application/use-cases/conversation-agent.use-case';
import { OrganizationAndTeamDataDto } from '@libs/core/domain/dtos/organizationAndTeamData.dto';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { Body, Controller, Inject, Post } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import {
    ApiTags,
    ApiBearerAuth,
    ApiOkResponse,
    ApiOperation,
} from '@nestjs/swagger';
import { ApiStandardResponses } from '../docs/api-standard-responses.decorator';

@ApiTags('Agent')
@ApiBearerAuth('jwt')
@ApiStandardResponses()
@Controller('agent')
export class AgentController {
    constructor(
        private readonly conversationAgentUseCase: ConversationAgentUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post('/conversation')
    @ApiOperation({
        summary: 'Start agent conversation',
        description: 'Send a prompt to the agent and return its response.',
    })
    @ApiOkResponse({
        description: 'Agent response (plain text or JSON string)',
        schema: { type: 'string' },
    })
    public async conversation(
        @Body()
        body: {
            prompt: string;
            organizationAndTeamData: OrganizationAndTeamDataDto;
            /** Optional client-supplied conversation id. When provided, scopes
             *  the thread (and its persisted session) to a single conversation
             *  instead of falling back to a per-user thread. */
            conversationId?: string;
        },
    ) {
        const organizationId = this.request?.user?.organization?.uuid;
        const userId = this.request?.user?.uuid;

        if (!organizationId) {
            throw new Error('Organization ID missing in user request');
        }

        // Thread granularity matters: it keys both log/trace correlation and the
        // persisted `kodus-agent-sessions` record. With only org+team, every
        // user and conversation of a team would collapse onto one thread/record,
        // so we add the user (and an optional conversation id) to keep distinct
        // chats from bleeding into the same session document.
        const thread = createThreadId(
            {
                organizationId,
                teamId: body.organizationAndTeamData.teamId,
                ...(userId ? { userId } : {}),
                ...(body.conversationId
                    ? { conversationId: body.conversationId }
                    : {}),
            },
            {
                prefix: 'cmc', // Code Management Chat
            },
        );

        return this.conversationAgentUseCase.execute({ ...body, thread });
    }
}
