import { IInteractionService } from '@/core/domain/interactions/contracts/interaction.service.contracts';
import { Inject } from '@nestjs/common';
import {
    IInteractionExecutionRepository,
    INTERACTION_EXECUTION_REPOSITORY_TOKEN,
} from '@/core/domain/interactions/contracts/interaction.repository.contracts';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import { InteractionDto } from '@/shared/domain/dtos/interaction.dtos';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';

export class InteractionService implements IInteractionService {
    constructor(
        @Inject(INTERACTION_EXECUTION_REPOSITORY_TOKEN)
        private readonly interactionRepository: IInteractionExecutionRepository,

        @Inject(PinoLoggerService)
        private readonly logger: PinoLoggerService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,
    ) {}

    async createInteraction(interaction: InteractionDto): Promise<void> {
        try {
            const resolvedTeamId = await this.getTeamId(
                interaction.organizationAndTeamData,
            );

            await this.interactionRepository.create({
                ...interaction,
                organizationId:
                    interaction?.organizationAndTeamData?.organizationId,
                interactionDate: new Date(),
                teamId: resolvedTeamId,
            });
        } catch (error) {
            this.logger.error({
                message: 'Failed to connect to the database',
                context: InteractionService.name,
                error: error,
                metadata: { attempt: 1 },
            });
        }
    }

    private async getTeamId(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        try {
            if (!organizationAndTeamData.teamId) {
                const team = await this.teamService.findOneByOrganizationId(
                    organizationAndTeamData.organizationId,
                );
                return team?.uuid;
            }

            return organizationAndTeamData.teamId;
        } catch (error) {
            this.logger.error({
                message: 'Failed to fetch the teamId',
                context: InteractionService.name,
                error: error,
                metadata: { attempt: 1 },
            });
        }
    }
}
