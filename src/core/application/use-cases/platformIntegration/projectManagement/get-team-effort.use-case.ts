import {
    IMetricsService,
    METRICS_SERVICE_TOKEN,
} from '@/core/domain/metrics/contracts/metrics.service.contract';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';

export class GetEffortTeamUseCase implements IUseCase {
    constructor(
        @Inject(METRICS_SERVICE_TOKEN)
        private readonly metricsService: IMetricsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(teamId: string | null) {
        try {
            const organizationId = this.request.user.organization.uuid;
            let result = [];

            if (!!teamId) {
                result =
                    await this.metricsService.getLeadTimeInWipItemTypeByTeamIdAndPeriod(
                        { organizationAndTeamData: { organizationId, teamId } },
                    );
            } else {
                result =
                    await this.metricsService.getLeadTimeInWipItemTypeByOrganizationIdAndPeriod(
                        { organizationId },
                    );
            }

            return result;
        } catch (error) {
            this.logger.error({
                message: 'Error calculating team effort investment.',
                context: GetEffortTeamUseCase.name,
                serviceName: 'GetEffortTeamUseCase',
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                    teamId: teamId,
                },
            });
        }
    }
}
