import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { checkinTypeByFrequency } from '../utils/getCheckinType.utils';
import { PinoLoggerService } from '../../logger/pino.service';
import {
    SNOOZED_ITEMS_SERVICE_TOKEN,
    ISnoozedItemsService,
} from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';

@Injectable()
export class TeamArtifactsSection {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private readonly teamArtifactsService: ITeamArtifactsService,

        @Inject(SNOOZED_ITEMS_SERVICE_TOKEN)
        private readonly snoozedItemsService: ISnoozedItemsService,

        private readonly logger: PinoLoggerService,
    ) {}

    id() {
        return 'teamArtifacts';
    }

    name(frequency?) {
        return `🚨 Team alerts ${frequency === 'weekly' ? 'of the week' : frequency === 'daily' ? 'of the last 24 hours' : ''}`;
    }

    description() {
        return 'Displays the most recent team alerts.';
    }

    additionalConfigs() {
        return [
            {
                name: 'frequency',
                description: 'Defines the frequency of alerts',
            },
        ];
    }

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        frequency: string,
        snoozedItems?: any,
    ) {
        try {
            const teamArtifacts =
                await this.teamArtifactsService.getRecentTeamArtifactsWithPrevious(
                    organizationAndTeamData,
                    3,
                    frequency,
                );

            let artifactsForCheckin =
                teamArtifacts.mostRecentArtifacts?.artifacts || [];

            const checkinType = checkinTypeByFrequency.get(frequency);

            let artifactsFiltered =
                await this.snoozedItemsService.removeFromNotification(
                    artifactsForCheckin,
                    this.id(),
                    snoozedItems,
                    'name',
                    checkinType,
                    organizationAndTeamData,
                );

            return {
                sectionId: this.id(),
                sectionName: this.name(frequency),
                sectionData: artifactsFiltered,
                possibleToMutate: true,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error processing team artifacts section',
                context: TeamArtifactsSection.name,
                error: error,
                metadata: { organizationAndTeamData },
            });

            return {
                sectionId: this.id(),
                sectionName: this.name(),
                sectionData: [],
                possibleToMutate: false,
            };
        }
    }
}
