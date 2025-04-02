import { IArtifact } from '@/core/domain/teamArtifacts/interfaces/artifact.interface';
import { ITeamArtifacts } from '@/core/domain/teamArtifacts/interfaces/teamArtifacts.interface';

export const formatResult = (payload: {
    artifact: IArtifact;
    frequenceType: string;
    artifactResult: any;
    period: { startDate: Date; endDate: Date };
    organizationId?: string;
    teamId?: string;
    additionalData?;
    additionalInfoFormated?;
    params?: any;
}): Partial<ITeamArtifacts> => {
    return {
        name: payload.artifact.name,
        description: replaceVars(
            payload.artifactResult.description,
            payload.params,
        ),
        title: payload.artifactResult.title,
        analysisInitialDate: payload.period.startDate,
        analysisFinalDate: payload.period.endDate,
        resultType: payload.artifactResult.resultType,
        relatedItems: payload.artifact.relatedItems,
        category: payload.artifact.category,
        impactArea: payload.artifact.impactArea,
        howIsIdentified: payload.artifactResult.howIsIdentified,
        whyIsImportant: payload.artifact.whyIsImportant,
        teamId: payload.teamId,
        organizationId: payload.organizationId,
        criticality: payload.artifact.criticality,
        frequenceType: payload.frequenceType,
        additionalData: payload.additionalData,
        impactLevel: payload.artifact.impactLevel,
        impactDataRelationship: payload.artifact?.impactDataRelationship,
        additionalInfoFormated: payload.additionalInfoFormated,
        relatedData: payload.artifact?.relatedData,
    };
};

const replaceVars = (description: string, params: any[]): string => {
    if (!params) return description;

    let result = description;
    for (const [index, param] of params.entries()) {
        result = result.replace(
            new RegExp(`\\{${index}\\}`, 'g'),
            param.toString(),
        );
    }

    return result;
};
