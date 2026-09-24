import { Inject, Injectable, BadRequestException } from '@nestjs/common';

import { IntegrationConfigKey } from '@libs/core/domain/enums/Integration-config-key.enum';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { createLogger } from '@libs/core/log/logger';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@libs/integrations/domain/integrationConfigs/contracts/integration-config.service.contracts';

export interface WebhookCreationFailure {
    reason: string;
    at: string;
}

@Injectable()
export class GetWebhookCreationFailuresUseCase implements IUseCase {
    private readonly logger = createLogger(
        GetWebhookCreationFailuresUseCase.name,
    );

    constructor(
        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,
    ) {}

    /**
     * Repositories whose webhook creation failed during the last repository
     * selection save, keyed by repository id. Until this existed, the failure
     * only reached the server log: the selection looked saved and the project
     * stayed without a webhook, so no review ever ran (#1983).
     */
    public async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
    }): Promise<{ failures: Record<string, WebhookCreationFailure> }> {
        try {
            const { organizationAndTeamData } = params ?? {};

            if (
                !organizationAndTeamData?.organizationId ||
                !organizationAndTeamData?.teamId
            ) {
                throw new BadRequestException(
                    'organizationId e teamId são obrigatórios.',
                );
            }

            const failures =
                await this.integrationConfigService.findIntegrationConfigFormatted<
                    Record<string, WebhookCreationFailure>
                >(
                    IntegrationConfigKey.WEBHOOK_CREATION_FAILURES,
                    organizationAndTeamData,
                );

            return { failures: failures ?? {} };
        } catch (error) {
            this.logger.error({
                message: 'Error while reading webhook creation failures',
                context: GetWebhookCreationFailuresUseCase.name,
                error: error,
                metadata: {
                    organizationId:
                        params?.organizationAndTeamData?.organizationId,
                    teamId: params?.organizationAndTeamData?.teamId,
                },
            });

            return { failures: {} };
        }
    }
}
