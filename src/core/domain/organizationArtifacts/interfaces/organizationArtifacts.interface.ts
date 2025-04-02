import { OrganizationTeamArtifact } from '../types/organizationTeamArtifact.type';

export interface IOrganizationArtifacts {
    uuid: string;
    name: string;
    description: string;
    analysisInitialDate: Date;
    analysisFinalDate: Date;
    relatedItems: string;
    resultType: string;
    category: string;
    impactArea: string;
    howIsIdentified: string;
    whyIsImportant: string;
    teamsArtifact: OrganizationTeamArtifact[];
    organizationId: string;
    frequenceType: string;
}
