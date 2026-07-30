import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    DRY_RUN_SERVICE_TOKEN,
    IDryRunService,
} from '@libs/dryRun/domain/contracts/dryRun.service.contract';

@Injectable()
export class GetDryRunUseCase {
    private readonly logger = createLogger(GetDryRunUseCase.name);
    constructor(
        @Inject(DRY_RUN_SERVICE_TOKEN)
        private readonly dryRunService: IDryRunService,
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        correlationId: string;
    }) {
        const { organizationAndTeamData, correlationId } = params;

        try {
            const dryRun = await this.dryRunService.findDryRunById({
                organizationAndTeamData,
                id: correlationId,
            });

            if (!dryRun) {
                this.logger.warn({
                    message: 'Dry run not found',
                    context: GetDryRunUseCase.name,
                    serviceName: GetDryRunUseCase.name,
                    metadata: {
                        organizationAndTeamData,
                        correlationId,
                    },
                });

                return null;
            }

            return dryRun;
        } catch (error) {
            this.logger.error({
                message: 'Error getting dry run',
                context: GetDryRunUseCase.name,
                serviceName: GetDryRunUseCase.name,
                error,
                metadata: {
                    organizationAndTeamData,
                    correlationId,
                },
            });

            throw error;
        }
    }
}
