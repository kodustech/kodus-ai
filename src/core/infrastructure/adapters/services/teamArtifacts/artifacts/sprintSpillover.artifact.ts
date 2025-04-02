import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';

@Injectable()
export class SprintSpilloverArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        const spilloverItems = [];

        for (const workItem of payload?.nextSprintWorkItems) {
            if (
                !workItem ||
                !workItem?.changelog ||
                workItem?.changelog?.length === 0
            ) {
                continue;
            }

            for (const changelog of workItem.changelog) {
                changelog?.movements?.forEach((movement) => {
                    if (
                        movement.field === 'Sprint' &&
                        movement.fromColumnName.includes(
                            payload.sprints.currentSprint.name,
                        )
                    ) {
                        spilloverItems.push(workItem);
                    }
                });
            }
        }

        if (spilloverItems.length <= 0) {
            return;
        }

        const artifactResult = payload.artifact.results.find(
            (artifactResult) => artifactResult.resultType === 'Negative',
        );

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [spilloverItems.length],
            additionalData: {
                spilloverItems: spilloverItems,
            },
        });
    }
}
