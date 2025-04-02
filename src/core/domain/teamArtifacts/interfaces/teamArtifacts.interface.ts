import { MetricsCategory } from "@/shared/domain/enums/metric-category.enum";

export interface ITeamArtifacts {
    uuid: string;
    title: string;
    name: string;
    analysisInitialDate: Date;
    analysisFinalDate: Date;
    teamId: string;
    organizationId: string;
    category: string;
    description: string;
    relatedItems: string;
    criticality: string;
    resultType: string;
    impactArea: string;
    howIsIdentified: string;
    whyIsImportant: string;
    frequenceType: string;
    teamMethodology: string;
    additionalData: any;
    additionalInfoFormated: string;
    impactLevel: number;
    impactDataRelationship?: IImpactDataRelationship;
    relatedData?: IRelatedData;
}

export interface ITeamArtifactToEnrichData {
    uuid: string;
    title: string;
    name: string;
    formattedAnalysisInitialDate: string;
    formattedAnalysisFinalDate: string;
    analysisInitialDate: Date;
    analysisFinalDate: Date;
    description: string;
    resultType: string;
    impactLevel: number;
    howIsIdentified: string;
    whyIsImportant: string;
    frequencyType: string;
    relatedData?: IRelatedData;
}

export interface IImpactDataRelationship {
    impactedBy: IImpactedBy;
    impactsOn: IImpactsOn;
}

interface IImpactedBy {
    name: string;
    category: string;
    howItRelates: string;
}

interface IImpactsOn {
    name: string;
    category: string;
    howItRelates: string;
}

export interface IRelatedData {
    metrics: IRelatedMetrics;
    artifacts: IRelatedArtifacts;
    summaryOfRelatedItems: string;
}

interface IRelatedMetrics {
    metrics: {
        reasonOfRelationship: string;
        name: string;
        category: MetricsCategory;
        dataHistory: IMetricDataHistory
    };
};

interface IRelatedArtifacts {
    uuid: string;
    name: string;
    reasonOfRelationship: string;
    title: string;
    analysisInitialDate: string;
    analysisFinalDate: string;
    description: string;
    relatedItems: string;
    resultType: string;
    impactArea: string;
    impactLevel: number;
    howIsIdentified: string;
    whyIsImportant: string;
    frequencyType: string;
};

interface IMetricDataHistory  {
    analysisInitialDate: string;
    analysisFinalDate: string;
    result: {
        value: any;
        measurementType: string;
    };
    resultRelatedPreviousWeek: {
        variation: string;
        type: string;
    };
};
