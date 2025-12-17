import { IClusterizedSuggestion } from '@/core/domain/kodyFineTuning/interfaces/kodyFineTuning.interface';
import { IKodyRule } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { IPullRequestMessages } from '@/core/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';
import { ISuggestionByPR } from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { CodeReviewPipelineContext } from '@/core/infrastructure/adapters/services/codeBase/codeReviewPipeline/context/code-review-pipeline.context';
import type { ContextAugmentationsMap } from '@/core/infrastructure/adapters/services/context/code-review-context-pack.service';
import {
    GetImpactAnalysisResponse,
    TaskStatus,
} from '@/ee/kodyAST/codeASTAnalysis.service';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import type { ContextLayer, ContextPack } from '@context-os-core/interfaces';
import { BYOKConfig, LLMModelProvider } from '@kodus/kodus-common/llm';
import { DeepPartial } from 'typeorm';
import z from 'zod';
import { OrganizationAndTeamData } from './organizationAndTeamData';
import { ConfigLevel } from './pullRequestMessages.type';

export interface IFinalAnalysisResult {
    validSuggestionsToAnalyze: Partial<CodeSuggestion>[];
    discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[];
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
    platform: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops';
    id: string;
    name: string;
    fullName?: string;
    language: string;
    defaultBranch: string;
};

export type AnalysisContext = {
    pullRequest: CodeReviewPipelineContext['pullRequest'];
    repository?: Partial<Repository>;
    organizationAndTeamData: OrganizationAndTeamData;
    codeReviewConfig?: CodeReviewConfig;
    platformType: string;
    action?: string;
    baseDir?: string;
    impactASTAnalysis?: GetImpactAnalysisResponse;
    reviewModeResponse?: ReviewModeResponse;
    kodyFineTuningConfig?: KodyFineTuningConfig;
    fileChangeContext?: FileChangeContext;
    clusterizedSuggestions?: IClusterizedSuggestion[];
    validCrossFileSuggestions?: CodeSuggestion[];
    tasks?: {
        astAnalysis?: {
            taskId: string;
            status?: TaskStatus;
            hasRelevantContent?: boolean;
        };
    };
    /** Conteúdo de arquivos externos e metadados carregados pelo PromptContextLoader. */
    externalPromptContext?: any;
    /** Conjunto de camadas prontas para composição do ContextPack (arquivos, instruções). */
    externalPromptLayers?: ContextLayer[];
    correlationId: string;
    /** ContextPack compartilhado com instruções e camadas externas para as etapas de análise. */
    sharedContextPack?: ContextPack;
    /** Overrides resolvidos por arquivo, usados no preparo de contexto por file. */
    filePromptOverrides?: Record<string, CodeReviewConfig['v2PromptOverrides']>;
    /** Overrides ativos para a execução atual (ex: overrides específicos de arquivo). Tem precedência sobre o Pack. */
    activeOverrides?: CodeReviewConfig['v2PromptOverrides'];
    /** Augmentations geradas dinamicamente para o arquivo atual. */
    fileAugmentations?: ContextAugmentationsMap;
    /** Augmentations geradas dinamicamente durante o pipeline, mapeadas por nome de arquivo. */
    augmentationsByFile?: Record<string, ContextAugmentationsMap>;
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
};

export type AIAnalysisResult = {
    codeSuggestions: Partial<CodeSuggestion>[];
    codeReviewModelUsed?: {
        generateSuggestions?: string;
        safeguard?: string;
    };
};

export type AIAnalysisResultPrLevel = {
    codeSuggestions: ISuggestionByPR[];
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
    llmPrompt?: string;
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
    type?: SuggestionType;
    createdAt?: string;
    updatedAt?: string;
    action?: string;
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
    patchWithLinesStr?: string;
};

export type FileChangeContext = {
    file: FileChange;
    relevantContent?: string | null;
    patchWithLinesStr?: string;
    hasRelevantContent?: boolean;
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

export const reviewOptionsSchema = z.object({
    security: z.boolean(),
    code_style: z.boolean(),
    refactoring: z.boolean(),
    error_handling: z.boolean(),
    maintainability: z.boolean(),
    potential_issues: z.boolean(),
    documentation_and_comments: z.boolean(),
    performance_and_optimization: z.boolean(),
    kody_rules: z.boolean(),
    breaking_changes: z.boolean(),
    bug: z.boolean(),
    performance: z.boolean(),
    cross_file: z.boolean(),
});

export interface ReviewOptions {
    security?: boolean;
    code_style?: boolean;
    refactoring?: boolean;
    error_handling?: boolean;
    maintainability?: boolean;
    potential_issues?: boolean;
    documentation_and_comments?: boolean;
    performance_and_optimization?: boolean;
    kody_rules?: boolean;
    breaking_changes?: boolean;
    bug?: boolean;
    performance?: boolean;
    cross_file?: boolean;
}

export enum BehaviourForExistingDescription {
    REPLACE = 'replace',
    CONCATENATE = 'concatenate',
    COMPLEMENT = 'complement',
}

export enum LimitationType {
    FILE = 'file',
    PR = 'pr',
    SEVERITY = 'severity',
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
    behaviourForNewCommits?: BehaviourForNewCommits;
}

export interface SuggestionControlConfig {
    groupingMode?: GroupingModeSuggestions;
    limitationType?: LimitationType;
    maxSuggestions: number;
    severityLevelFilter?: SeverityLevel;
    applyFiltersToKodyRules?: boolean; // Default: false - Aplica TODOS os filtros (severidade + quantidade) nas Kody Rules
    severityLimits?: {
        low: number;
        medium: number;
        high: number;
        critical: number;
    };
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
    reviewCadence: ReviewCadence;
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
    ideRulesSyncEnabled?: boolean;
    kodyFineTuningConfig?: KodyFineTuningConfig;
    configLevel?: ConfigLevel;
    directoryId?: string;
    directoryPath?: string;
    runOnDraft?: boolean;
    codeReviewVersion?: CodeReviewVersion;
    byokConfig?: BYOKConfig;
    /**
     * Optional overrides for v2 prompts (categories and severity guidance only).
     * These influence only the v2 system prompt used during suggestion generation.
     */
    v2PromptOverrides?: {
        categories?: {
            /**
             * Additional or replacement description bullets for each label.
             * Labels are fixed to: bug, performance, security.
             */
            descriptions?: {
                bug?: string;
                performance?: string;
                security?: string;
            };
        };
        severity?: {
            /**
             * Optional flag bullet points per level to guide classification.
             * Levels are fixed to: critical, high, medium, low.
             */
            flags?: {
                critical?: string;
                high?: string;
                medium?: string;
                low?: string;
            };
        };
        generation?: {
            main?: string;
        };
    };
    contextReferenceId?: string;
    contextRequirementsHash?: string;
    // This is the default branch of the repository, used only during the review process
    // This field is populated dynamically from the API (GitHub/GitLab) and should NOT be saved to the database
    // It represents the repository's default branch (e.g., 'main', 'develop') that comes from the code management platform
    baseBranchDefault?: string;
};

export enum CodeReviewVersion {
    LEGACY = 'legacy',
    v2 = 'v2',
}

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
};

// Omit every configuration that isn't present on the kodus configuration file.
export type KodusConfigFile = DeepPartial<
    Omit<CodeReviewConfig, 'llmProvider' | 'languageResultPrompt' | 'kodyRules'>
> & {
    version: string;
    customMessages?: Pick<
        IPullRequestMessages,
        'startReviewMessage' | 'endReviewMessage' | 'globalSettings'
    >;
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

export enum ReviewPreset {
    SPEED = 'speed',
    SAFETY = 'safety',
    COACH = 'coach',
}

export type KodyFineTuningConfig = {
    enabled: boolean;
};

export enum SuggestionType {
    CROSS_FILE = 'cross_file',
}

export type ReviewCadence = {
    type: ReviewCadenceType;
    timeWindow?: number;
    pushesToTrigger?: number;
};

export interface AutomaticReviewStatus {
    previousStatus: ReviewCadenceState;
    currentStatus: ReviewCadenceState;
    reasonForChange?: string;
    pauseCommentId?: string;
}

export enum ReviewCadenceType {
    AUTOMATIC = 'automatic',
    MANUAL = 'manual',
    AUTO_PAUSE = 'auto_pause',
}

export enum ReviewCadenceState {
    AUTOMATIC = 'automatic',
    COMMAND = 'command',
    PAUSED = 'paused',
}

export enum BehaviourForNewCommits {
    NONE = 'none',
    REPLACE = 'replace',
    CONCATENATE = 'concatenate',
}
