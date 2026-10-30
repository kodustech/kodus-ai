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
        const { organizationAndTeamData } = params ?? {};

        // Validated BEFORE the try: caught inside it, this rejection was folded
        // into an empty result, so a caller that forgot the tenant ids read "no
        // failures" instead of being told its request was invalid (#2003
        // review).
        if (
            !organizationAndTeamData?.organizationId ||
            !organizationAndTeamData?.teamId
        ) {
            throw new BadRequestException(
                'organizationId and teamId are required.',
            );
        }

        try {

            const stored =
                await this.integrationConfigService.findIntegrationConfigFormatted<{
                    recordedAt?: string;
                    failures?: Record<string, WebhookCreationFailure>;
                }>(
                    IntegrationConfigKey.WEBHOOK_CREATION_FAILURES,
                    organizationAndTeamData,
                );

            return { failures: stored?.failures ?? {} };
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

            // Not swallowed: an empty payload reads as "no failures", which is
            // the healthy answer this endpoint exists to distinguish from. A
            // read failure stays a 500, and the BadRequestException above
            // stays a 400.
            throw error;
        }
    }
}
