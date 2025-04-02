import { IImpactDataRelationship, IRelatedData } from "./teamArtifacts.interface";

export interface IArtifact {
    name: string;
    description: string;
    category: string;
    relatedItems: string;
    impactLevel: number;
    impactArea: string;
    impactDataRelationship?: IImpactDataRelationship;
    whyIsImportant: string;
    criticality: string;
    status: Boolean;
    results: {
        resultType: string;
        description: string;
        howIsIdentified: string;
    }[];
    frequenceTypes: string[];
    artifactConfigs?: any;
    additionalInfoFormated: string;
    relatedData?: IRelatedData;
}
