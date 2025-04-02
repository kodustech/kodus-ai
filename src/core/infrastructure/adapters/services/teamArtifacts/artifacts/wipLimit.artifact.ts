import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';

@Injectable()
export class WipLimitArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        if (
            !payload?.workItems ||
            !payload?.teamMembers?.members ||
            payload?.teamMembers?.members?.length === 0 ||
            payload?.workItems?.length === 0
        ) {
            return;
        }

        const RECOMENDATION_LIMIT = 2 * payload.teamMembers.members.length; // If the number of tasks in WIP is greater than twice the number of people in the team, notify

        let artifactResult;

        if (payload.workItems.length > RECOMENDATION_LIMIT) {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Negative',
            );
        } else {
            artifactResult = payload.artifact.results.find(
                (artifactResult) => artifactResult.resultType === 'Positive',
            );
        }

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            params: [payload.workItems.length, RECOMENDATION_LIMIT],
        });
    }
}
