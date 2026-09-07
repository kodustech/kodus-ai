import type {
    ContextLayer,
    ContextPack,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
import { LLMModelProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';
import { ImplementationStatus } from '@libs/platformData/domain/pullRequests/enums/implementationStatus.enum';
import { PriorityStatus } from '@libs/platformData/domain/pullRequests/enums/priorityStatus.enum';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';
import { DeepPartial } from 'typeorm';
import z from 'zod';

import type { ContextAugmentationsMap } from '@libs/ai-engine/infrastructure/adapters/services/context/interfaces/code-review-context-pack.interface';
import { SeverityLevel } from '@libs/common/utils/enums/severityLevel.enum';

import { CreateSandboxParams } from '@libs/sandbox/domain/contracts/sandbox.provider';
import {
    CrossFileContextSnippet,
    RemoteCommands,
} from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    BehaviourForExistingDescription,
    BehaviourForNewCommits,
    ClusteringType,
    CodeReviewVersion,
    GroupingModeSuggestions,
    LimitationType,
    ReviewCadenceState,
    ReviewCadenceType,
    ReviewModeConfig,
    ReviewModeResponse,
    SuggestionType,
} from '@libs/core/domain/enums/code-review.enum';
import { IClusterizedSuggestion } from '@libs/kodyFineTuning/domain/interfaces/kodyFineTuning.interface';
import type { TraceContextDecision } from '@libs/cli-review/domain/types/trace-context.types';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { KodyKnowledgeApprovalConfig } from '@libs/common/utils/kody-rules/knowledge-approval';
import { OrganizationAndTeamData } from './organizationAndTeamData';
import { ConfigLevel } from './pullRequestMessages.type';
import type { ReviewPolicyConfig } from '@libs/code-review/domain/review-policy/review-policy';

export {
    BehaviourForExistingDescription,
    BehaviourForNewCommits,
    ClusteringType,
    CodeReviewVersion,
    GroupingModeSuggestions,
    LimitationType,
    ReviewCadenceState,
    ReviewCadenceType,
    ReviewModeConfig,
    ReviewModeResponse,
    SuggestionType,
};

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

export type Repository = {
    platform: 'github' | 'gitlab' | 'bitbucket' | 'azure-devops' | 'forgejo';
    id: string;
    name: string;
    fullName?: string;
    language: string;
    defaultBranch: string;
};

export type AnalysisContext<TPullRequest = any> = {
    workflowJobId?: string; // ID of the workflow job (for pausing/resuming)
    pullRequest: TPullRequest;
    repository?: Partial<Repository>;
    organizationAndTeamData: OrganizationAndTeamData;
    codeReviewConfig?: CodeReviewConfig;
    platformType: string;
    action?: string;
    baseDir?: string;
    correlationId?: string;
    reviewModeResponse?: ReviewModeResponse;
    kodyFineTuningConfig?: KodyFineTuningConfig;
    fileChangeContext?: FileChangeContext;
    clusterizedSuggestions?: IClusterizedSuggestion[];
    validCrossFileSuggestions?: CodeSuggestion[];
    /** External file content and metadata loaded by PromptContextLoader. */
    externalPromptContext?: any;
    /** Set of layers ready for ContextPack composition (files, instructions). */
    externalPromptLayers?: ContextLayer[];
    /** Shared ContextPack with instructions and external layers for analysis stages. */
    sharedContextPack?: ContextPack;
    /** Overrides resolved per file, used in context preparation by file. */
    filePromptOverrides?: Record<string, CodeReviewConfig['v2PromptOverrides']>;
    /** Active overrides for current execution (e.g. file-specific overrides). Takes precedence over the Pack. */
    activeOverrides?: CodeReviewConfig['v2PromptOverrides'];
    /** Dynamically generated augmentations for current file. */
    fileAugmentations?: ContextAugmentationsMap;
    /** Dynamically generated augmentations during pipeline, mapped by filename. */
    augmentationsByFile?: Record<string, ContextAugmentationsMap>;
    /** Cross-file context snippets relevant to the current file under review. */
    crossFileSnippets?: CrossFileContextSnippet[];
    /** Decisions recorded by Kodus Trace, scoped to the files in this diff. */
    traceDecisions?: TraceContextDecision[];
    /** Documentation context grouped by file path, built in previous pipeline stages. */
    documentationByFile?: Record<string, DocumentationContextItem[]>;
    /** Documentation context scoped to the current file under analysis. */
    documentationContext?: DocumentationContextItem[];
    /** Remote commands for safeguard agent verification (from E2B sandbox) */
    remoteCommands?: RemoteCommands;
    /** Parameters used to create the sandbox — kept for renewal if it expires */
    getFreshCloneParams?: () => Promise<CreateSandboxParams>;
    /** Graph JSON from kodus-graph parse (nodes + edges) for content formatting */
    callGraphJson?: { nodes: any[]; edges: any[] };
};

export type DocumentationContextItem = {
    query: string;
    title: string;
    url: string;
    snippet: string;
    source: string;
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
    crossFileEvidence?: boolean;
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

    isCommittable?: boolean;
    validatedData?: {
        code: string;
        diff: string;
        lineStart: number;
        lineEnd: number;
    };
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
    astFormattedContent?: string;
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

export type FallbackSuggestionsBySeverity = {
    critical: Partial<CodeSuggestion>[];
    high: Partial<CodeSuggestion>[];
    medium: Partial<CodeSuggestion>[];
    low: Partial<CodeSuggestion>[];
};

export type ReviewComment = {
    id: number;
    pullRequestReviewId: string;
    body: string;
    createdAt: string;
    updatedAt: string;
};

export const reviewOptionsSchema = z.object({
    bug: z.boolean(),
    performance: z.boolean(),
    security: z.boolean(),
    cross_file: z.boolean().optional(), // Legacy — no longer shown in UI but kept for backward compat
    business_logic: z.boolean().optional(),
});

export interface ReviewOptions {
    bug?: boolean;
    performance?: boolean;
    security?: boolean;
    cross_file?: boolean; // Legacy — no longer shown in UI
    business_logic?: boolean;
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
    applyFiltersToKodyRules?: boolean; // Default: false - Applies ALL filters (severity + quantity) to Kody Rules
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
    reviewMode?: 'fast' | 'normal' | 'deep';
    /** Versioned execution policy resolved into an immutable per-run snapshot. */
    reviewPolicy?: ReviewPolicyConfig;
    /** HEAVY mode — extra critic pass in the finder for more recall. Opt-in per
     *  review (CLI `--heavy` / PR `@kody review --heavy`). Off by default. */
    heavy?: boolean;
    reviewOptions: ReviewOptions;
    ignoredTitleKeywords: string[];
    baseBranches: string[];
    automatedReviewActive: boolean;
    showStatusFeedback?: boolean;
    reviewCadence: ReviewCadence;
    summary: SummaryConfig;
    languageResultPrompt: string;
    llmProvider?: LLMModelProvider;
    kodyRules?: Partial<IKodyRule>[];
    kodyMemoryRules?: Partial<IKodyRule>[];
    suggestionControl?: SuggestionControlConfig;
    pullRequestApprovalActive: boolean;
    kodusConfigFileOverridesWebPreferences: boolean;
    isRequestChangesActive?: boolean;
    kodyRulesGeneratorEnabled?: boolean;
    // Provider-native user ids whose review comments are EXCLUDED when learning
    // Kody Rules from past reviews. Denylist: empty/absent = learn from everyone.
    kodyLearningExcludedReviewers?: string[];
    kodyKnowledgeApproval?: KodyKnowledgeApprovalConfig;
    reviewModeConfig?: ReviewModeConfig;
    ideRulesSyncEnabled?: boolean;
    kodyFineTuningConfig?: KodyFineTuningConfig;
    configLevel?: ConfigLevel;
    directoryId?: string;
    directoryPath?: string;
    directoryFolders?: Array<{ id: string; name: string; path: string }>;
    runOnDraft?: boolean;
    codeReviewVersion?: CodeReviewVersion;
    byokConfig?: NormalizedModel;
    /**
     * The single model slot the run resolved for the `codeReview` task via the
     * v2 resolver (`resolveTaskModel` / `StaticTaskStrategy`). This is the
     * native replacement for the internal `byokConfig.main` intermediate:
     * downstream pipeline stages read their telemetry/limit metadata
     * (`provider`, `maxInputTokens`, `maxConcurrentRequests`) off this resolved
     * slot instead of the `{main,fallback}` shape. `null`/absent means the run
     * resolved the env/managed default (no BYOK). Carries CIPHERTEXT apiKey —
     * decryption happens only inside `buildModelFromSlot`.
     */
    resolvedModelSlot?: NormalizedModel;
    /**
     * Optional override for the BYOK *main* model used to run code reviews.
     * Empty string '' means "inherit": directory -> repository -> the main
     * model defined in the BYOK settings page.
     *
     * Legacy NAME-based override, kept during the transition window (D-05).
     * Superseded by `byokModelId` going forward; the routing resolver reads
     * `byokModelId` first and only falls back to this NAME when it is absent.
     */
    byokModel?: string;
    /**
     * Id-based BYOK model override (Phase 4). References a v2 `models[]` entry
     * by its stable `id` (BYOKConfig.models[].id), so the routing resolver
     * addresses the exact model regardless of a later rename. This is the top
     * of the routing precedence chain (folder/repo override > task override >
     * default). Empty/absent means "inherit"; when both `byokModelId` and the
     * legacy `byokModel` are set, the id wins.
     */
    byokModelId?: string;
    /** @deprecated Reflection/verify was removed — it hurt recall more than it helped precision. */
    enableReflection?: boolean;
    /**
     * Optional overrides for v2 prompts (categories and severity guidance only).
     * These influence only the system prompt used during suggestion generation.
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
    enableCommittableSuggestions?: boolean;
    /** Experimental A/B (default off): when true, the finder's readFile returns
     *  a symbol outline for range-less reads of large files instead of dumping
     *  the head — fewer model tokens. Threaded to ReviewAgentInput.outlineFirst. */
    outlineFirst?: boolean;
    /**
     * Cross-repo context (#1576): sibling repositories the agent may grep/read
     * during review. Empty/absent → feature fully off. Only repos already
     * connected to the same organization are accepted (validated at review
     * time). Soft cap of 3 per review.
     *
     * Runtime engine lives under `libs/ee/linked-repositories` (Enterprise
     * License) and is plan-gated to Teams / Enterprise.
     *
     * ```yaml
     * linkedRepositories:
     *   - repository: "org/backend-api"
     *     instructions: "REST API this frontend consumes"
     *     ref: main   # optional
     * ```
     */
    linkedRepositories?: LinkedRepositoryConfig[];
    // This is the default branch of the repository, used only during the review process
    // This field is populated dynamically from the API (GitHub/GitLab) and should NOT be saved to the database
    // It represents the repository's default branch (e.g., 'main', 'develop') that comes from the code management platform
    baseBranchDefault?: string;
};

/**
 * One linked repository used as cross-repo review context.
 * See `linkedRepositories` on {@link CodeReviewConfig}.
 */
export type LinkedRepositoryConfig = {
    /** Full name of the linked repo (`owner/repo`). */
    repository: string;
    /** Free-text hint for the agent (what the link is for). */
    instructions?: string;
    /** Optional ref pin. When omitted, cascade: PR head branch → default branch. */
    ref?: string;
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
};

// Omit every configuration that isn't present on the kodus configuration file.
export type KodusConfigFile = DeepPartial<
    Omit<CodeReviewConfig, 'llmProvider' | 'languageResultPrompt' | 'kodyRules'>
> & {
    version: string;
    customMessages?: Pick<
        IPullRequestMessages,
        | 'startReviewMessage'
        | 'endReviewMessage'
        | 'errorReviewMessage'
        | 'globalSettings'
    >;
};

export type KodyFineTuningConfig = {
    enabled: boolean;
};

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
