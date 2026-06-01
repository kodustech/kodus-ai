import { createLogger } from '@kodus/flow';
import { CentralizedConfigSyncUseCase } from '@libs/centralized-config/application/use-cases/centralized-config-sync.use-case';
import { CentralizedConfigPrService } from '@libs/centralized-config/infrastructure/adapters/services/centralized-config-pr.service';
import {
    CENTRALIZED_CONFIG_SERVICE_TOKEN,
    ICentralizedConfigService,
} from '@libs/centralized-config/domain/contracts/CentralizedConfigService.contract';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class CentralizedConfigSyncListener {
    private readonly logger = createLogger(CentralizedConfigSyncListener.name);

    constructor(
        private readonly centralizedConfigSyncUseCase: CentralizedConfigSyncUseCase,
        private readonly centralizedConfigPrService: CentralizedConfigPrService,
        @Inject(CENTRALIZED_CONFIG_SERVICE_TOKEN)
        private readonly centralizedConfigService: ICentralizedConfigService,
    ) {}

    @OnEvent('pull-request.closed')
    async handlePullRequestClosedEvent(event: PullRequestClosedEvent) {
        if (!event.repository || !event.repository.id) {
            this.logger.warn({
                message:
                    'Received pull-request.closed event without repository information, skipping centralized config sync',
                context: CentralizedConfigSyncListener.name,
                metadata: {
                    pullRequestNumber: event.pullRequestNumber,
                },
            });
            return;
        }

        const validation =
            await this.centralizedConfigService.validateCentralizedConfig({
                organizationAndTeamData: event.organizationAndTeamData,
                repository: event.repository,
            });

        if (!validation.success) {
            this.logger.log({
                message:
                    'Centralized config not enabled or validation failed, skipping sync',
                context: CentralizedConfigSyncListener.name,
                metadata: {
                    organizationAndTeamData: event.organizationAndTeamData,
                    message: validation.message,
                },
            });
            return;
        }

        this.logger.log({
            message:
                'Handling pull-request.closed event for centralized config sync',
            context: CentralizedConfigSyncListener.name,
            metadata: {
                repositoryId: event.repository?.id,
                repositoryName: event.repository?.name,
                pullRequestNumber: event.pullRequestNumber,
            },
        });

        const closeHandlingResult =
            await this.centralizedConfigPrService.handleTrackedPullRequestClose(
                {
                    organizationAndTeamData: event.organizationAndTeamData,
                    repository: event.repository,
                    pullRequestNumber: event.pullRequestNumber,
                    merged: event.merged,
                },
            );

        if (!closeHandlingResult.shouldSync) {
            this.logger.log({
                message:
                    'Centralized pull request closed without merge, skipping centralized sync',
                context: CentralizedConfigSyncListener.name,
                metadata: {
                    repositoryId: event.repository?.id,
                    pullRequestNumber: event.pullRequestNumber,
                },
            });

            return;
        }

        await this.centralizedConfigSyncUseCase.execute({
            organizationAndTeamData: event.organizationAndTeamData,
            repository: event.repository,
        });
    }
}
