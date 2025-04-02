import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { Injectable } from '@nestjs/common';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '../organizationFormatArtifact';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { checkArtifactActiveForTeam } from '@/shared/utils/helpers';

@Injectable()
export class ThroughputVariabilityAlertArtifact {
    constructor() {}

    execute(
        organizationArtifact: IOrganizationArtifact,
        payload: IOrganizationArtifacExecutiontPayload[],
    ) {
        let period = null;
        let organizationId: string;
        let teamsArtifact: any = [];
        let throughputHistory;

        payload.forEach((data: IOrganizationArtifacExecutiontPayload) => {
            if (
                !checkArtifactActiveForTeam(
                    data.organizationTeamArtifactsFromParameters,
                    organizationArtifact,
                ) ||
                !organizationArtifact.teamMethodology.includes(
                    data.teamMethodology,
                ) ||
                data.throughputMetricsHistoric?.differences?.length <= 2
            ) {
                return null;
            }

            let throughputs: any[] = [];
            period = data.period;
            organizationId = data.organizationAndTeamData.organizationId;

            if (
                data?.throughputMetricsHistoric?.differences &&
                Array.isArray(data?.throughputMetricsHistoric?.differences)
            ) {
                throughputHistory = this.getSortedOriginalValues(
                    data.throughputMetricsHistoric,
                );
            }

            throughputs = throughputHistory.map((x) => x.value);

            if (throughputs?.length === 0) {
                return;
            }

            const result = this.generateTeamArtifact(
                data.teamName,
                throughputs,
                organizationArtifact,
                data.organizationAndTeamData,
                throughputHistory,
            );

            if (result) {
                teamsArtifact = [...teamsArtifact, result];
            }
            ``;
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

    private getSortedOriginalValues(data) {
        const allValues = data.differences.concat({
            date: data.date,
            original: data.original,
        });

        const sortedValues = allValues.sort(
            (a, b) => new Date(a.date).getTime() - new Date(b.date).getTime(),
        );

        return sortedValues.map((item) => ({
            value: item.original?.value ?? item.original?.total?.value,
            date: item.date,
        }));
    }

    private generateTeamArtifact(
        teamName: string,
        throughputs: any,
        organizationArtifact: IOrganizationArtifact,
        organizationAndTeamData: OrganizationAndTeamData,
        throughputHistory: any,
    ) {
        try {
            const RECOMENDATION_LIMIT = 30;
            let additionalInfo: any = [];

            const recentThroughput = throughputs[throughputs.length - 1];
            const previousThroughputs = throughputs.slice(
                0,
                throughputs.length - 1,
            );
            const totalPreviousThroughputs = previousThroughputs.reduce(
                (acc, curr) => acc + curr,
                0,
            );
            const averagePreviousThroughputs =
                totalPreviousThroughputs / previousThroughputs.length;

            const percentageVariation =
                ((recentThroughput - Math.ceil(averagePreviousThroughputs)) /
                    Math.ceil(averagePreviousThroughputs)) *
                100;

            if (Math.abs(percentageVariation) < RECOMENDATION_LIMIT) {
                return;
            }

            let throughputResultFormated = Math.round(percentageVariation);

            const artifactResult = organizationArtifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            additionalInfo[0] = this.processThroughputInfo(throughputHistory);

            return organizationTeamFormatResult(
                teamName,
                organizationArtifact.title,
                additionalInfo,
                artifactResult,
                [throughputResultFormated],
                {
                    teamId: organizationAndTeamData.teamId,
                    criticality: throughputResultFormated,
                },
            );
        } catch (error) {
            console.log(error);
        }
    }

    private processThroughputInfo(throughputHistory) {
        const formattedData = throughputHistory.map((item, index) => {
            const previousItem = throughputHistory[index - 1];
            let percentChangeFromPrevious = null;
            let changeText = '';

            if (index > 0) {
                percentChangeFromPrevious =
                    previousItem.value !== 0
                        ? ((item.value - previousItem.value) /
                              previousItem.value) *
                          100
                        : 100; // Considers a 100% increase if the previous value is 0

                let percentageFormatted =
                    percentChangeFromPrevious < 0
                        ? percentChangeFromPrevious * -1
                        : percentChangeFromPrevious;

                if (percentChangeFromPrevious > 0) {
                    changeText = `(Increase of ${percentageFormatted.toFixed(2)}% compared to the previous week)`;
                } else if (percentChangeFromPrevious < 0) {
                    changeText = `(Decrease of ${percentageFormatted.toFixed(2)}% compared to the previous week)`;
                }
            }

            return {
                date: item?.date?.split('-').reverse().join('/'), // Format the date to dd/mm/yyyy
                value: item?.value,
                changeText: changeText,
            };
        });

        if (!formattedData) {
            return null;
        }

        // Remove the last item, which is used only for comparison
        formattedData.pop();

        const resultString = formattedData
            .map((data) => {
                return `* ${data.date} - ${data.value} ${data.changeText}`;
            })
            .join('\n ');

        return resultString;
    }
}
