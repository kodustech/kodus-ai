import { OrganizationAndTeamData } from './organizationAndTeamData';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { IKodyRule } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';

import { IClusterizedSuggestion } from '@/ee/kodyFineTuning/domain/interfaces/kodyFineTuning.interface';
import { FunctionAnalysis } from '@/ee/codeBase/ast/contracts/CodeGraph';
import { EnrichGraph, FunctionsAffectResult, FunctionSimilarity } from '@/ee/codeBase/ast/services/code-analyzer.service';

export interface IFinalAnalysisResult {
    validSuggestionsToAnalyze: Partial<CodeSuggestion>[];
    discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[];
    overallComment?: { filepath: string; summary: string };
    reviewMode?: ReviewModeResponse;
    codeReviewModelUsed?: {
        generateSuggestions?: string;
        safeguard?: string;
    };
}

export interface ISafeguardResponse {
    suggestions: CodeSuggestion[];
    codeReviewModelUsed?: {
        generateSuggestions?: string;
        safeguard?: string;
    };
}

export interface FileAST {
    path: string;
    duplicateFunctions: Array<{
        functionName: string;
        locations: string[];
    }>;
    missingImports: string[];
    unusedImports: Array<{
        functionName: string;
        filesWithUnusedImport: string[];
    }>;
}
export interface ChangedFilesWithAST {
    file: FileChange;
    astAnalysis: FileAST;
}

export type Repository = {
    platform: 'github' | 'gitlab' | 'bitbucket';
    id: string;
    name: string;
    fullName?: string;
    language: string;
    defaultBranch: string;
};

export type CodeGraphContext = {
    codeGraphFunctions: Map<string, FunctionAnalysis>;
    cloneDir: string;
};

export type CodeAnalysisAST = {
    processedChunk?: string;
    headCodeGraph: CodeGraphContext;
    baseCodeGraph: CodeGraphContext;
    headCodeGraphEnriched?: EnrichGraph;
};

export type AnalysisContext = {
    pullRequest?: any;
    repository?: Partial<Repository>;
    organizationAndTeamData: OrganizationAndTeamData;
    codeReviewConfig?: CodeReviewConfig;
    platformType: string;
    action?: string;
    baseDir?: string;
    codeAnalysisAST?: CodeAnalysisAST;
    impactASTAnalysis?: {
        functionsAffectResult: FunctionsAffectResult[];
        functionSimilarity: FunctionSimilarity[];
    };
    reviewModeResponse?: ReviewModeResponse;
    kodyFineTuningConfig?: KodyFineTuningConfig;
    fileChangeContext?: FileChangeContext;
    clusterizedSuggestions?: IClusterizedSuggestion[];
};

export type ASTAnalysisResult = {
    issues: any[];
    metrics: any;
    suggestions: any[];
};

export type CombinedAnalysisResult = {
    aiAnalysis?: AIAnalysisResult;
    astAnalysis?: ASTAnalysisResult;
    lintingAnalysis?: any;
    securityAnalysis?: any;
    codeSuggestions: CodeSuggestion[]; // Aggregation of all suggestions
    overallSummary: string; // Combined summary of the analyses
};

export type AIAnalysisResult = {
    codeSuggestions: Partial<CodeSuggestion>[];
    overallSummary: string;
    codeReviewModelUsed?: {
        generateSuggestions?: string;
        safeguard?: string;
    };
};

export type CodeSuggestion = {
    id?: string;
    relevantFile: string;
    language: string;
    suggestionContent: string;
    existingCode?: string;
    improvedCode: string;
    oneSentenceSummary?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    label: string;
    severity?: string;
    rankScore?: number;
    priorityStatus?: PriorityStatus;
    deliveryStatus?: DeliveryStatus;
    implementationStatus?: ImplementationStatus;
    brokenKodyRulesIds?: string[];
    clusteringInformation?: {
        type?: ClusteringType;
        relatedSuggestionsIds?: string[];
        parentSuggestionId?: string;
        problemDescription?: string;
        actionStatement?: string;
    };
    comment?: {
        id: number;
        pullRequestReviewId: number;
    };
    createdAt?: string;
    updatedAt?: string;
};

export type FileChange = {
    content: any;
    sha: string;
    filename: string;
    status:
    | 'added'
    | 'removed'
    | 'modified'
    | 'renamed'
    | 'copied'
    | 'changed'
    | 'unchanged';
    additions: number;
    deletions: number;
    changes: number;
    blob_url: string;
    raw_url: string;
    contents_url: string;
    patch?: string | undefined;
    previous_filename?: string | undefined;
    fileContent?: string;
    reviewMode?: ReviewModeResponse;
    codeReviewModelUsed?: {
        generateSuggestions?: string;
        safeguard?: string;
    };
};

export type FileChangeContext = {
    file: FileChange;
    patchWithLinesStr?: string;
};

export type Comment = {
    path: string;
    position?: number | undefined;
    body: any;
    line?: number | undefined;
    side?: string | undefined;
    start_line?: number | undefined;
    start_side?: string | undefined;
    suggestion?: CodeSuggestion;
};

export type CommentResult = {
    comment: Comment;
    deliveryStatus: string;
    codeReviewFeedbackData?: {
        commentId: number;
        pullRequestReviewId: number;
        suggestionId: string;
    };
};

export type ReviewComment = {
    id: number;
    pullRequestReviewId: string;
    body: string;
    createdAt: string;
    updatedAt: string;
};

export interface ReviewOptions {
    security: boolean;
    code_style: boolean;
    refactoring: boolean;
    error_handling: boolean;
    maintainability: boolean;
    potential_issues: boolean;
    documentation_and_comments: boolean;
    performance_and_optimization: boolean;
    kody_rules: boolean;
    breaking_changes: boolean;
}

export enum BehaviourForExistingDescription {
    REPLACE = 'replace',
    CONCATENATE = 'concatenate',
    COMPLEMENT = 'complement',
}

export enum LimitationType {
    FILE = 'file',
    PR = 'pr',
}

export enum GroupingModeSuggestions {
    MINIMAL = 'minimal',
    SMART = 'smart',
    FULL = 'full',
}

export enum ClusteringType {
    PARENT = 'parent',
    RELATED = 'related',
}

export interface SummaryConfig {
    generatePRSummary?: boolean;
    customInstructions?: string;
    behaviourForExistingDescription?: BehaviourForExistingDescription;
}

export interface SuggestionControlConfig {
    groupingMode?: GroupingModeSuggestions;
    limitationType?: LimitationType;
    maxSuggestions: number;
    severityLevelFilter?: SeverityLevel;
}

export type ImplementedSuggestionsToAnalyze = {
    id: string;
    relevantFile: string;
    language: string;
    improvedCode: string;
    existingCode: string;
};

export type CodeReviewConfig = {
    ignorePaths: string[];
    reviewOptions: ReviewOptions;
    ignoredTitleKeywords: string[];
    baseBranches: string[];
    automatedReviewActive: boolean;
    summary: SummaryConfig;
    languageResultPrompt: string;
    llmProvider?: LLMModelProvider;
    kodyRules?: Partial<IKodyRule>[];
    suggestionControl?: SuggestionControlConfig;
    pullRequestApprovalActive: boolean;
    kodusConfigFileOverridesWebPreferences: boolean;
    isRequestChangesActive?: boolean;
    kodyRulesGeneratorEnabled?: boolean;
    reviewModeConfig?: ReviewModeConfig;
    kodyFineTuningConfig?: KodyFineTuningConfig;
    isCommitMode?: boolean;
};

export type CodeReviewConfigWithoutLLMProvider = Omit<
    CodeReviewConfig,
    'llmProvider' | 'languageResultPrompt'
>;

export type CodeReviewConfigWithRepositoryInfo = Omit<
    CodeReviewConfig,
    'llmProvider' | 'languageResultPrompt'
> & {
    id: string;
    name: string;
    isSelected?: boolean;
}

// Omit every configuration that isn't present on the kodus configuration file.
export type KodusConfigFile = Omit<
    CodeReviewConfig,
    | 'llmProvider'
    | 'languageResultPrompt'
    | 'kodyRules'
    | 'kodusConfigFileOverridesWebPreferences'
    | 'kodyRulesGeneratorEnabled'
> & {
    version: string;
};

export enum ReviewModeResponse {
    LIGHT_MODE = 'light_mode',
    HEAVY_MODE = 'heavy_mode',
}

export enum ReviewModeConfig {
    LIGHT_MODE_FULL = 'light_mode_full',
    LIGHT_MODE_PARTIAL = 'light_mode_partial',
    HEAVY_MODE = 'heavy_mode',
}

export type KodyFineTuningConfig = {
    enabled: boolean;
};
