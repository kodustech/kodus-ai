import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';

@Injectable()
export class WithoutWaitingColumnsArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        // If there is no waiting column, notify
        if (!payload.waitingColumns || payload.waitingColumns.length === 0) {
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
            });
        }
    }
}
