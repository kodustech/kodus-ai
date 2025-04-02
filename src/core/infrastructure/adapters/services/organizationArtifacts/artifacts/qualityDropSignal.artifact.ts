import { METRICS_TYPE } from '@/core/domain/metrics/enums/metrics.enum';
import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { Injectable } from '@nestjs/common';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '../organizationFormatArtifact';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { checkArtifactActiveForTeam } from '@/shared/utils/helpers';
import { AnyArray } from 'mongoose';

@Injectable()
export class QualityDropSignalArtifact {
    constructor() {}

    execute(
        organizationArtifact: IOrganizationArtifact,
        payload: IOrganizationArtifacExecutiontPayload[],
    ) {
        let period = null;
        let organizationId: string;
        let teamsArtifact: any = [];
        let organizationTeamData;

        payload.forEach((data: IOrganizationArtifacExecutiontPayload) => {
            if (
                !checkArtifactActiveForTeam(
                    data.organizationTeamArtifactsFromParameters,
                    organizationArtifact,
                ) ||
                !organizationArtifact.teamMethodology.includes(
                    data.teamMethodology,
                )
            ) {
                return null;
            }

            period = data.period;
            organizationId = data.organizationAndTeamData.organizationId;

            let bugRatio = data?.metrics?.find(
                (metric) => metric.type === METRICS_TYPE.BUG_RATIO,
            )?.value?.value;

            const result = this.generateTeamArtifact(
                data.teamName,
                bugRatio,
                organizationArtifact,
                data.organizationAndTeamData,
                data?.bugsInWip,
            );

            organizationTeamData = data.organizationAndTeamData;

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
        bugRatio: any,
        organizationArtifact: IOrganizationArtifact,
        organizationAndTeamData: OrganizationAndTeamData,
        bugsInWip: any,
    ) {
        try {
            const RECOMENDATION_LIMIT = 0.4;
            let additionalInfo: any = [];

            if (bugRatio <= RECOMENDATION_LIMIT) {
                return;
            }

            let bugRatioResultFormated = Math.round(bugRatio * 100);

            const artifactResult = organizationArtifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            additionalInfo[0] = this.processBugs(bugsInWip);

            return organizationTeamFormatResult(
                teamName,
                organizationArtifact.title,
                additionalInfo,
                artifactResult,
                [bugRatioResultFormated],
                {
                    teamId: organizationAndTeamData.teamId,
                    criticality: bugRatioResultFormated,
                },
            );
        } catch (error) {
            console.log(error);
        }
    }

    private processBugs(bugs) {
        return bugs
            .map((bug) => {
                return `* ${bug.key} - ${bug.name}`;
            })
            .join('\n ');
    }
}
