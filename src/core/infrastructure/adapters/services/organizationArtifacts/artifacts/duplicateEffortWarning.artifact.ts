import { IOrganizationArtifact } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifact.interface';
import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { Item } from '@/core/domain/platformIntegrations/types/projectManagement/workItem.type';
import { Injectable } from '@nestjs/common';
import { checkArtifactActiveForTeam } from '@/shared/utils/helpers';
import {
    organizationFormatResult,
    organizationTeamFormatResult,
} from '../organizationFormatArtifact';
import { tryParseJSONObject } from '@/shared/utils/transforms/json';

type CustomFunctionType = (
    duplicateWorkItems: {
        workItems: Item[];
        teamId: string;
        teamName: string;
    }[],
    organizationId: string,
) => Promise<any>;

@Injectable()
export class DuplicateEffortWarningArtifact {
    constructor() {}

    async execute(
        organizationArtifact: IOrganizationArtifact,
        payload: IOrganizationArtifacExecutiontPayload[],
        customFunction: CustomFunctionType,
    ) {
        let workItemsMerged: {
            workItems: Item[];
            teamId: string;
            teamName: string;
        }[] = [];

        let period = null;
        let organizationId: string;
        let teamsArtifact;

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

            organizationId = data.organizationAndTeamData.organizationId;
            period = data.period;

            const workItemsWIP = data?.workItems?.filter((workItem) =>
                data.wipColumns
                    .map((wipColumn) => wipColumn.id)
                    .includes(workItem.status.id),
            );

            workItemsMerged = [
                ...workItemsMerged,
                {
                    teamId: data.organizationAndTeamData.teamId,
                    teamName: data.teamName,
                    workItems: workItemsWIP,
                },
            ];
        });

        if (workItemsMerged.length > 0 && organizationId) {
            const result = await customFunction(
                workItemsMerged,
                organizationId,
            );

            teamsArtifact = this.generateTeamArtifacts(
                workItemsMerged,
                organizationArtifact,
                result,
            );

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
        }
    }

    private generateTeamArtifacts(
        workItemsMerged: any,
        organizationArtifact: IOrganizationArtifact,
        result: any,
    ): { teamsArtifact: any[] } {
        try {
            if (!result && result?.content) {
                return null;
            }

            let teamsArtifact: any = [];
            let additionalInfo: any = [];

            const resultContent = result?.content
                ? tryParseJSONObject(result.content)
                : {};

            const { duplicatedTasks = [] } = resultContent;

            const artifactResult = organizationArtifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );

            // Filters duplicatedTasks to remove those with duplicate team names
            const filteredDuplicatedTasks = duplicatedTasks?.filter(
                (workItem) => {
                    const uniqueTeamNames = new Set(workItem.teamNames);
                    return uniqueTeamNames.size === workItem.teamNames.length;
                },
            );

            // Groups the duplicated tasks by team
            const tasksByTeam = filteredDuplicatedTasks?.reduce(
                (acc, workItem) => {
                    workItem.teamNames.forEach((teamName) => {
                        if (!acc[teamName]) {
                            acc[teamName] = [];
                        }
                        acc[teamName].push({
                            ids: workItem.ids,
                            keys: workItem.keys,
                            reason: workItem.reason,
                            teamNames: workItem.teamNames,
                        });
                    });
                    return acc;
                },
                {},
            );

            // Creates unique records for each team
            Object.keys(tasksByTeam).forEach((teamName) => {
                const teamDetails = workItemsMerged.find(
                    (workItem) => workItem.teamName === teamName,
                );

                const otherTeams = tasksByTeam[teamName]
                    .map((task) => task.teamNames)
                    .flat()
                    .filter((t) => t !== teamName)
                    .filter(
                        (value, index, self) => self.indexOf(value) === index,
                    )
                    .join(', ');

                const additionalData = tasksByTeam[teamName].map((task) => ({
                    ids: task.ids,
                    keys: task.keys,
                    reason: task.reason,
                    teamNames: task.teamNames,
                }));

                additionalInfo[0] = this.processDuplicateItems(additionalData);

                const teamArtifact = organizationTeamFormatResult(
                    teamName,
                    organizationArtifact.title,
                    additionalInfo,
                    artifactResult,
                    [teamName, otherTeams],
                    {
                        teamId: teamDetails?.teamId,
                        criticality: 100,
                        additionalData: additionalData,
                    },
                );

                teamsArtifact = [...teamsArtifact, teamArtifact];
            });

            return teamsArtifact;
        } catch (error) {
            console.log(error);
        }
    }

    private processDuplicateItems(duplicateItems) {
        return duplicateItems
            .map((item) => {
                const { keys, teamNames, reason } = item;
                return `* ${keys[0]} (${teamNames[0]}) X ${keys[1]} (${teamNames[1]}): ${reason}`;
            })
            .join('\n ');
    }
}
