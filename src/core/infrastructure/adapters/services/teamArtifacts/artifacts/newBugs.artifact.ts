import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';

@Injectable()
export class NewBugsArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        if (
            !payload?.newBugsInTheLast24Hours ||
            payload?.newBugsInTheLast24Hours?.length <= 0
        ) {
            return;
        }

        const artifactResult = payload.artifact.results.find(
            (artifactResult) => artifactResult.resultType === 'Negative',
        );

        return formatResult({
            artifact: payload.artifact,
            frequenceType: payload.frequenceType,
            artifactResult: artifactResult,
            period: payload.period,
            organizationId: payload.organization.uuid,
            teamId: payload.team.uuid,
            additionalData: payload.newBugsInTheLast24Hours,
            params: [payload.newBugsInTheLast24Hours.length],
        });
    }
}
