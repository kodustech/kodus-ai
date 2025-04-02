import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';

import { CreateConversationUseCase } from '@/core/application/use-cases/conversation/create-conversation.use-case';
import { CreateConversationDto } from '@/core/infrastructure/http/dtos/create-conversation.dto';
import { ListConversationsUseCase } from '@/core/application/use-cases/conversation/list-conversations.use-case';
import { ListConversationByIdUseCase } from '@/core/application/use-cases/conversation/list-conversation-by-id.use-case';
import { UpdateConversationTitleUseCase } from '@/core/application/use-cases/conversation/update-conversation-title.use-case';
import { UpdateConversationTitleDto } from '../dtos/update-conversation-title-dto';
import { DeleteConversationUseCase } from '@/core/application/use-cases/conversation/delete-conversation.use-case';
import { SendMessageConversationUseCase } from '@/core/application/use-cases/conversation/send-message.use-case';

@Controller('conversation')
export class ConversationController {
    constructor(
        private readonly createConversationUseCase: CreateConversationUseCase,
        private readonly listConversationUseCase: ListConversationsUseCase,
        private readonly listConversationByIdUseCase: ListConversationByIdUseCase,
        private readonly updateConversationTitleUseCase: UpdateConversationTitleUseCase,
        private readonly deleteConversationUseCase: DeleteConversationUseCase,
        private readonly sendMessageConversationUseCase: SendMessageConversationUseCase,
    ) {}

    @Post('/')
    public async createConversation(@Body() body: CreateConversationDto) {
        return await this.createConversationUseCase.execute(body);
    }

    @Get('/')
    public async listConversations(@Query('teamId') teamId: string) {
        return await this.listConversationUseCase.execute(teamId);
    }

    @Get('/:id')
    public async listConversationById(
        @Param('id')
        id: string,
    ) {
        return await this.listConversationByIdUseCase.execute(id);
    }

    @Post(':id/message')
    async sendMessage(
        @Param('id') chatId: string,
        @Body() body: { message: string; teamId: string },
    ) {
        return await this.sendMessageConversationUseCase.execute({
            ...body,
            chatId,
        });
    }

    @Patch('/:id')
    public async updateConversationTitle(
        @Param('id')
        id: string,
        @Body()
        body: UpdateConversationTitleDto,
    ) {
        const { title } = body;

        return await this.updateConversationTitleUseCase.execute(id, title);
    }

    @Delete('/:id')
    public async deleteConversation(
        @Param('id')
        id: string,
    ) {
        return await this.deleteConversationUseCase.execute(id);
    }
}
