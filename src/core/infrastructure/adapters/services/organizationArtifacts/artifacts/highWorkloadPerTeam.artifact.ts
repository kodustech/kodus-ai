import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { Injectable } from '@nestjs/common';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '../organizationFormatArtifact';
import { checkArtifactActiveForTeam } from '@/shared/utils/helpers';

@Injectable()
export class HighWorkloadPerTeamArtifact {
    constructor() {}

    execute(
        organizationArtifact: IOrganizationArtifact,
        payload: IOrganizationArtifacExecutiontPayload[],
    ) {
        let period = null;
        let organizationId: string;
        let teamsArtifact: any = [];
        let throughputAverage;

        payload.forEach((data: IOrganizationArtifacExecutiontPayload) => {
            if (
                !checkArtifactActiveForTeam(
                    data.organizationTeamArtifactsFromParameters,
                    organizationArtifact,
                ) ||
                !organizationArtifact.teamMethodology.includes(
                    data.teamMethodology,
                ) ||
                data.throughputMetricsHistoric.differences.length < 4
            ) {
                return null;
            }

            period = data.period;
            organizationId = data.organizationAndTeamData.organizationId;

            if (
                data?.throughputMetricsHistoric?.differences &&
                Array.isArray(data?.throughputMetricsHistoric?.differences)
            ) {
                throughputAverage = this.calculateAverage(
                    data.throughputMetricsHistoric,
                );
            }

            const result = this.generateTeamArtifact(
                data.teamName,
                throughputAverage,
                data.workItemsCreatedInCurrentWeek?.length,
                organizationArtifact,
                data.organizationAndTeamData,
            );

            if (result) {
                teamsArtifact = [...teamsArtifact, result];
            }
        });

        if (teamsArtifact.length === 0) {
            return null;
        }

        return organizationFormatResult({
            artifact: organizationArtifact,
            frequenceType: 'weekly',
            period: period,
            organizationId: organizationId,
            teamsArtifact: teamsArtifact,
        });
    }

    private calculateAverage(data) {
        const total = data.differences.length;
        const sum = data.differences.reduce(
            (acc, item) => acc + item.original.value,
            0,
        );
        return Math.floor(sum / total);
    }

    private generateTeamArtifact(
        teamName,
        throughputAverage,
        workItemstWeek,
        organizationArtifact,
        organizationAndTeamData,
    ) {
        try {
            const RECOMENDATION_LIMIT = 0.25;
            let additionalInfo: any = [];

            if (
                workItemstWeek >=
                throughputAverage * (1 + RECOMENDATION_LIMIT)
            ) {
                const excess =
                    ((workItemstWeek - throughputAverage) / throughputAverage) *
                    100;

                additionalInfo[0] = workItemstWeek;
                additionalInfo[1] = excess;
                additionalInfo[2] = throughputAverage;

                const artifactResult = organizationArtifact.results.find(
                    (artifactResult) =>
                        artifactResult.resultType === 'Negative',
                );

                const result = organizationTeamFormatResult(
                    teamName,
                    organizationArtifact.title,
                    additionalInfo,
                    artifactResult,
                    [teamName],
                    {
                        teamId: organizationAndTeamData.teamId,
                        criticality: Math.floor(Number(excess.toFixed(2))),
                    },
                );

                return result;
            }
        } catch (error) {
            console.error(
                'Error generating High Workload artifact for the team: ',
                error,
            );
        }
    }
}
