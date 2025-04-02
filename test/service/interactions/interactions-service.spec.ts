import { InteractionDto } from '@/shared/domain/dtos/interaction.dtos';
import { InteractionService } from '@/core/infrastructure/adapters/services/interaction.service';
import { IInteractionExecutionRepository } from '@/core/domain/interactions/contracts/interaction.repository.contracts';

describe('InteractionService', () => {
    // should create a new interaction with valid input data
    it('should create a new interaction with valid input data', async () => {
        const interactionDto: InteractionDto = {
            interactionType: 'chat',
            interactionCommand: 'text',
            platformUserId: 'user1',
            organizationAndTeamData: {
                organizationId: 'org1',
                teamId: 'team1',
            },
        };

        const interactionRepositoryMock: IInteractionExecutionRepository = {
            create: jest.fn(),
        };

        const teamServiceMock: any = {
            findOneByOrganizationId: jest.fn().mockResolvedValue({
                uuid: interactionDto?.organizationAndTeamData?.teamId,
            }),
        };

        const loggerServiceMock: any = {
            error: jest.fn(),
        };

        const interactionService = new InteractionService(
            interactionRepositoryMock,
            loggerServiceMock,
            teamServiceMock,
        );

        await interactionService.createInteraction(interactionDto);

        expect(interactionRepositoryMock.create).toHaveBeenCalledWith({
            platformUserId: interactionDto.platformUserId,
            interactionDate: expect.any(Date),
            interactionType: interactionDto.interactionType,
            organizationId:
                interactionDto.organizationAndTeamData.organizationId,
            organizationAndTeamData: {
                organizationId:
                    interactionDto.organizationAndTeamData.organizationId,
                teamId: interactionDto.organizationAndTeamData.teamId,
            },
            teamId: interactionDto.organizationAndTeamData.teamId,
            interactionCommand: interactionDto.interactionCommand,
        });
    });

    //should create a new interaction with valid input data and interaction type is command
    it('should create a new interaction with valid input data and interaction type is command', async () => {
        const interactionDto: InteractionDto = {
            interactionType: 'command',
            interactionCommand: 'command1',
            platformUserId: 'user1',
            organizationAndTeamData: {
                organizationId: 'org1',
                teamId: 'team1',
            },
        };

        const interactionRepositoryMock: IInteractionExecutionRepository = {
            create: jest.fn(),
        };
        const teamServiceMock: any = {
            findOneByOrganizationId: jest.fn().mockResolvedValue({
                uuid: interactionDto?.organizationAndTeamData?.teamId,
            }),
        };

        const loggerServiceMock: any = {
            error: jest.fn(),
        };

        const interactionService = new InteractionService(
            interactionRepositoryMock,
            loggerServiceMock,
            teamServiceMock,
        );

        await interactionService.createInteraction(interactionDto);

        expect(interactionRepositoryMock.create).toHaveBeenCalledWith({
            platformUserId: interactionDto.platformUserId,
            interactionDate: expect.any(Date),
            interactionType: interactionDto.interactionType,
            organizationId:
                interactionDto.organizationAndTeamData.organizationId,
            organizationAndTeamData: {
                organizationId:
                    interactionDto.organizationAndTeamData.organizationId,
                teamId: interactionDto.organizationAndTeamData.teamId,
            },
            teamId: interactionDto.organizationAndTeamData.teamId,
            interactionCommand: interactionDto.interactionCommand,
        });
    });

    // should create a new interaction with valid input data and interaction type is button
    it('should create a new interaction with valid input data and interaction type is button', async () => {
        const interactionDto: InteractionDto = {
            interactionType: 'button',
            interactionCommand: 'command1',
            buttonLabel: 'button1',
            platformUserId: 'user1',
            organizationAndTeamData: {
                organizationId: 'org1',
                teamId: 'team1',
            },
        };

        const interactionRepositoryMock: IInteractionExecutionRepository = {
            create: jest.fn(),
        };
        const teamServiceMock: any = {
            findOneByOrganizationId: jest.fn().mockResolvedValue({
                uuid: interactionDto?.organizationAndTeamData?.teamId,
            }),
        };

        const loggerServiceMock: any = {
            error: jest.fn(),
        };

        const interactionService = new InteractionService(
            interactionRepositoryMock,
            loggerServiceMock,
            teamServiceMock,
        );

        await interactionService.createInteraction(interactionDto);

        expect(interactionRepositoryMock.create).toHaveBeenCalledWith({
            platformUserId: interactionDto.platformUserId,
            interactionDate: expect.any(Date),
            interactionType: interactionDto.interactionType,
            organizationId:
                interactionDto.organizationAndTeamData.organizationId,
            organizationAndTeamData: {
                organizationId:
                    interactionDto.organizationAndTeamData.organizationId,
                teamId: interactionDto.organizationAndTeamData.teamId,
            },
            teamId: interactionDto.organizationAndTeamData.teamId,
            interactionCommand: interactionDto.interactionCommand,
            buttonLabel: interactionDto.buttonLabel,
        });
    });

    // should create a new interaction with valid input data and teamId is provided
    it('should create a new interaction with valid input data and teamId is provided', async () => {
        const interactionDto: InteractionDto = {
            interactionType: 'chat',
            interactionCommand: 'text',
            platformUserId: 'user1',
            organizationAndTeamData: {
                organizationId: 'org1',
                teamId: 'team1',
            },
        };

        const interactionRepositoryMock: IInteractionExecutionRepository = {
            create: jest.fn(),
        };
        const teamServiceMock: any = {
            findOneByOrganizationId: jest.fn().mockResolvedValue({
                uuid: interactionDto.organizationAndTeamData.teamId,
            }),
        };
        const loggerServiceMock: any = {
            error: jest.fn(),
        };

        const interactionService = new InteractionService(
            interactionRepositoryMock,
            loggerServiceMock,
            teamServiceMock,
        );

        await interactionService.createInteraction(interactionDto);

        expect(interactionRepositoryMock.create).toHaveBeenCalledWith({
            platformUserId: interactionDto.platformUserId,
            interactionDate: expect.any(Date),
            interactionType: interactionDto.interactionType,
            organizationId:
                interactionDto.organizationAndTeamData.organizationId,
            organizationAndTeamData: {
                organizationId:
                    interactionDto.organizationAndTeamData.organizationId,
                teamId: interactionDto.organizationAndTeamData.teamId,
            },
            teamId: interactionDto.organizationAndTeamData.teamId,
            interactionCommand: interactionDto.interactionCommand,
        });
    });
});
