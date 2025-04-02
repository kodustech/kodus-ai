import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { Injectable } from '@nestjs/common';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '../organizationFormatArtifact';
import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { checkArtifactActiveForTeam } from '@/shared/utils/helpers';

@Injectable()
export class TeamDeliveryAtRiskArtifact {
    constructor() {}

    execute(
        organizationArtifact: IOrganizationArtifact,
        payload: IOrganizationArtifacExecutiontPayload[],
    ) {
        try {
            let period = null;
            let organizationId: string;
            let teamsArtifact: any = [];

            payload.forEach((data: IOrganizationArtifacExecutiontPayload) => {
                if (
                    !checkArtifactActiveForTeam(
                        data.organizationTeamArtifactsFromParameters,
                        organizationArtifact,
                    ) ||
                    !organizationArtifact.teamMethodology.includes(
                        data.teamMethodology,
                    ) ||
                    data?.workItemsWithDeliveryStatus?.length === 0
                ) {
                    return null;
                }

                period = data.period;
                organizationId = data.organizationAndTeamData.organizationId;

                const workItemsWithDeliveryStatus = [
                    ...data?.workItemsWithDeliveryStatus,
                ];

                const result = this.generateTeamArtifact(
                    data.teamName,
                    workItemsWithDeliveryStatus,
                    organizationArtifact,
                    data.organizationAndTeamData,
                );

                if (result) {
                    teamsArtifact = [...teamsArtifact, result];
                }

                const lateWorkItems = [
                    ...(data?.workItemsWithDeliveryStatus || []).filter(
                        (workItem) => workItem.isLate,
                    ),
                ];
            });

            if (teamsArtifact.length === 0) {
                return null;
            }

            return organizationFormatResult({
                artifact: organizationArtifact,
                frequenceType: 'daily',
                period: period,
                organizationId: organizationId,
                teamsArtifact: teamsArtifact,
            });
        } catch (error) {
            console.log(error);
        }
    }

    private generateTeamArtifact(
        teamName: string,
        workItemsWithDeliveryStatus: any,
        organizationArtifact: IOrganizationArtifact,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const RECOMENDATION_LIMIT = 0.4;
            let additionalInfo: any = [];

            if (!workItemsWithDeliveryStatus) {
                return;
            }

            const lateWorkItems = workItemsWithDeliveryStatus?.filter(
                (workItem) => !workItem.isLate,
            );

            const latedWorkItemsresult =
                lateWorkItems?.length / workItemsWithDeliveryStatus.length;

            if (latedWorkItemsresult <= RECOMENDATION_LIMIT) {
                return;
            }

            const latedWorkItemsFormated = Math.round(
                latedWorkItemsresult * 100,
            );

            const artifactResult = organizationArtifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            additionalInfo[0] = this.processLateWorkItems(lateWorkItems);

            return organizationTeamFormatResult(
                teamName,
                organizationArtifact.title,
                additionalInfo,
                artifactResult,
                [latedWorkItemsFormated],
                {
                    teamId: organizationAndTeamData.teamId,
                    criticality: latedWorkItemsFormated,
                    additionalData: [workItemsWithDeliveryStatus],
                },
            );
        } catch (error) {
            console.log(error);
        }
    }

    private processLateWorkItems(lateWorkItems) {
        return lateWorkItems
            .map((item) => {
                return `* ${item.key} - ${item.title}`;
            })
            .join('\n ');
    }
}
