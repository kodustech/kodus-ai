import type { ContextEvidence, ContextLayer, ContextPack } from '@kodus/flow';
import { IExternalPromptContext } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { ContextAugmentationsMap } from '@libs/ai-engine/infrastructure/adapters/services/context/interfaces/code-review-context-pack.interface';
import { AutomationExecutionEntity } from '@libs/automation/domain/automationExecution/entities/automation-execution.entity';
import {
    CreateSandboxParams,
    SandboxInstance,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { CollectCrossFileContextsResult } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { ReviewErrorCategory } from '@libs/code-review/infrastructure/agents/llm/error-classifier';
import type { ReviewWarning } from '@libs/code-review/infrastructure/agents/llm/review-warnings';
import { PlatformType } from '@libs/core/domain/enums';
import {
    AnalysisContext,
    AutomaticReviewStatus,
    CodeReviewConfig,
    CodeSuggestion,
    CommentResult,
    FileChange,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { Commit } from '@libs/core/infrastructure/config/types/general/commit.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { PipelineContext } from '@libs/core/infrastructure/pipeline/interfaces/pipeline-context.interface';
import { IClusterizedSuggestion } from '@libs/kodyFineTuning/domain/interfaces/kodyFineTuning.interface';
import { ISuggestionByPR } from '@libs/platformData/domain/pullRequests/interfaces/pullRequests.interface';

export type PullRequestType = {
    number: number;
    title: string;
    base: {
        repo: {
            fullName: string;
        };
        ref: string;
    };
    head?: {
        sha: string;
        ref: string;
    };
    repository: Repository;
    isDraft: boolean;
    tags?: string[];
    stats: {
        total_additions: number;
        total_deletions: number;
        total_files: number;
        total_lines_changed: number;
    };
    [key: string]: any;
};

export interface CodeReviewPipelineContext extends PipelineContext {
    dryRun: {
        enabled: boolean;
        id?: string;
    };
    organizationAndTeamData: OrganizationAndTeamData;
    repository: Repository;
    branch: string;
    pullRequest: PullRequestType;
    teamAutomationId: string;
    origin: string;
    action: string;
    platformType: PlatformType;
    triggerCommentId?: number | string;
    userGitId?: string;

    codeReviewConfig?: CodeReviewConfig;
    automaticReviewStatus?: AutomaticReviewStatus;

    /** Commits NOVOS do PR (após lastAnalyzedCommit) - usados para validação de merge-only */
    prCommits?: Commit[];

    /** TODOS os commits do PR - usados para salvar no banco (aggregateAndSaveDataStructure) */
    prAllCommits?: Commit[];

    /** Arquivos preliminares SEM conteúdo - buscados no ResolveConfigStage para determinar config */
    preliminaryFiles?: FileChange[];

    /** Arquivos filtrados COM conteúdo - após aplicar ignorePaths no FetchChangedFilesStage */
    changedFiles?: FileChange[];

    /** List of files ignored by configuration patterns */
    ignoredFiles?: string[];

    lastExecution?: {
        commentId?: any;
        noteId?: any;
        threadId?: any;
        lastAnalyzedCommit?: any;
    };
    pipelineMetadata?: {
        // Inherited from PipelineContext.pipelineMetadata — re-declared here
        // because TS treats the child shape as a full override of the parent,
        // not an intersection, and the PipelineExecutor populates these at
        // runtime (see pipeline-executor.service.ts).
        pipelineId?: string;
        pipelineName?: string;
        parentPipelineId?: string;
        rootPipelineId?: string;
        lastExecution?: AutomationExecutionEntity;
        notificationHandled?: boolean;
        showStatusFeedback?: boolean;
        forceFullRerun?: boolean;
        /** Org subscription status (e.g. 'trial', 'active'), captured by
         *  ValidatePrerequisitesStage from the license validation so later
         *  stages can pick a trial-specific model. */
        subscriptionStatus?: string;
        /** Set by the pipeline provider before execution. When true, the
         *  agent (v4) engine will run, which has its own token-budget chunking
         *  and tolerates much larger PRs than the legacy engine. */
        useAgentEngine?: boolean;
        [key: string]: any;
    };

    initialCommentData?: {
        commentId: number;
        noteId: number;
        threadId?: number;
    };

    pullRequestMessagesConfig?: IPullRequestMessages;

    clusterizedSuggestions?: IClusterizedSuggestion[];

    preparedFileContexts: AnalysisContext<PullRequestType>[];

    fileAnalysisResults?: Array<{
        validSuggestionsToAnalyze: Partial<CodeSuggestion>[];
        discardedSuggestionsBySafeGuard: Partial<CodeSuggestion>[];
        file: FileChange;
    }>;

    prAnalysisResults?: {
        validSuggestionsByPR?: ISuggestionByPR[];
        validCrossFileSuggestions?: CodeSuggestion[];
    };

    validSuggestions: Partial<CodeSuggestion>[];
    discardedSuggestions: Partial<CodeSuggestion>[];
    lastAnalyzedCommit?: any;

    /**
     * Set by ValidateNewCommitsStage when lastAnalyzedCommit is no longer
     * reachable from the PR branch (rebase / force-push rewrote history).
     * Forwarded by CodeReviewHandlerService and persisted to
     * dataExecution.orphanedBaseCommit for observability. Absent on normal
     * runs.
     */
    orphanedBaseCommit?: {
        previousSha: string;
        currentHeadSha?: string;
        totalCommits: number;
    };

    validSuggestionsByPR?: ISuggestionByPR[];
    validCrossFileSuggestions?: CodeSuggestion[];

    /** Business logic validation results — merged into PR-level comments by CreatePrLevelCommentsStage. */
    businessLogicResults?: ISuggestionByPR[];

    /**
     * Per-stage outcome reported by BusinessLogicValidationStage (agent engine)
     * for UI/observer display. Distinct from the pipeline-wide statusInfo —
     * setting statusInfo.status = SKIPPED would abort the whole pipeline,
     * which is NOT what we want when only this validation is skipped.
     */
    businessLogicOutcome?: {
        kind: 'success' | 'gap_found' | 'skipped' | 'error';
        message: string;
        reason?: string;
    };

    /**
     * SHA-256 hash of the PR body at the time of the last successful business logic
     * validation. Written by ProcessFilesPrLevelReviewStage and persisted to
     * dataExecution.businessLogicHash to enable dedup on subsequent runs.
     */
    businessLogicPrBodyHash?: string;

    lineComments?: CommentResult[];

    // Resultados dos comentários de nível de PR
    prLevelCommentResults?: Array<CommentResult>;

    // Metadados dos arquivos processados (reviewMode, codeReviewModelUsed, etc.)
    fileMetadata?: Map<string, any>;

    /** Bloco com conteúdos de arquivos externos referenciados pelos prompts. */
    externalPromptContext?: IExternalPromptContext;
    /** Camadas já formatadas para incluir no ContextPack (ex.: arquivos, instruções). */
    externalPromptLayers?: ContextLayer[];

    /** ContextPack compartilhado entre os stages (instruções + camadas externas). */
    sharedContextPack?: ContextPack;
    /** Augmentations geradas dinamicamente durante o pipeline, mapeadas por nome de arquivo. */
    augmentationsByFile?: Record<string, ContextAugmentationsMap>;

    fileContextMap?: Record<string, FileContextAgentResult>;

    crossFileContexts?: CollectCrossFileContextsResult;

    discoveredPackages?: RepositoryPackageReference[];
    documentationQueryPlanByFile?: Record<string, DocumentationQueryPlanByFile>;
    documentationByFile?: Record<string, DocumentationItem[]>;

    /** Graph JSON (nodes + edges) from kodus-graph parse, used by GraphContentFormatter for Tier 1 formatting */
    callGraphJson?: { nodes: any[]; edges: any[] };

    /** Sandbox handle kept alive for safeguard agent verification */
    sandboxHandle?: SandboxInstance;

    /** Parameters used to create the sandbox — kept for renewal if it expires */
    getFreshCloneParams?: () => Promise<CreateSandboxParams>;

    correlationId?: string;

    /** Dedup telemetry captured by AgentReviewStage and exported by benchmark tooling. */
    dedupTrace?: DedupTraceSummary;

    /** Parent (job-level) AbortSignal. Forwarded from runCodeReview use-case
     *  via the strategy payload, then plumbed into AgentReviewStage so the
     *  agent-loop's local AbortController is aborted when the router-level
     *  job timeout fires (instead of leaving an LLM call running ghost). */
    parentSignal?: AbortSignal;

    /**
     * Snapshot of the most important failure surfaced by AgentReviewStage —
     * carried in-memory through the rest of the pipeline so the end-review
     * comment stage can render a precise message without re-walking errors[].
     * The actual outcome (SUCCESS / PARTIAL_ERROR / ERROR) lives in
     * `errors[].severity` and ultimately on `automation_execution.status`;
     * this only exists to interpolate the user-facing reason.
     */
    lastReviewError?: {
        category: ReviewErrorCategory;
        provider?: string;
        friendlyMessage: string;
        agentName?: string;
        occurredAt: Date;
    };

    /**
     * Fidelity warnings emitted when the pipeline had to drop quality to
     * fit a small model context window. Populated by AgentReviewStage
     * from the orchestrator's deduped list. Surfaced to the user as a
     * collapsible section in the end-review PR comment (rendered by
     * commentManager) and captured in telemetry. Absent / empty when the
     * review ran at full fidelity.
     */
    reviewWarnings?: ReviewWarning[];
}

export interface DedupTraceSuggestionSummary {
    relevantFile?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    label?: string;
    severity?: string;
    level?: string;
    oneSentenceSummary?: string;
}

export interface DedupTraceGroupSummary {
    keep: DedupTraceSuggestionSummary;
    duplicates: DedupTraceSuggestionSummary[];
}

export interface DedupTraceSummary {
    status: 'skipped' | 'success' | 'empty-keep-all' | 'failed-keep-all';
    totalClassifiedCount: number;
    kodyRulesSkippedCount: number;
    nonKodyInputCount: number;
    nonKodyOutputCount: number;
    finalOutputCount: number;
    uniqueCount: number;
    groupsCount: number;
    removedCount: number;
    errorMessage?: string;
    groups?: DedupTraceGroupSummary[];
    unique?: DedupTraceSuggestionSummary[];
}

export interface FileContextAgentResult {
    sandboxEvidences?: ContextEvidence[];
    resolvedPromptOverrides?: CodeReviewConfig['v2PromptOverrides'];
}

export interface RepositoryPackageReference {
    name: string;
    version?: string;
    ecosystem: 'npm' | 'pip' | 'maven' | 'gradle' | 'go' | 'cargo' | 'ruby';
    sourceFile: string;
}

export interface DocumentationQueryPlanByFile {
    queryTasks: DocumentationQueryTask[];
}

export interface DocumentationQueryTask {
    packageName: string;
    query: string;
}

export interface DocumentationItem {
    query: string;
    title: string;
    url: string;
    snippet: string;
    source: 'exa-search';
}
