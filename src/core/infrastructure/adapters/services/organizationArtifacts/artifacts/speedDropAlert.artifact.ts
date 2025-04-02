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
export class SpeedDropAlertArtifact {
    constructor() {}

    execute(
        organizationArtifact: IOrganizationArtifact,
        payload: IOrganizationArtifacExecutiontPayload[],
    ) {
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
                )
            ) {
                return null;
            }

            period = data.period;
            organizationId = data.organizationAndTeamData.organizationId;

            const lateWorkItems = [
                ...(data?.workItemsWithDeliveryStatus || []).filter(
                    (workItem) => workItem.isLate,
                ),
            ];

            if (lateWorkItems?.length === 0) {
                return;
            }

            const result = this.generateTeamArtifact(
                data.teamName,
                lateWorkItems,
                data?.workItemsWithDeliveryStatus,
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
        lateWorkItems: any,
        wipWorkItems: any,
        organizationArtifact: IOrganizationArtifact,
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        try {
            const RECOMENDATION_LIMIT = 0.3;
            let additionalInfo: any = [];

            const lateWorkItemsFiltered = lateWorkItems.filter(
                (workItem) => workItem.isLate,
            );

            const latedWorkItemsResult =
                lateWorkItemsFiltered?.length / wipWorkItems.length;

            if (latedWorkItemsResult <= RECOMENDATION_LIMIT) {
                return;
            }

            let latedWorkItemsResultFormated = Math.round(
                latedWorkItemsResult * 100,
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
                [latedWorkItemsResultFormated],
                {
                    teamId: organizationAndTeamData.teamId,
                    criticality: latedWorkItemsResultFormated,
                    additionalData: [lateWorkItems],
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
