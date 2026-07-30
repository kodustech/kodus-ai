import {
    IInteractionExecutionRepository,
    INTERACTION_EXECUTION_REPOSITORY_TOKEN,
} from '@libs/analytics/domain/interactions/contracts/interaction.repository.contracts';
import { IInteractionService } from '@libs/analytics/domain/interactions/contracts/interaction.service.contracts';
import { InteractionDto } from '@libs/core/domain/dtos/interaction.dtos';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@libs/organization/domain/team/contracts/team.service.contract';
import { Inject } from '@nestjs/common';
import { createLogger } from '@libs/core/log/logger';

export class InteractionService implements IInteractionService {
    private readonly logger = createLogger(InteractionService.name);

    constructor(
        @Inject(INTERACTION_EXECUTION_REPOSITORY_TOKEN)
        private readonly interactionRepository: IInteractionExecutionRepository,
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
                error: error,
                context: InteractionService.name,
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
