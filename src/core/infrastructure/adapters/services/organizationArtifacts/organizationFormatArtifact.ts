import { IOrganizationArtifacts } from '@/core/domain/organizationArtifacts/interfaces/organizationArtifacts.interface';
import { OrganizationTeamArtifact } from '@/core/domain/organizationArtifacts/types/organizationTeamArtifact.type';

export const organizationTeamFormatResult = (
    teamName: string,
    title: string,
    additionalInfo: any,
    artifactResult: any,
    params: any,
    payload: Partial<OrganizationTeamArtifact>,
): Partial<OrganizationTeamArtifact> => {
    return {
        teamId: payload.teamId,
        teamName: teamName,
        title: title,
        description: replaceVars(artifactResult.description, params),
        criticality: payload.criticality,
        resultType: artifactResult.resultType,
        howIsIdentified: artifactResult.howIsIdentified,
        additionalData: payload.additionalData,
        additionalInfoFormated: replaceVars(artifactResult.additionalInfoFormated, additionalInfo),
    };
};

export const organizationFormatResult = (payload: {
    artifact: any;
    frequenceType: string;
    period: { startDate: Date; endDate: Date };
    organizationId?: string;
    teamsArtifact?: OrganizationTeamArtifact[];
    additionalData?;
    params?: any;
    description?: string;
    resultType?: string;
}): Partial<IOrganizationArtifacts> => {
    return {
        name: payload.artifact.name,
        analysisInitialDate: payload.period.startDate,
        analysisFinalDate: payload.period.endDate,
        relatedItems: payload.artifact.relatedItems,
        category: payload.artifact.category,
        impactArea: payload.artifact.impactArea,
        whyIsImportant: payload.artifact.whyIsImportant,
        teamsArtifact: payload.teamsArtifact,
        organizationId: payload.organizationId,
        frequenceType: payload.frequenceType,
        description: payload.artifact.description,
        resultType: payload.artifact.resultType,
    };
};

const replaceVars = (description: string, params: any[]): string => {
    if (!params) {
        return description;
    }

    let result = description;

    for (const [index, param] of params.entries()) {
        result = result.replace(
            new RegExp(`\\{${index}\\}`, 'g'),
            param.toString(),
        );
    }

    return result;
};
