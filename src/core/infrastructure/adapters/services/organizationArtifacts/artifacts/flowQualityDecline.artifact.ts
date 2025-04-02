import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { Injectable } from '@nestjs/common';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '../organizationFormatArtifact';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { checkArtifactActiveForTeam } from '@/shared/utils/helpers';

type ArtifactCount = {
    date: string;
    positive: number;
    negative: number;
};

@Injectable()
export class FlowQualityDeclineArtifact {
    constructor() {}

    execute(
        organizationArtifact: IOrganizationArtifact,
        payload: IOrganizationArtifacExecutiontPayload[],
    ) {
        let period = null;
        let organizationId: string;
        let teamsArtifact: any = [];

        payload.forEach((data) => {
            if (
                !checkArtifactActiveForTeam(
                    data.organizationTeamArtifactsFromParameters,
                    organizationArtifact,
                ) ||
                !organizationArtifact.teamMethodology.includes(
                    data.teamMethodology,
                ) ||
                !data?.teamArtifacts
            ) {
                return null;
            }

            period = data.period;
            organizationId = data.organizationAndTeamData.organizationId;

            const allArtifacts = [
                ...data.teamArtifacts.mostRecentArtifacts.artifacts.map(
                    (artifact) => ({
                        ...artifact,
                        date: data.teamArtifacts.mostRecentArtifacts.date,
                    }),
                ),
                ...data.teamArtifacts.previousArtifacts.flatMap((week) =>
                    week.artifacts.map((artifact) => ({
                        ...artifact,
                        date: week.date,
                    })),
                ),
            ];

            const result = this.generateTeamArtifact(
                data.teamName,
                allArtifacts,
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

    private generateTeamArtifact(
        teamName: string,
        allArtifacts: any[],
        organizationArtifact: IOrganizationArtifact,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const RECOMMENDATION_LIMIT = 0.3;
        let additionalInfo: any = [];

        if (!allArtifacts.length) {
            return null;
        }

        const artifactCountsByDate = this.getArtifactCountsByDate(allArtifacts);

        if (artifactCountsByDate?.length < 3) {
            return;
        }

        const artifactsRemovedActualWeek = artifactCountsByDate.slice(1);

        const totalNegativeWithNoPositive = artifactsRemovedActualWeek.reduce(
            (sum, item) => {
                return (sum += item.negative);
            },
            0,
        );

        const averageNegatives =
            totalNegativeWithNoPositive / artifactsRemovedActualWeek.length;

        const alertThreshold = averageNegatives * (1 + RECOMMENDATION_LIMIT);
        const actualNegativeValue = artifactCountsByDate[0].negative;
        const historicNegativeArtifacts = this.filterArtifactsByDate(
            allArtifacts,
            artifactCountsByDate[0].date,
        );

        let resultPercentage;

        if (averageNegatives === 0) {
            if (actualNegativeValue > 0) {
                resultPercentage = 100;
            } else {
                resultPercentage = 0;
            }
        } else {
            resultPercentage =
                ((actualNegativeValue - averageNegatives) / averageNegatives) *
                100;
        }

        if (
            actualNegativeValue === 0 ||
            (actualNegativeValue > 0 && actualNegativeValue < alertThreshold)
        ) {
            return;
        }

        const artifactResult = this.findNegativeResult(organizationArtifact);

        let resultPercentageFormatted = Math.ceil(Math.abs(resultPercentage));

        additionalInfo[0] = this.processNegativeArtifacts(
            historicNegativeArtifacts,
        );

        return this.formatTeamArtifactResult(
            teamName,
            organizationArtifact.title,
            artifactResult,
            Math.round(resultPercentageFormatted),
            organizationAndTeamData,
            allArtifacts,
            additionalInfo,
        );
    }

    private getArtifactCountsByDate(allArtifacts: any[]): any[] {
        const countByDate = allArtifacts.reduce(
            (acc: Record<string, ArtifactCount>, artifact) => {
                const date = artifact.date.split('T')[0];
                if (!acc[date]) {
                    acc[date] = {
                        date,
                        positive: 0,
                        negative: 0,
                    } as ArtifactCount;
                }

                if (artifact.resultType.toLowerCase() === 'positive') {
                    acc[date].positive += 1;
                } else if (artifact.resultType.toLowerCase() === 'negative') {
                    acc[date].negative += 1;
                }

                return acc;
            },
            {},
        );

        return Object.values(countByDate).sort(
            (a: ArtifactCount, b: ArtifactCount) =>
                new Date(b.date).getTime() - new Date(a.date).getTime(),
        );
    }

    private filterArtifactsByDate(artifacts, targetDate) {
        return artifacts
            .filter(
                (artifact) =>
                    artifact.date === targetDate &&
                    artifact.resultType.toLowerCase() === 'negative',
            )
            .map((artifact) => ({
                name: artifact.name,
                category: artifact.category,
                description: artifact.description,
                resultType: artifact.resultType,
            }));
    }

    private processNegativeArtifacts(artifacts) {
        return artifacts
            .map((artifact) => {
                return `* ${artifact.name}: ${artifact.description} (${artifact.category})`;
            })
            .join('\n ');
    }

    private findNegativeResult(
        organizationArtifact: IOrganizationArtifact,
    ): any {
        return organizationArtifact.results.find(
            (result) => result.resultType === 'Negative',
        );
    }

    private formatTeamArtifactResult(
        teamName: string,
        title: string,
        result: any,
        threshold: number,
        teamData: OrganizationAndTeamData,
        additionalData: any[],
        additionalInfo,
    ): any {
        return organizationTeamFormatResult(
            teamName,
            title,
            additionalInfo,
            result,
            [threshold],
            {
                teamId: teamData.teamId,
                criticality: threshold,
                additionalData: [additionalData],
            },
        );
    }
}
