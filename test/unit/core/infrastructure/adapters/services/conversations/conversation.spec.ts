import { CONVERSATION_REPOSITORY_TOKEN, IConversationRepository } from "@/core/domain/conversation/contracts/conversations.repository.contracts";
import { SenderType } from "@/core/domain/conversation/enum/SenderType";
import { ConversationService } from "@/core/infrastructure/adapters/services/conversation.service";

import { Test, TestingModule } from "@nestjs/testing";

describe("ConversationService", () => {
    let conversationService: ConversationService;
    let conversationRepository: IConversationRepository;

    const mockConversationRepository = {
        create: jest.fn(),
        findOne: jest.fn(),
        list: jest.fn(),
    }

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                ConversationService,
                {
                    provide: CONVERSATION_REPOSITORY_TOKEN,
                    useValue: mockConversationRepository
                },
            ]
        }).compile();

        conversationService = module.get<ConversationService>(ConversationService);
        conversationRepository = module.get<IConversationRepository>(CONVERSATION_REPOSITORY_TOKEN);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    const CONVERSATION_TITLE = "conversation title";

    it("Should be able to register a new conversation", async () => {

        const mockConversation = {
            title: CONVERSATION_TITLE,
            type: SenderType.USER,
            sessionId: "SessionId",
        };

        (conversationRepository.create as jest.Mock).mockResolvedValue(mockConversation);

        const createdConversation = await conversationService.create(mockConversation);

        expect(createdConversation).toEqual(mockConversation);
        expect(conversationRepository.create).toHaveBeenCalledWith(mockConversation);
    });

    // it("Should not register a new conversation if the user does not exist", async () => { });
    // it("Should be able to list users conversation given their id", async () => { });
    // it("Should not be able to list conversations if the userId is undefined", async () => { });

})
