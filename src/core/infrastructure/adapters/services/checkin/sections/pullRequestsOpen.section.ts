import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { PullRequestState } from '@/shared/domain/enums/pullRequestState.enum';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import { PinoLoggerService } from '../../logger/pino.service';
import {
    ISnoozedItemsService,
    SNOOZED_ITEMS_SERVICE_TOKEN,
} from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';

@Injectable()
export class PullRequestsOpenedSection {
    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(SNOOZED_ITEMS_SERVICE_TOKEN)
        private readonly snoozedItemsService: ISnoozedItemsService,

        private readonly codeManagementService: CodeManagementService,

        private readonly logger: PinoLoggerService,
    ) {}

    id() {
        return 'pullRequestsOpened';
    }

    name() {
        return '📥 Open Pull Requests';
    }

    description() {
        return 'Displays open pull requests.';
    }

    async execute(
        organizationAndTeamData: OrganizationAndTeamData,
        frequency: string,
    ) {
        try {
            const isGitConnected =
                await this.codeManagementService.verifyConnection({
                    organizationAndTeamData,
                });

            if (!isGitConnected?.isSetupComplete) {
                return [];
            }

            const openedPRs = await this.codeManagementService.getPullRequests({
                organizationAndTeamData,
                filters: {
                    state: PullRequestState.OPENED,
                },
            });

            return {
                sectionId: this.id(),
                sectionName: this.name(),
                sectionData: openedPRs,
                possibleToMutate: false,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error processing open pull requests',
                context: PullRequestsOpenedSection.name,
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
