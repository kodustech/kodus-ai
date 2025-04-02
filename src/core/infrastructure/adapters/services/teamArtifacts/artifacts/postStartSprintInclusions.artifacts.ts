import { Injectable } from '@nestjs/common';
import { formatResult } from '../formatArtifact';
import { IArtifacExecutiontPayload } from '@/core/domain/teamArtifacts/interfaces/artifactExecutionPayload.interface';
import * as moment from 'moment';
import { MODULE_WORKITEMS_TYPES } from '@/core/domain/integrationConfigs/enums/moduleWorkItemTypes.enum';

@Injectable()
export class PostStartSprintInclusionsArtifact {
    constructor() {}

    execute(payload: IArtifacExecutiontPayload) {
        if (
            !payload.sprints?.currentSprint ||
            !payload.workItems ||
            payload.workItems?.length <= 0 ||
            !payload.bugTypeIdentifiers
        ) {
            return;
        }

        const itemsCreatedAfterSprintStart = [];
        const sprintCreateAt = moment(payload.sprints.currentSprint.startDate);

        const validWorkItemTypesForDefault = payload.workItemTypes
            .find((module) => module.name === MODULE_WORKITEMS_TYPES.DEFAULT)
            .workItemTypes.map((type) => type.id);

        const bugIds = new Set(payload.bugTypeIdentifiers.map((bug) => bug.id));

        const filteredWorkItems = payload.workItems.filter((item) => {
            return (
                validWorkItemTypesForDefault.includes(item.workItemType.id) &&
                !bugIds.has(item.workItemType.id)
            );
        });

        for (const workItem of filteredWorkItems) {
            const workItemCreateAt = moment(workItem.created);
            if (workItemCreateAt.isAfter(sprintCreateAt)) {
                itemsCreatedAfterSprintStart.push(workItem);
            }
        }

        if (itemsCreatedAfterSprintStart.length <= 0) {
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
            params: [itemsCreatedAfterSprintStart.length],
            additionalData: {
                itemsCreatedAfterSprintStart: itemsCreatedAfterSprintStart,
            },
        });
    }
}
