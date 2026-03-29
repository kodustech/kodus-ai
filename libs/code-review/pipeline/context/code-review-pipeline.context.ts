import type { ContextEvidence, ContextLayer, ContextPack } from '@kodus/flow';
import { IExternalPromptContext } from '@libs/ai-engine/domain/prompt/interfaces/promptExternalReference.interface';
import { ContextAugmentationsMap } from '@libs/ai-engine/infrastructure/adapters/services/context/interfaces/code-review-context-pack.interface';
import { AutomationExecutionEntity } from '@libs/automation/domain/automationExecution/entities/automation-execution.entity';
import {
    CreateSandboxParams,
    SandboxInstance,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { IPullRequestMessages } from '@libs/code-review/domain/pullRequestMessages/interfaces/pullRequestMessages.interface';
import { CollectCrossFileContextsResult } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
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
import { TaskStatus } from '@libs/ee/kodyAST/interfaces/code-ast-analysis.interface';
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
        lastExecution?: AutomationExecutionEntity;
        notificationHandled?: boolean;
        showStatusFeedback?: boolean;
        forceFullRerun?: boolean;
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

    validSuggestionsByPR?: ISuggestionByPR[];
    validCrossFileSuggestions?: CodeSuggestion[];

    /** Business logic validation results — merged into PR-level comments by CreatePrLevelCommentsStage. */
    businessLogicResults?: ISuggestionByPR[];

    /**
     * SHA-256 hash of the PR body at the time of the last successful business logic
     * validation. Written by ProcessFilesPrLevelReviewStage and persisted to
     * dataExecution.businessLogicHash to enable dedup on subsequent runs.
     */
    businessLogicPrBodyHash?: string;

    lineComments?: CommentResult[];

    tasks?: {
        astAnalysis?: {
            taskId: string;
            status?: TaskStatus;
        };
    };
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

    /** Sandbox handle kept alive for safeguard agent verification */
    sandboxHandle?: SandboxInstance;

    /** Parameters used to create the sandbox — kept for renewal if it expires */
    sandboxCloneParams?: CreateSandboxParams;

    correlationId?: string;
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
