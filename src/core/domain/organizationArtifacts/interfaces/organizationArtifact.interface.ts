export interface IOrganizationArtifact {
    name: string;
    title: string;
    description?: string;
    category: string;
    relatedItems: string;
    impactLevel: string;
    impactArea: string;
    whyIsImportant: string;
    status: Boolean;
    teamMethodology: string[];
    results: {
        resultType: string;
        description: string;
        howIsIdentified: string;
        additionalInfoFormated: string;
    }[];
    frequenceTypes: string[];
}
