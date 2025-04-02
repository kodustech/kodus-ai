import { CreateConversationUseCase } from './create-conversation.use-case';
import { DeleteConversationUseCase } from './delete-conversation.use-case';
import { ListConversationByIdUseCase } from './list-conversation-by-id.use-case';
import { ListConversationsUseCase } from './list-conversations.use-case';
import { SendMessageConversationUseCase } from './send-message.use-case';
import { UpdateConversationTitleUseCase } from './update-conversation-title.use-case';

export const UseCases = [
    CreateConversationUseCase,
    ListConversationsUseCase,
    ListConversationByIdUseCase,
    UpdateConversationTitleUseCase,
    DeleteConversationUseCase,
    SendMessageConversationUseCase,
];
