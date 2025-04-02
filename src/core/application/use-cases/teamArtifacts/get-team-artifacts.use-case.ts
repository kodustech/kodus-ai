import {
    ITeamArtifactsService,
    TEAM_ARTIFACTS_SERVICE_TOKEN,
} from '@/core/domain/teamArtifacts/contracts/teamArtifacts.service.contracts';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import * as moment from 'moment-timezone';

@Injectable()
export class GetTeamArtifactsUseCase {
    constructor(
        @Inject(TEAM_ARTIFACTS_SERVICE_TOKEN)
        private teamArtifactsService: ITeamArtifactsService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid };
        },

        private logger: PinoLoggerService,
    ) {}

    async execute(teamId: string) {
        try {
            const userId = this.request.user?.uuid;

            const organizationTeamAndData = {
                organizationId: this.request.user?.organization.uuid,
                teamId,
            };

            const artifacts =
                await this.teamArtifactsService.getMostRecentArtifactVisible(
                    organizationTeamAndData,
                    null,
                    userId,
                );

            if (!artifacts || artifacts?.length <= 0) {
                return [];
            }

            return artifacts
                .map((artifact) => {
                    return {
                        uuid: artifact.uuid,
                        title: artifact.title,
                        name: artifact.name,
                        analysisInitialDate: moment(
                            artifact.analysisInitialDate,
                        ).format('DD/MM/YYYY'),
                        analysisFinalDate: moment(
                            artifact.analysisFinalDate,
                        ).format('DD/MM/YYYY'),
                        category: artifact.category,
                        description: artifact.description,
                        relatedItems: artifact.relatedItems,
                        criticality: artifact.criticality,
                        resultType: artifact.resultType,
                        impactArea: artifact.impactArea,
                        howIsIdentified: artifact.howIsIdentified,
                        whyIsImportant: artifact.whyIsImportant,
                        teamId: artifact.teamId,
                        organizationId: artifact.organizationId,
                        frequenceType: artifact.frequenceType,
                        teamMethodology: artifact.teamMethodology,
                        additionalData: artifact.additionalData,
                        additionalInfoFormated: artifact.additionalInfoFormated,
                        impactLevel: artifact.impactLevel,
                    };
                })
                .sort((a, b) => b.impactLevel - a.impactLevel);
        } catch (error) {
            this.logger.error({
                message: 'Error retrieving visible team artifacts',
                context: GetTeamArtifactsUseCase.name,
                serviceName: 'GetMetricsByTeamIdAndPeriod',
                error: error,
                metadata: {
                    teamId: teamId,
                },
            });
        }
    }
}
