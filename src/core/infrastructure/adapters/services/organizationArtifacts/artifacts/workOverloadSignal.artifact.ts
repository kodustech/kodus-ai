import { IOrganizationArtifacExecutiontPayload } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifactExecutionPayload.interface';
import { Injectable } from '@nestjs/common';

@Injectable()
export class WorkOverloadSignalArtifact {
    constructor() {}

    execute(payload: IOrganizationArtifacExecutiontPayload) {}
}
