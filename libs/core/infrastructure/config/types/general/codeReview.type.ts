import { cliInstallProblem } from './cli-install';
import type {
    ContextLayer,
    ContextPack,
} from '@libs/ai-engine/infrastructure/adapters/services/context/context-pack';
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
    /** The finder's whole explanation, labels stripped; `suggestionContent` is the short body shown to people. */
    fullExplanation?: string;
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
    /** Earlier Kody suggestion on this PR that this one revises (#2039/#2020). */
    revisesSuggestionId?: string;
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

    /**
     * The finding is about the whole file, not a line inside the diff: it comes
     * from a Kody Rule that declared it needs context beyond the hunk, and its
     * cited lines fall outside every changed hunk (issue #1826). Delivered as a
     * PR-level comment citing `file:line` instead of an inline one, which is
     * where a rule like "this function is too long" has always died silently.
     */
    fileAnchored?: boolean;
    /**
     * Where a finding came from, when it was not the model. Present on
     * findings a deterministic analyzer or the customer's CI produced, so a
     * published comment can name its source and rule instead of implying Kody
     * reasoned its way there.
     */
    evidence?: {
        /** e.g. "kodus-analyzer", or "ci:semgrep". */
        source: string;
        ruleId?: string;
        ruleUrl?: string;
        /** Severity as the producing tool reported it, before normalization. */
        analyzerSeverity?: string;
    };
    /**
     * Other `file:lineStart-lineEnd` locations where the same Kody Rule was
     * violated, for a finding dedupKodyRulesByRuleUuid merged into its most
     * detailed representative (issue #2015). The comment keeps the
     * representative's anchor and names every other location in its body.
     * Deliberately NOT baked into suggestionContent at merge time: the content
     * formatter rewrites that field afterwards and folds or drops an appended
     * list, so executeStage renders it after the formatter runs.
     */
    kodyRuleOtherLocations?: string[];
    /** Merged finding locations, rendered after the content formatter. */
    alsoFoundIn?: string[];
    /** The custom agent that produced the finding (#2172); drives its tag. */
    customAgent?: {
        id: string;
        name: string;
        color?: string;
    };
    /** `convention` findings apply a guide and go through the convention check. */
    kind?: 'bug' | 'convention';
    /** The guide passage a convention finding applies, checked on the base branch. */
    source?: {
        file: string;
        section?: string;
        quote: string;
    };
    /**
     * Why a finding the review kept was not posted, when `priorityStatus`
     * alone does not say: a shadow-mode custom agent's finding, or one past
     * its agent's `maxComments` (#2172).
     */
    notSentReason?: 'custom-agent-shadow' | 'custom-agent-max-comments';

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

/**
 * Custom review agents (#2172): team-defined reviewers that run next to the
 * generalist with their own instructions, scope, tools and presentation.
 * Limits are enforced on save (DTO) and again when the config is resolved.
 */
export const CUSTOM_AGENT_LIMITS = {
    /** Agents per resolved config (repository or directory). */
    maxAgents: 5,
    /** CLI tools per agent. */
    maxCliTools: 3,
    /** Skills linked per target (main review or one agent). */
    maxSkills: 20,
    /** Docs linked per target (main review or one agent). */
    maxDocs: 10,
    /** Token budget for the docs a target loads whole. */
    maxDocTokens: 20000,
    maxInstructionsLength: 8000,
    maxWritingLength: 2000,
} as const;

/**
 * A CLI install command must pin every package it installs (`pkg@1.2.3`,
 * `pkg==1.2.3`, or a sha256 digest): an unpinned install would let a moving
 * registry tag decide what runs next to the team's secrets. The full rule is
 * `checkCliInstallCommand` in `./cli-install`.
 */

/** Environment variable name a CLI secret is exposed under. */
export const CLI_SECRET_ENV_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

/** `KnowledgeItem.linkedTo` entry that links a skill or doc to the generalist. */
export const KNOWLEDGE_MAIN_REVIEW_TARGET = 'main-review' as const;

export const cliToolSecretSchema = z.object({
    env: z.string().regex(CLI_SECRET_ENV_PATTERN),
    /** Encrypted at rest; decrypted only into the CLI process env. */
    ciphertext: z.string().min(1),
});

export const cliToolConfigSchema = z.object({
    name: z.string().min(1),
    install: z
        .string()
        .min(1)
        .superRefine((install, ctx) => {
            const problem = cliInstallProblem(install);
            if (problem) ctx.addIssue({ code: 'custom', message: problem });
        }),
    binary: z.string().min(1),
    /** argv must start with one of these (no shell is involved). */
    allowedPrefixes: z.array(z.string().min(1)).min(1),
    /** Markdown the agent reads to learn how to call the CLI. */
    usage: z.string(),
    /** True when the CLI executes project code (tests, builds): no secrets then. */
    runsProjectCode: z.boolean(),
    secrets: z.array(cliToolSecretSchema).optional(),
    /** Hosts the CLI may reach; everything else is blocked. */
    allowedDomains: z.array(z.string().min(1)),
    timeoutSec: z.number().int().positive().optional(),
});

export const customAgentMcpToolsSchema = z.object({
    integrationId: z.string().min(1),
    tools: z.array(z.string().min(1)),
});

export const customAgentPresentationSchema = z.object({
    tag: z.object({ color: z.string().min(1) }),
    format: z.enum(['inline', 'single-comment']),
    minSeverity: z.enum(SeverityLevel).optional(),
    maxComments: z.number().int().positive().optional(),
    suggestedFix: z.enum(['when-confident', 'never']),
    writing: z.string().max(CUSTOM_AGENT_LIMITS.maxWritingLength).optional(),
    /** `shadow` stores findings as NOT_SENT; `post` publishes them. */
    mode: z.enum(['shadow', 'post']),
});

export const customAgentConfigSchema = z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    enabled: z.boolean(),
    instructions: z.string().max(CUSTOM_AGENT_LIMITS.maxInstructionsLength),
    /** Globs over the changed files; the agent runs only when one matches. */
    scope: z.object({
        include: z.array(z.string()).optional(),
        exclude: z.array(z.string()).optional(),
    }),
    tools: z.object({
        /** ast-grep rule YAML the agent may run. */
        astGrepConfig: z.string().optional(),
        mcp: z.array(customAgentMcpToolsSchema).optional(),
        cli: z
            .array(cliToolConfigSchema)
            .max(CUSTOM_AGENT_LIMITS.maxCliTools)
            .superRefine((clis, ctx) => {
                const duplicate = firstDuplicate(clis.map((c) => c.name));
                if (duplicate !== undefined) {
                    ctx.addIssue({
                        code: 'custom',
                        message: `CLI name "${duplicate}" is used twice`,
                    });
                }
            })
            .optional(),
    }),
    /** BYOK model ids overriding the `customAgent` / `customAgentCheck` tasks. */
    models: z
        .object({
            run: z.string().optional(),
            check: z.string().optional(),
        })
        .optional(),
    presentation: customAgentPresentationSchema,
});

/** The agents of one config level: ids are unique, since findings, links,
 *  secrets and model overrides all name an agent by its id. */
export const customAgentsSchema = z
    .array(customAgentConfigSchema)
    .max(CUSTOM_AGENT_LIMITS.maxAgents)
    .superRefine((agents, ctx) => {
        const duplicate = firstDuplicate(agents.map((a) => a.id));
        if (duplicate !== undefined) {
            ctx.addIssue({
                code: 'custom',
                message: `agent id "${duplicate}" is used twice`,
            });
        }
    });

export const knowledgeItemSchema = z.object({
    /** Path in the repository, read from the PR's target branch. */
    path: z.string().min(1),
    kind: z.enum(['skill', 'doc']),
    linkedTo: z.array(
        z.union([
            z.literal(KNOWLEDGE_MAIN_REVIEW_TARGET),
            z.object({ agentId: z.string().min(1) }),
        ]),
    ),
});

/** The first value that appears twice, if any. */
export function firstDuplicate<T>(values: readonly T[]): T | undefined {
    const seen = new Set<T>();
    for (const value of values) {
        if (seen.has(value)) return value;
        seen.add(value);
    }
    return undefined;
}

/**
 * Knowledge links that name an agent the same save does not configure. A
 * dangling link would never load, and would silently start loading if an
 * agent with that id were created later.
 */
export function knowledgeLinkProblems(
    knowledge:
        | ReadonlyArray<{
              path?: string;
              linkedTo?: readonly unknown[];
              [key: string]: unknown;
          }>
        | undefined,
    agents: ReadonlyArray<{ id?: string }> | undefined,
): string[] {
    const ids = new Set((agents ?? []).map((agent) => agent?.id));
    const problems: string[] = [];
    for (const item of knowledge ?? []) {
        for (const target of item?.linkedTo ?? []) {
            const agentId =
                target && typeof target === 'object'
                    ? (target as { agentId?: unknown }).agentId
                    : undefined;
            if (typeof agentId === 'string' && !ids.has(agentId)) {
                problems.push(
                    `${item.path} links to unknown agent "${agentId}"`,
                );
            }
        }
    }
    return problems;
}

export type CliToolSecret = z.infer<typeof cliToolSecretSchema>;
export type CliToolConfig = z.infer<typeof cliToolConfigSchema>;
export type CustomAgentPresentation = z.infer<
    typeof customAgentPresentationSchema
>;
export type CustomAgentConfig = z.infer<typeof customAgentConfigSchema>;
export type KnowledgeItem = z.infer<typeof knowledgeItemSchema>;
export type KnowledgeLinkTarget = KnowledgeItem['linkedTo'][number];

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
    /** HEAVY mode — extra critic pass in the finder for more recall. Opt-in per
     *  review (CLI `--heavy` / PR `@kody review --heavy`). Off by default. */
    heavy?: boolean;
    reviewOptions: ReviewOptions;

    /**
     * Deterministic evidence sources. Off by default: reading a customer's CI
     * costs API calls on every review, so it stays opt-in until something
     * consumes the result.
     */
    deterministicEvidence?: {
        /** Read check runs / statuses the customer's own pipeline produced. */
        ciChecks?: boolean;
        /**
         * Per-tool switch. `auto` runs a tool only when the customer's CI has
         * no equivalent analysis; `on` runs it regardless; absent is off.
         */
        /**
         * Per tool: on or off. An enabled tool still stands down when the
         * repository's own CI already covers its category.
         */
        tools?: Record<string, boolean>;
    };
    ignoredTitleKeywords: string[];
    baseBranches: string[];
    automatedReviewActive: boolean;
    showStatusFeedback?: boolean;
    reviewCadence: ReviewCadence;
    summary: SummaryConfig;
    languageResultPrompt: string;
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
    /**
     * Team-defined review agents (#2172), same cascade as `reviewOptions`.
     * `level` records where an entry was declared once the cascade merged it.
     */
    customAgents?: Array<CustomAgentConfig & { level?: ConfigLevel }>;
    /** Skills and docs in the repository, linked to the main review or to agents. */
    knowledge?: KnowledgeItem[];
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
    'languageResultPrompt'
>;

export type CodeReviewConfigWithRepositoryInfo = Omit<
    CodeReviewConfig,
    'languageResultPrompt'
> & {
    id: string;
    name: string;
    isSelected?: boolean;
};

// Omit every configuration that isn't present on the kodus configuration file.
export type KodusConfigFile = DeepPartial<
    Omit<CodeReviewConfig, 'languageResultPrompt' | 'kodyRules'>
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
