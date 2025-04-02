import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { FeedbackType } from '../enums/feedbackType.enum';
import { FineTuningDecision } from '../enums/fineTuningDecision.enum';
import { ISuggestionEmbedded } from '../suggestionEmbedded/interfaces/suggestionEmbedded.interface';

export interface IKodyFineTuning {
    uuid: string;
    suggestionId: string;
    suggestionContent: string;
    improvedCode: string;
    severity: SeverityLevel;
    label: string;
    feedbackType: FeedbackType;
    pullRequest: {
        id: string;
        number: number;
        repository: {
            id: string;
            fullName: string;
        };
    };
    organizationId: string;
}

export interface IEmbeddingResult {
    suggestionId: string;
    embedding: number[];
    metadata: {
        model: string;
    };
}

export interface IClusterAnalysis {
    total: number;
    positiveReactions: number;
    negativeReactions: number;
    implemented: number;
    neutral: number;
}

export interface IClusterizedSuggestion {
    cluster: number;
    fineTuningDecision?: FineTuningDecision;
    originalSuggestion: ISuggestionEmbedded;
    language: string;
}

export interface IClusterDistribution {
    [clusterId: number]: IClusterAnalysis;
}
