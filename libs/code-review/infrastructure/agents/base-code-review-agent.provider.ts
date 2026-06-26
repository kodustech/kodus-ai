import { createLogger } from '@kodus/flow';
import { PromptRunnerService } from '@kodus/kodus-common/llm';
import { Injectable, Optional } from '@nestjs/common';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { ByokErrorCounter } from '@libs/notifications/application/byok-error-counter.service';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CodeReviewConfig,
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import {
    IKodyRule,
    resolveKodyRuleSeverityLevel,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { convertTiptapJSONToText } from '@libs/common/utils/tiptap-json';
import { isFileMatchingGlob } from '@libs/common/utils/glob-utils';
import { assignFileTiers, computeFileScores } from './llm/file-priority-scorer';
import { byokToVercelModel, getModelName } from './llm/byok-to-vercel';
import { resolveContextWindow } from './llm/model-context-window';
import { AgentContextWindowTooSmallError } from './llm/errors';
import type { ReviewWarning } from './llm/review-warnings';
import {
    resolveAdaptiveProfile,
    type AdaptiveProfile,
} from './llm/adaptive-fit';
import {
    runAgentLoop,
    type AgentLoopSecrets,
    type VerificationTraceSummary,
    type AgentAnomalySummary,
} from './llm/agent-loop';
import { propagateAttributes, startActiveObservation } from '@langfuse/tracing';
import { shouldTrace } from '@libs/core/log/langfuse';
import {
    CoverageSummary,
    CoverageTier,
    formatCoverageTargetsForPrompt,
    normalizeRepoPath,
} from './llm/coverage-ledger';

/** Rough token estimate: 1 token ≈ 4 characters */
const CHARS_PER_TOKEN = 4;
/**
 * Hard cap on execute() → executeChunked() → execute() recursion. Set to
 * 2 because the only legitimate recursion is one level deep (root review
 * fans out into per-batch executes). Anything beyond that means the
 * chunker couldn't reduce the file count and we'd loop forever — see
 * executeChunked's fail-fast guard, which catches the same condition at
 * its source. This guard remains as defense-in-depth.
 */
const MAX_RECURSION_DEPTH = 2;
/**
 * Ceiling on the ESTIMATED full prompt (not just diffs) as a fraction of
 * the model context window. At 0.55 we reserve ~45% of the window for
 * accumulated tool results, LLM reasoning, and response — which in
 * practice is the minimum headroom needed to keep the main loop from
 * starting at >70% utilization in PRs with hundreds of files.
 */
const PROMPT_BUDGET_RATIO = 0.55;
/**
 * Everything in the prompt that isn't the diff content itself:
 * system prompt (~22K chars), tool schemas (~40K chars), PR context,
 * and coverage target list. Kept as a char constant because it's used
 * to reduce the per-chunk diff budget when we split.
 */
const PROMPT_STATIC_OVERHEAD_CHARS = 62_000;
/**
 * Static overhead when the compact prompt path fires (adaptive-fit
 * `compact+` profiles). Measured empirically from the post-fix benchmark:
 * the compact system + user prompt strings drop ~14K chars (saving
 * ~3.5K tokens of the system prompt + the OutputFormat block + the
 * trimmed Rules). The 40K-char tool-schema block is untouched (we
 * deliberately don't reduce the toolset). 62K - 14K = 48K chars ≈ 12K
 * tokens of overhead, which gives 16K models ~4K of headroom for diffs.
 */
const PROMPT_STATIC_OVERHEAD_CHARS_COMPACT = 48_000;

/**
 * Operational cross-file anchoring rule appended to every <Scope> block. Without
 * it the model anchors cross-file findings on the UNCHANGED symptom file or a
 * placeholder path, and they get dropped at the @@PATH_MISMATCH@@ filter (the
 * relevantFile-not-in-changedFiles drop) before reaching Mongo. This keeps the
 * anchor on the changed trigger line so verify-kept findings survive.
 */
const SCOPE_CROSS_FILE_EXTRA = `
    CROSS-FILE: when the bug spans files, set relevantFile/relevantLinesStart/relevantLinesEnd to the CHANGED line that TRIGGERS it (the modified call, usage, import, or signature) — NOT the unchanged file where the symptom surfaces — and explain the cross-file effect in suggestionContent.
    NEVER emit a placeholder, guessed, "unknown", or non-diff path for relevantFile. If you cannot anchor the finding to a specific changed line present in this diff, OMIT the finding entirely.`;

/**
 * Low-signal glob patterns dropped from changedFiles only when a large PR
 * is reviewed in non-deep mode. Tests, docs, and pure styles rarely carry
 * the kinds of findings the agent targets, and keeping them in the diff
 * budget crowds out real production code.
 */
const LARGE_PR_AGGRESSIVE_FILTER_PATTERNS = [
    '**/*.spec.*',
    '**/*.test.*',
    '**/test/**',
    '**/tests/**',
    '**/__tests__/**',
    '**/*.md',
    '**/*.css',
    '**/*.scss',
];

/**
 * Preflight guard: when the agent's static overhead (system prompt +
 * tool schemas + coverage list + PR context) already exceeds the
 * model's context window, no PR can ever fit and the LLM call would
 * fail immediately with a 4xx. Without this check the agent silently
 * hangs until AGENT_TIMEOUT_MS (30 min) — see runAgentLoop's setTimeout
 * — burning a queue slot and producing zero output.
 *
 * Exported so it can be unit-tested in isolation. Called from
 * BaseCodeReviewAgentProvider.execute right after resolveContextWindow.
 */
export function assertContextWindowFitsOverhead(params: {
    input: {
        changedFiles?: FileChange[];
        callGraph?: string;
        prTitle?: string;
        prBody?: string;
        adaptiveProfile?: AdaptiveProfile;
    };
    contextWindow: number;
    modelName: string;
}): void {
    const overheadTokens = estimateNonDiffOverheadTokens(params.input);
    if (overheadTokens >= params.contextWindow) {
        throw new AgentContextWindowTooSmallError({
            contextWindow: params.contextWindow,
            overheadTokens,
            modelName: params.modelName,
        });
    }
}

function estimateDiffTokens(files: FileChange[]): number {
    return files.reduce((sum, f) => {
        const diff = f.patchWithLinesStr ?? f.patch ?? '';
        return sum + Math.ceil(diff.length / CHARS_PER_TOKEN);
    }, 0);
}

/**
 * Total non-diff overhead in tokens: static (system prompt + tool schemas)
 * plus dynamic (callGraph + coverage list + PR context). Reused by both
 * estimatePromptTokens and the per-chunk budget calc so the split decision
 * and chunk sizing can't drift — when they did, a ~2% prompt overflow
 * still produced a chunker that packed every file into one chunk because
 * the chunk budget subtracted only the static part.
 */
function estimateNonDiffOverheadTokens(input: {
    changedFiles?: FileChange[];
    callGraph?: string;
    prTitle?: string;
    prBody?: string;
    adaptiveProfile?: AdaptiveProfile;
}): number {
    // Adaptive fit: when the compact prompt path will fire, the system
    // + user prompt are ~14K chars smaller. Counting the full 62K
    // overhead would cause the preflight to throw before the compact
    // path even has a chance to render — exactly the bug observed on
    // the post-fix 16K benchmark run where every PR preflight-failed
    // despite the strategies being wired correctly.
    const staticOverheadChars = input.adaptiveProfile?.compactPrompt
        ? PROMPT_STATIC_OVERHEAD_CHARS_COMPACT
        : PROMPT_STATIC_OVERHEAD_CHARS;
    // CallGraph: if the profile drops it from the prompt, the estimator
    // must drop it too. Otherwise the preflight blames overhead the
    // user will never actually pay.
    const callGraphChars = input.adaptiveProfile?.dropCallGraph
        ? 0
        : (input.callGraph || '').length;
    const prBodyChars = Math.min((input.prBody || '').length, 500);
    const prContextChars = 300 + (input.prTitle || '').length + prBodyChars;
    const coverageListChars = (input.changedFiles?.length || 0) * 80;
    const totalChars =
        callGraphChars +
        prContextChars +
        coverageListChars +
        staticOverheadChars;
    return Math.ceil(totalChars / CHARS_PER_TOKEN);
}

/**
 * Estimate of the full input token count for the first LLM call:
 * diff content + callGraph + PR context + per-file coverage lines +
 * static overhead (system prompt + tool schemas).
 */
function estimatePromptTokens(input: {
    changedFiles?: FileChange[];
    callGraph?: string;
    prTitle?: string;
    prBody?: string;
    fileTiers?: Map<string, CoverageTier>;
    adaptiveProfile?: AdaptiveProfile;
}): number {
    const tiers = input.fileTiers;
    const diffChars = (input.changedFiles || []).reduce((sum, f) => {
        const diff = f.patchWithLinesStr ?? f.patch ?? '';
        if (tiers) {
            const tier = tiers.get(normalizeFilenameForTier(f.filename));
            if (tier === 'optional') {
                // Optional files are rendered as hunk headers only,
                // so their prompt footprint collapses to the hunk count
                // plus the filename header (~60 chars per hunk + ~120
                // for the file header).
                return sum + estimateHunkHeaderChars(diff);
            }
        }
        return sum + diff.length;
    }, 0);
    const diffTokens = Math.ceil(diffChars / CHARS_PER_TOKEN);
    return diffTokens + estimateNonDiffOverheadTokens(input);
}

function normalizeFilenameForTier(filename?: string): string {
    if (!filename) return '';
    return filename.replace(/^\/+/, '').replace(/\\/g, '/').trim();
}

// Bounded Levenshtein distance — returns early once it exceeds `max`.
// Used to recover a kody_rules ruleUuid the LLM corrupted while echoing
// it (LLMs occasionally drop/transpose a character in a 36-char UUID).
function boundedEditDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const curr = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const v = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost,
            );
            curr.push(v);
            if (v < rowMin) rowMin = v;
        }
        if (rowMin > max) return max + 1; // whole row already over budget
        prev = curr;
    }
    return prev[b.length];
}

// Recover the intended rule when the LLM-emitted `ruleUuid` is not an
// exact key but is within a tiny edit distance of EXACTLY ONE known rule.
// UUIDs don't collide within distance 2, and the per-PR rule set is small,
// so a unique near-match is an unambiguous recovery; ambiguity (0 or >1
// matches) returns null so the caller drops the suggestion. See #1170.
export function recoverRuleUuid(
    emitted: string,
    knownUuids: Iterable<string>,
): string | null {
    const MAX_DISTANCE = 2;
    let match: string | null = null;
    for (const known of knownUuids) {
        if (boundedEditDistance(emitted, known, MAX_DISTANCE) <= MAX_DISTANCE) {
            if (match) return null; // more than one near-match → ambiguous
            match = known;
        }
    }
    return match;
}

function estimateHunkHeaderChars(diff: string): number {
    if (!diff) return 0;
    let hunkCount = 0;
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@ ')) hunkCount++;
    }
    return 120 + hunkCount * 60; // file header + per-hunk line
}

function extractHunkHeaders(diff: string): string[] {
    if (!diff) return [];
    const headers: string[] = [];
    for (const line of diff.split('\n')) {
        if (line.startsWith('@@ ')) headers.push(line);
    }
    return headers;
}

function applyLargePrAggressiveFilter(files: FileChange[]): FileChange[] {
    return files.filter(
        (f) =>
            !isFileMatchingGlob(
                f.filename,
                LARGE_PR_AGGRESSIVE_FILTER_PATTERNS,
            ),
    );
}

function chunkFilesByTokenBudget(
    files: FileChange[],
    budgetTokens: number,
): FileChange[][] {
    if (files.length === 0) {
        return [[]];
    }

    const chunks: FileChange[][] = [];
    let currentChunk: FileChange[] = [];
    let currentTokens = 0;

    for (const file of files) {
        const diff = file.patchWithLinesStr ?? file.patch ?? '';
        const fileTokens = Math.ceil(diff.length / CHARS_PER_TOKEN);

        // If a single file exceeds the budget, give it its own chunk
        if (fileTokens > budgetTokens) {
            if (currentChunk.length > 0) {
                chunks.push(currentChunk);
                currentChunk = [];
                currentTokens = 0;
            }
            chunks.push([file]);
            continue;
        }

        if (
            currentTokens + fileTokens > budgetTokens &&
            currentChunk.length > 0
        ) {
            chunks.push(currentChunk);
            currentChunk = [];
            currentTokens = 0;
        }

        currentChunk.push(file);
        currentTokens += fileTokens;
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

function resolvePromptOverrideText(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }

    if (typeof value === 'string') {
        return convertTiptapJSONToText(value).trim();
    }

    if (typeof value === 'object') {
        if ('value' in value) {
            return resolvePromptOverrideText(
                (value as { value?: unknown }).value,
            );
        }

        return convertTiptapJSONToText(value as Record<string, unknown>).trim();
    }

    return '';
}

/**
 * Category-specific agent configuration provided by each concrete subclass.
 */
export interface ReviewAgentIdentity {
    name: string;
    description: string;
    goal: string;
    expertise: string[];
}

/**
 * Input passed to the agent for a single review execution.
 */
/**
 * Progress event emitted by agents during investigation.
 */
export interface AgentProgressEvent {
    agentName: string;
    agentCategory?: string;
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    status:
        | 'started'
        | 'investigating'
        | 'completed'
        | 'error'
        | 'batch_started'
        | 'batch_completed';
    step?: number;
    toolCalls?: Array<{ tool: string; args: string; durationMs?: number }>;
    findings?: number;
    durationMs?: number;
    totalTokens?: number;
    /** Batch context: present when the PR was chunked into multiple
     *  token-budget batches and the event refers to one of them. */
    batchIndex?: number;
    batchTotal?: number;
    batchFiles?: number;
    /** Error detail surfaced in the PR logs UI when status === 'error'.
     *  Short, single-line (full stack goes in the server logs). */
    errorMessage?: string;
    /** Error class/name when available (e.g. "TypeError", "AbortError",
     *  "HARD-TIMEOUT"). Helps users recognize failure categories. */
    errorName?: string;
    /** How the agent finished — helps surface timeouts and max-steps in the UI */
    finishReason?: 'stop' | 'timeout' | 'max-steps' | 'error';
    /** How findings were obtained — 'json-parse' (normal), 'second-chance', 'generate-object' (fallback LLM), 'empty' */
    source?: string;
    suggestionsPreview?: Array<{
        relevantFile?: string;
        relevantLinesStart?: number;
        relevantLinesEnd?: number;
        oneSentenceSummary?: string;
        label?: string;
        severity?: string;
    }>;
    coverage?: CoverageSummary;
    verification?: VerificationTraceSummary | null;
    anomalies?: AgentAnomalySummary;
}

export interface ReviewAgentInput {
    organizationAndTeamData: OrganizationAndTeamData;
    changedFiles: FileChange[];
    /**
     * Remote commands for the E2B sandbox. When undefined, the agent runs
     * in self-contained mode (no tools, single-shot analysis on the diffs
     * inlined in the user prompt). Used by the CLI trial flow where there
     * is no sandbox available.
     */
    remoteCommands: RemoteCommands | undefined;
    prNumber: number;
    repositoryId?: string;
    repositoryFullName: string;
    languageResultPrompt: string;
    memoryRules?: Partial<IKodyRule>[];
    /** Kody rules passed through so findings tagged with ruleUuid can be cross-referenced. */
    kodyRules?: Partial<IKodyRule>[];
    v2PromptOverrides?: CodeReviewConfig['v2PromptOverrides'];
    generationMain?: string;
    prTitle?: string;
    prBody?: string;
    onAgentProgress?: (event: AgentProgressEvent) => void;
    gitHubToken?: string;
    /** Base branch of the PR (e.g. "main"). Passed to tools for git diff. */
    baseBranch?: string;
    /** Pre-computed call graph for changed functions. Generated once, shared across agents. */
    callGraph?: string;
    /** Structured AST graph JSON (nodes + edges) produced by kodus-graph.
     *  Used by the priority scorer to measure in-PR file centrality when
     *  tiered coverage is active. Safe to omit — the scorer falls back to
     *  a neutral structural weight of 1.0 when missing. */
    callGraphJson?: { nodes: unknown[]; edges: unknown[] };
    /**
     * When the caller has no BYOK config (e.g. the public-demo / trial
     * flow with `organizationId='trial'`), this overrides the hardcoded
     * gemini-3.1-pro default that `byokToVercelModel` falls back to.
     * Used by the trial pipeline to force a cheaper, faster model
     * (`gemini-2.5-flash`) so anonymous reviews don't take 5 minutes.
     */
    defaultModelOverride?: string;
    /** Internal: populated by the large-PR non-deep branch of execute().
     *  Downstream consumers (buildUserPrompt, runAgentLoop) switch the
     *  coverage ledger into tiered mode when this is set. Maps each
     *  changed file to its tier ('critical' | 'warm' | 'optional'). */
    fileTiers?: Map<string, CoverageTier>;
    /** Optional runtime alias used to distinguish replicated agent runs in traces. */
    agentRuntimeName?: string;
    /** Optional replica metadata for replicated agent runs. */
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    /** Batch metadata when the parent executeChunked has split the PR into
     *  token-budget batches. Forwarded so per-step progress events can show
     *  "batch i/N · step k" in the UI. */
    batchIndex?: number;
    batchTotal?: number;
    /** Review mode: 'fast' skips heavy passes (verify, coverage recovery, synthesis rescue) and caps agent steps; 'normal' skips verify only for very-high-confidence findings; 'deep' verifies everything. */
    reviewMode?: 'fast' | 'normal' | 'deep';
    /**
     * Resolved BYOK *main* model override (directory -> repository -> BYOK
     * settings) from `codeReviewConfig.byokModel`. When set, it replaces
     * `byokConfig.main.model` for this run so the agent uses the same model
     * the rest of the pipeline does. Empty/undefined means "inherit".
     */
    byokModel?: string;
    /** Optional per-agent step budget for the main investigation loop. */
    maxSteps?: number;
    /** When true, skip recovery, second-chance, AND synthesis-rescue
     *  passes. Used by very-narrow agents (rule checks in fast mode,
     *  self-contained CLI flow). */
    skipHeavyPasses?: boolean;
    /** When true, run recovery + second-chance but skip ONLY the
     *  synthesis-rescue pass. The rescue pass re-words the same finding
     *  with different language, which is fine for open-ended bug review
     *  but produces duplicate comments for explicit-rule agents like
     *  kody-rules. */
    skipSynthesisRescue?: boolean;
    /**
     * Optional adaptive-fit profile resolved upstream (by the stage) from
     * the same BYOK config and model the agent will use. When present,
     * per-agent code paths read these flags instead of re-resolving the
     * profile locally — guarantees the stage's gating decisions (drop
     * callGraph, skip heavy passes) and the provider's behaviour
     * (compact prompt, all-optional, diff truncation) agree.
     */
    adaptiveProfile?: AdaptiveProfile;
    /** Categories allowed for this run when using a mixed/generalist reviewer. */
    requestedCategories?: Array<'bug' | 'security' | 'performance'>;
    /** Parent (job-level) AbortSignal. Forwarded to runAgentLoop so the
     *  outer router timeout cancels the LLM call instead of leaving it
     *  running ghost in the background. */
    parentSignal?: AbortSignal;
    /** Internal: how many times executeChunked has re-entered execute()
     *  for this review. Bounded to MAX_RECURSION_DEPTH by execute() to
     *  prevent the historical execute() ↔ executeChunked() loop from
     *  exhausting the worker heap. Always undefined at the public entry
     *  point; populated by executeChunked when fanning out per-batch. */
    recursionDepth?: number;
}

/**
 * Output from a single agent execution.
 */
export interface ReviewAgentOutput {
    suggestions: Partial<CodeSuggestion>[];
    discardedBySeverity?: Partial<CodeSuggestion>[];
    discardedByVerify?: Partial<CodeSuggestion>[];
    agentName: string;
    agentCategory?: string;
    agentReplicaIndex?: number;
    agentReplicaTotal?: number;
    turnsUsed: number;
    durationMs: number;
    /** Fidelity warnings emitted by this agent's loop (small context window
     *  forced compact prompt, dropped callGraph, etc). Empty when no
     *  adaptive strategy fired. */
    warnings?: ReviewWarning[];
}

/**
 * Abstract base class for code review agents (Bugs, Security, Performance).
 *
 * Uses Vercel AI SDK with native function calling instead of text-based ReAct.
 * This works with any model (BYOK) because the SDK translates tool definitions
 * to each provider's native format (OpenAI function_call, Anthropic tool_use,
 * Gemini function_calling, OpenRouter, etc.).
 *
 * Subclasses only define:
 * - identity (name, description, goal, expertise)
 * - category-specific system prompt
 * - category label
 */
@Injectable()
export abstract class BaseCodeReviewAgentProvider {
    private readonly agentLogger = createLogger('CodeReviewAgent');

    constructor(
        protected readonly promptRunnerService: PromptRunnerService,
        protected readonly permissionValidationService: PermissionValidationService,
        protected readonly observabilityService: ObservabilityService,
        /** Optional: when injected, enables the `searchDocs` tool on the
         *  agent loop. Falsy when API_EXA_KEY is not configured. */
        @Optional()
        protected readonly documentationSearchService?: DocumentationSearchExaService,
        /** Optional: when injected, wires BYOK LLM failures into the
         *  notification engine so OWNER gets `byok.llm_errors_threshold`
         *  after sustained errors. Falsy in the CLI/eval paths. */
        @Optional()
        protected readonly byokErrorCounter?: ByokErrorCounter,
    ) {}

    protected abstract getIdentity(): ReviewAgentIdentity;
    /**
     * Return the category-specific chunk that gets embedded in the system
     * prompt. Receives `input` so subclasses can include per-request data
     * (e.g. the kody-rules agent renders the current team rules) without
     * stashing it on instance state — keeping the provider safe to share
     * across concurrent reviews.
     */
    protected abstract getCategoryPrompt(input: ReviewAgentInput): string;
    protected abstract getCategoryLabel(): string;

    protected supportsMixedLabels(): boolean {
        return false;
    }

    protected getAllowedSuggestionLabels(
        _input: ReviewAgentInput,
    ): Array<'bug' | 'security' | 'performance'> {
        const category = this.getCategoryLabel();
        if (
            category === 'bug' ||
            category === 'security' ||
            category === 'performance'
        ) {
            return [category];
        }

        return ['bug'];
    }

    /**
     * Execute the agent against the provided changed files.
     */
    async execute(input: ReviewAgentInput): Promise<ReviewAgentOutput> {
        const startTime = Date.now();
        const baseIdentity = this.getIdentity();
        const identity: ReviewAgentIdentity = {
            ...baseIdentity,
            name: input.agentRuntimeName || baseIdentity.name,
        };
        const agentCategory = this.getCategoryLabel();

        const recursionDepth = input.recursionDepth ?? 0;
        if (recursionDepth >= MAX_RECURSION_DEPTH) {
            this.agentLogger.error({
                message: `[AGENT] ${identity.name} recursion limit reached (depth=${recursionDepth}); aborting to protect the worker heap`,
                context: identity.name,
                metadata: {
                    prNumber: input.prNumber,
                    recursionDepth,
                    maxRecursionDepth: MAX_RECURSION_DEPTH,
                    filesCount: input.changedFiles.length,
                },
            });
            throw new Error('AGENT_RECURSION_LIMIT_EXCEEDED');
        }

        // When this execute() call is one batch of a chunked review
        // (executeChunked has split a large PR by token budget), enrich
        // every progress event emitted from inside this call with batch
        // info so the UI can render "batch i/N · step k" labels without
        // each emit site having to know about chunking.
        if (
            input.batchIndex &&
            input.batchTotal &&
            input.batchTotal > 1 &&
            input.onAgentProgress
        ) {
            const inner = input.onAgentProgress;
            const enrichedInput = {
                ...input,
                onAgentProgress: (event: AgentProgressEvent) =>
                    inner({
                        ...event,
                        batchIndex: event.batchIndex ?? input.batchIndex,
                        batchTotal: event.batchTotal ?? input.batchTotal,
                    }),
            };
            input = enrichedInput;
        }

        this.agentLogger.log({
            message: `[AGENT] Starting ${identity.name} for PR#${input.prNumber}`,
            context: identity.name,
            metadata: {
                organizationId: input.organizationAndTeamData?.organizationId,
                teamId: input.organizationAndTeamData?.teamId,
                prNumber: input.prNumber,
                filesCount: input.changedFiles.length,
            },
        });

        // Resolve BYOK config - Scoped locally to prevent race conditions across parallel PR reviews
        let byokConfig = await this.permissionValidationService.getBYOKConfig(
            input.organizationAndTeamData,
        );

        // Honor the per-repository/directory model override resolved by the
        // pipeline (codeReviewConfig.byokModel). getBYOKConfig() returns the
        // raw org-level config, so without this the agent would always run on
        // the BYOK-settings main model and ignore the override.
        const overrideModel = input.byokModel?.trim();
        if (overrideModel && byokConfig?.main) {
            byokConfig = {
                ...byokConfig,
                main: { ...byokConfig.main, model: overrideModel },
            };
        }

        // Create Vercel AI SDK model from BYOK config. The
        // defaultModelOverride kicks in only when byokConfig is null and the
        // caller (e.g. the trial pipeline) asked for a specific default —
        // production BYOK flows are untouched.
        const model = byokToVercelModel(
            byokConfig,
            'main',
            {},
            input.defaultModelOverride,
        );
        const modelName = getModelName(byokConfig, input.defaultModelOverride);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} using model: ${modelName}`,
            context: identity.name,
        });

        // Check if the estimated prompt exceeds the context window budget
        // and needs chunking. The measurement accounts for diff + callGraph
        // + PR context + coverage list + static overhead (system prompt +
        // tool schemas) — not just the diff.
        const contextWindow = resolveContextWindow({
            byokMaxInputTokens: byokConfig?.main?.maxInputTokens,
            modelName,
        });
        // Resolve adaptive-fit profile from the same context window the
        // preflight will check against. Prefer the stage-supplied profile
        // when present (it's authoritative — the stage owns callGraph and
        // skipHeavyPasses decisions and we need to agree). Falling back
        // to local resolution covers callers (CLI trial, ad-hoc tests)
        // that didn't go through the stage.
        const adaptiveProfile =
            input.adaptiveProfile ?? resolveAdaptiveProfile(contextWindow);
        // Ensure downstream estimators (estimateNonDiffOverheadTokens,
        // estimatePromptTokens, the prompt builders) all see the same
        // profile — without this the preflight would be computing the
        // FULL overhead even when the compact path will fire, throwing
        // before the strategies could rescue the run (the exact failure
        // mode caught by the first post-fix benchmark).
        if (!input.adaptiveProfile) {
            input = { ...input, adaptiveProfile };
        }
        // Track which adaptive strategies fired so they bubble up to the
        // orchestrator as ReviewWarning entries → end-review PR comment.
        const agentWarnings: ReviewWarning[] = [];
        const emitWarning = (
            kind: ReviewWarning['kind'],
            detail?: string,
        ) => {
            agentWarnings.push({
                kind,
                reason: 'small_context_window',
                contextWindowTokens: contextWindow,
                modelName,
                detail,
                agentName: identity.name,
            });
        };
        // Fail fast when the configured model's context window cannot
        // even hold the agent's static overhead. Without this, the loop
        // would run to AGENT_TIMEOUT_MS (30 min) while the LLM 400s on
        // every retry — see runAgentLoop. Surfaces as CONTEXT_OVERFLOW
        // via classifyLLMError → friendlyMessage on lastReviewError.
        assertContextWindowFitsOverhead({
            input,
            contextWindow,
            modelName,
        });
        if (adaptiveProfile.compactPrompt) {
            emitWarning('PROMPT_COMPACTED');
        }
        const promptBudget = Math.floor(contextWindow * PROMPT_BUDGET_RATIO);
        // Adaptive fit: when the profile says so, truncate per-file
        // diffs before estimating tokens. Each truncated file gets a
        // marker so the agent knows context is missing. Skipped when
        // the file already fits under the cap (no behavior change).
        if (adaptiveProfile.maxDiffChars && input.changedFiles?.length) {
            const cap = adaptiveProfile.maxDiffChars;
            const truncatedNames: string[] = [];
            const truncatedFiles = input.changedFiles.map((f) => {
                const diff = f.patchWithLinesStr ?? f.patch ?? '';
                if (diff.length <= cap) return f;
                truncatedNames.push(f.filename ?? 'unknown');
                const head = diff.slice(0, cap);
                const marker = `\n... (diff truncated to ${cap} chars by adaptive-fit; readFile for the rest)`;
                return f.patchWithLinesStr
                    ? { ...f, patchWithLinesStr: head + marker }
                    : { ...f, patch: head + marker };
            });
            if (truncatedNames.length > 0) {
                input = { ...input, changedFiles: truncatedFiles };
                this.agentLogger.log({
                    message: `[AGENT] ${identity.name} adaptive-fit: truncated ${truncatedNames.length} long diffs to ${cap} chars`,
                    context: identity.name,
                    metadata: {
                        truncatedFiles: truncatedNames,
                        maxDiffChars: cap,
                    },
                });
                emitWarning(
                    'DIFF_TRUNCATED',
                    `${truncatedNames.length} files truncated to ${cap} chars`,
                );
            }
        }
        let estimatedPromptTokens = estimatePromptTokens(input);

        // Large-PR aggressive filter + priority tiering: when the estimated
        // prompt already exceeds the single-batch budget AND we're not in
        // deep mode, drop low-signal files (tests, docs, styles), then
        // score the remaining set and mark the critical tier. Tiering lets
        // coverage relax from "inspect every file" to "inspect criticals
        // + 70% total", which is what actually keeps the main loop from
        // burning steps on UI leaves in a huge PR.
        //
        // Adaptive fit (`compact+`): drop the `reviewMode !== 'deep'`
        // gate AND the prompt-overflow gate so the low-signal filter
        // always fires on small windows. Deep-mode small-window reviews
        // are still better than no review at all.
        let fileTiers: Map<string, CoverageTier> | undefined;
        const shouldFireFilter =
            input.changedFiles.length > 1 &&
            (adaptiveProfile.lowSignalFilterUnconditional ||
                (estimatedPromptTokens > promptBudget &&
                    input.reviewMode !== 'deep'));
        if (shouldFireFilter) {
            const filesBefore = input.changedFiles.length;
            const filteredFiles = applyLargePrAggressiveFilter(
                input.changedFiles,
            );
            if (filteredFiles.length < filesBefore) {
                input = { ...input, changedFiles: filteredFiles };
                const filteredTokens = estimatePromptTokens(input);
                this.agentLogger.log({
                    message: `[AGENT] ${identity.name} large-PR aggressive filter dropped ${filesBefore - filteredFiles.length} low-signal files (tests/md/css): ${estimatedPromptTokens} → ${filteredTokens} prompt tokens`,
                    context: identity.name,
                    metadata: {
                        filesBefore,
                        filesAfter: filteredFiles.length,
                        tokensBefore: estimatedPromptTokens,
                        tokensAfter: filteredTokens,
                        reviewMode: input.reviewMode,
                    },
                });
                if (adaptiveProfile.lowSignalFilterUnconditional) {
                    emitWarning(
                        'LOW_SIGNAL_FILES_DROPPED',
                        `${filesBefore - filteredFiles.length} files dropped (tests/md/css)`,
                    );
                }
            }

            const scores = computeFileScores(
                input.changedFiles,
                input.callGraphJson,
            );
            fileTiers = assignFileTiers(scores);
            // Adaptive fit (`minimal`): force every file to `optional`
            // so the user prompt renders hunk-headers only (cutting
            // ~80–90% of diff chars). The agent must readFile each hunk
            // it cares about — slower per-finding but the only way to
            // squeeze a multi-file PR into an 8K–16K window.
            if (adaptiveProfile.allOptional) {
                for (const filename of fileTiers.keys()) {
                    fileTiers.set(filename, 'optional');
                }
                emitWarning('HUNK_HEADERS_ONLY');
            }
            let criticalCount = 0;
            let warmCount = 0;
            let optionalCount = 0;
            for (const tier of fileTiers.values()) {
                if (tier === 'critical') criticalCount++;
                else if (tier === 'warm') warmCount++;
                else optionalCount++;
            }
            const hasCallGraph = !!input.callGraphJson?.edges?.length;
            this.agentLogger.log({
                message: `[AGENT] ${identity.name} large-PR priority tiering: critical=${criticalCount} warm=${warmCount} optional=${optionalCount} / ${input.changedFiles.length} (callGraph=${hasCallGraph ? 'yes' : 'fallback'})`,
                context: identity.name,
                metadata: {
                    totalFiles: input.changedFiles.length,
                    criticalCount,
                    warmCount,
                    optionalCount,
                    usedCallGraph: hasCallGraph,
                    reviewMode: input.reviewMode,
                },
            });
            // Stash so buildUserPrompt and formatDiffs can render tiered
            // output without recomputing scores.
            input = { ...input, fileTiers };
            // Re-estimate prompt tokens now that optional files will be
            // rendered as hunk headers only — this often brings a large
            // PR back under the single-batch budget.
            estimatedPromptTokens = estimatePromptTokens(input);
        }

        if (
            estimatedPromptTokens > promptBudget &&
            input.changedFiles.length > 1
        ) {
            // Per-chunk diff budget: prompt budget minus the FULL non-diff
            // overhead every chunk pays again (static system prompt + tool
            // schemas, callGraph, coverage list, PR context). Previously we
            // only subtracted the static piece, so chunkDiffBudget was too
            // generous: a PR whose diffs alone fit in the budget but whose
            // total prompt overflowed by ~2% produced 1 chunk containing
            // every file, tripping the recursion guard and killing the
            // review. Aligning this with estimatePromptTokens (which uses
            // the same helper for the split decision) keeps the two ends
            // from drifting.
            const overheadTokens = estimateNonDiffOverheadTokens(input);
            const chunkDiffBudget = Math.max(
                promptBudget - overheadTokens,
                Math.floor(contextWindow * 0.3),
            );
            // Pre-check the chunker BEFORE recursing: if it would
            // produce a single chunk containing every file (small files
            // packing comfortably), splitting won't help — the prompt
            // overflow is from the overhead, not the diffs. Falling
            // through to runAgentLoop on the same stack frame lets the
            // agent loop's mid-stream compressor handle marginal
            // overflow, and the assertPromptFitsInContext preflight
            // catches the genuine "won't fit at all" case. Without this
            // check, executeChunked would recurse → execute() at depth 1
            // → same chunking decision → infinite recursion bounded by
            // MAX_RECURSION_DEPTH = an opaque user-facing failure.
            const previewChunks = chunkFilesByTokenBudget(
                input.changedFiles,
                chunkDiffBudget,
            );
            if (
                previewChunks.length === 1 &&
                previewChunks[0].length === input.changedFiles.length
            ) {
                this.agentLogger.log({
                    message: `[AGENT] ${identity.name} chunker would return 1 chunk for ${input.changedFiles.length} files; running single batch directly (overhead, not diff size, is the constraint)`,
                    context: identity.name,
                    metadata: {
                        prNumber: input.prNumber,
                        filesCount: input.changedFiles.length,
                        overheadTokens,
                        chunkDiffBudget,
                        estimatedPromptTokens,
                        promptBudget,
                    },
                });
                // Fall through to the single-batch runAgentLoop path
                // below by NOT entering executeChunked. The variables
                // (estimatedPromptTokens, fileTiers, etc) are already
                // set and runAgentLoop's own preflight + compressor
                // will handle the rest.
            } else {
            this.agentLogger.warn({
                message: `[AGENT] ${identity.name} prompt exceeds context budget (${estimatedPromptTokens} tokens > ${promptBudget} budget), splitting into batches`,
                context: identity.name,
                metadata: {
                    estimatedPromptTokens,
                    promptBudget,
                    chunkDiffBudget,
                    contextWindow,
                    filesCount: input.changedFiles.length,
                },
            });

            return this.executeChunked(input, {
                identity,
                agentCategory,
                byokConfig,
                model,
                modelName,
                startTime,
                diffBudget: chunkDiffBudget,
                // Parent-level warnings emitted before the chunk split
                // (PROMPT_COMPACTED, DIFF_TRUNCATED, LOW_SIGNAL_FILES_DROPPED,
                // HUNK_HEADERS_ONLY) — forward so they're preserved in the
                // final aggregate. Each per-batch execute() resolves the
                // profile again and may emit additional dedup-able copies;
                // dedupReviewWarnings in the orchestrator folds them.
                parentWarnings: agentWarnings,
            });
            } // end else (multi-chunk path)
        }

        const systemPrompt = this.buildSystemPrompt(input);
        const userPrompt = this.buildUserPrompt(input);

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} prompt context: memoryRules=${input.memoryRules?.length ?? 0}, overrides=${!!input.v2PromptOverrides}, language=${input.languageResultPrompt || 'default'}`,
            context: identity.name,
        });

        // Emit progress: agent started
        input.onAgentProgress?.({
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            status: 'started',
        });

        try {
            // Accumulate tool calls for batch progress updates
            const recentToolCalls: AgentProgressEvent['toolCalls'] = [];
            let stepCount = 0;
            const PROGRESS_BATCH_SIZE = 5;

            // Secrets are passed via closure (not as tracing arg) so that
            // Langfuse span I/O never serialises API keys, tokens, or
            // NestJS service instances (which carry ConfigService with all env vars).
            const byokErrorCounter = this.byokErrorCounter;
            const loopSecrets: AgentLoopSecrets = {
                remoteCommands: input.remoteCommands,
                byokConfig,
                gitHubToken: input.gitHubToken,
                documentationSearchService: this.documentationSearchService,
                documentationSearchOptions: {
                    organizationAndTeamData: input.organizationAndTeamData,
                    prNumber: input.prNumber,
                    byokConfig,
                },
                byokErrorReporter: byokErrorCounter
                    ? (entry) => {
                          // Fire-and-forget; ByokErrorCounter.record never
                          // throws, but we still drop the promise so the
                          // LLM call path returns immediately.
                          void byokErrorCounter.record(entry);
                      }
                    : undefined,
            };

            const loopParams = {
                model,
                systemPrompt,
                userPrompt,
                agentName: identity.name,
                telemetryMetadata: {
                    organizationId:
                        input.organizationAndTeamData?.organizationId,
                    teamId: input.organizationAndTeamData?.teamId,
                    pullRequestId: input.prNumber,
                    repositoryId: input.repositoryId,
                    provider: modelName,
                },
                changedFiles: input.changedFiles,
                prNumber: input.prNumber,
                repositoryFullName: input.repositoryFullName,
                baseBranch: input.baseBranch,
                callGraph: input.callGraph,
                fileTiers,
                reviewMode: input.reviewMode,
                maxSteps: input.maxSteps,
                // Heavy-pass gating: forwarded explicitly because loopParams
                // is built field-by-field. Without this line, callers like
                // KodyRulesAgentProvider that opt out of synthesis-rescue
                // would have their preference silently dropped here.
                skipHeavyPasses: input.skipHeavyPasses,
                skipSynthesisRescue: input.skipSynthesisRescue,
                contextWindowTokens: contextWindow,
                reasoningEffort: byokConfig?.main?.reasoningEffort,
                reasoningConfigOverride:
                    byokConfig?.main?.reasoningConfigOverride,
                byokProvider: byokConfig?.main?.provider,
                openrouterProviderOrder: (byokConfig?.main as any)
                    ?.openrouterProviderOrder,
                openrouterAllowFallbacks: (byokConfig?.main as any)
                    ?.openrouterAllowFallbacks,
                parentSignal: input.parentSignal,

                onStepFinish: (step: any) => {
                    stepCount++;
                    if (step.toolCalls) {
                        for (const tc of step.toolCalls) {
                            this.agentLogger.log({
                                message: `[AGENT-TOOL] PR#${input.prNumber} ${identity.name} tool=${tc.toolName}`,
                                context: identity.name,
                            });
                            recentToolCalls.push({
                                tool: tc.toolName,
                                args: JSON.stringify(
                                    tc.args || tc.input || {},
                                ).substring(0, 100),
                            });
                        }
                    }
                    // Batch progress update every N steps
                    if (
                        stepCount % PROGRESS_BATCH_SIZE === 0 &&
                        recentToolCalls.length > 0
                    ) {
                        input.onAgentProgress?.({
                            agentName: identity.name,
                            agentCategory,
                            agentReplicaIndex: input.agentReplicaIndex,
                            agentReplicaTotal: input.agentReplicaTotal,
                            status: 'investigating',
                            step: stepCount,
                            toolCalls: [...recentToolCalls],
                        });
                        recentToolCalls.length = 0; // Clear after sending
                    }
                },
            };

            let agentResult;
            if (shouldTrace()) {
                const traceMetadata: Record<string, string> = {};
                const orgId = input.organizationAndTeamData?.organizationId;
                const teamId = input.organizationAndTeamData?.teamId;
                if (orgId) traceMetadata.organizationId = orgId;
                if (teamId) traceMetadata.teamId = teamId;
                if (input.prNumber !== undefined) {
                    traceMetadata.prNumber = String(input.prNumber);
                    traceMetadata.pullRequestId = String(input.prNumber);
                }
                if (input.repositoryId)
                    traceMetadata.repositoryId = input.repositoryId;
                agentResult = await propagateAttributes(
                    {
                        traceName: identity.name,
                        sessionId: input.prNumber
                            ? `${orgId ?? 'org'}:${input.repositoryId ?? 'repo'}:${input.prNumber}`
                            : undefined,
                        userId: orgId,
                        metadata: traceMetadata,
                    },
                    () =>
                        startActiveObservation(
                            identity.name,
                            async (span: any) => {
                                // Strip redundant `patch` from changedFiles —
                                // `patchWithLinesStr` already carries the same content
                                // with line numbers added.
                                const { changedFiles, ...restParams } =
                                    loopParams as any;
                                const safeInput = {
                                    ...restParams,
                                    ...(changedFiles && {
                                        changedFiles: changedFiles.map(
                                            ({
                                                patch: _patch,
                                                ...rest
                                            }: Record<string, any>) => rest,
                                        ),
                                    }),
                                };
                                span.update({ input: safeInput });
                                const result = await runAgentLoop(
                                    loopParams,
                                    loopSecrets,
                                );
                                span.update({ output: result });
                                return result;
                            },
                        ),
                );
            } else {
                agentResult = await runAgentLoop(loopParams, loopSecrets);
            }

            const durationMs = Date.now() - startTime;

            // Record token usage to observability (MongoDB spans)
            // Uses runInSpan to ensure proper span lifecycle and MongoDB persistence
            try {
                const vUsage = agentResult.verificationUsage;
                const mainInputTokens =
                    agentResult.usage.inputTokens - (vUsage?.inputTokens ?? 0);
                const mainOutputTokens =
                    agentResult.usage.outputTokens -
                    (vUsage?.outputTokens ?? 0);
                const vCacheRead = (vUsage as any)?.cacheReadTokens ?? 0;
                const vCacheWrite = (vUsage as any)?.cacheWriteTokens ?? 0;
                const mainCacheRead =
                    ((agentResult.usage as any).cacheReadTokens ?? 0) -
                    vCacheRead;
                const mainCacheWrite =
                    ((agentResult.usage as any).cacheWriteTokens ?? 0) -
                    vCacheWrite;

                await this.observabilityService.runInSpan(
                    `${identity.name}::review`,
                    async () => agentResult,
                    {
                        'gen_ai.usage.input_tokens': mainInputTokens,
                        'gen_ai.usage.output_tokens': mainOutputTokens,
                        'gen_ai.usage.total_tokens':
                            mainInputTokens + mainOutputTokens,
                        ...(mainCacheRead > 0 && {
                            'gen_ai.usage.cache_read_input_tokens':
                                mainCacheRead,
                        }),
                        ...(mainCacheWrite > 0 && {
                            'gen_ai.usage.cache_creation_input_tokens':
                                mainCacheWrite,
                        }),
                        ...(agentResult.usage.reasoningTokens > 0 && {
                            'gen_ai.usage.reasoning_tokens':
                                agentResult.usage.reasoningTokens -
                                (vUsage?.reasoningTokens ?? 0),
                        }),
                        'gen_ai.response.model': modelName,
                        'gen_ai.run.name': `code-review-${this.getCategoryLabel()}`,
                        'type': byokConfig ? 'byok' : 'system',
                        'organizationId':
                            input.organizationAndTeamData?.organizationId,
                        'teamId': input.organizationAndTeamData?.teamId,
                        'prNumber': input.prNumber,
                        'steps': agentResult.steps,
                        'toolCalls': agentResult.toolCalls.length,
                        'finishReason': agentResult.finishReason,
                        'source': agentResult.source,
                        durationMs,
                    },
                );

                // Separate span for verification tokens
                if (
                    vUsage &&
                    (vUsage.inputTokens > 0 || vUsage.outputTokens > 0)
                ) {
                    await this.observabilityService.runInSpan(
                        `${identity.name}::verify`,
                        async () => agentResult,
                        {
                            'gen_ai.usage.input_tokens': vUsage.inputTokens,
                            'gen_ai.usage.output_tokens': vUsage.outputTokens,
                            'gen_ai.usage.total_tokens':
                                vUsage.inputTokens + vUsage.outputTokens,
                            ...((vUsage as any).cacheReadTokens > 0 && {
                                'gen_ai.usage.cache_read_input_tokens': (
                                    vUsage as any
                                ).cacheReadTokens,
                            }),
                            ...((vUsage as any).cacheWriteTokens > 0 && {
                                'gen_ai.usage.cache_creation_input_tokens': (
                                    vUsage as any
                                ).cacheWriteTokens,
                            }),
                            ...(vUsage.reasoningTokens > 0 && {
                                'gen_ai.usage.reasoning_tokens':
                                    vUsage.reasoningTokens,
                            }),
                            'gen_ai.response.model': modelName,
                            'gen_ai.run.name': `code-review-${this.getCategoryLabel()}-verify`,
                            'type': byokConfig ? 'byok' : 'system',
                            'organizationId':
                                input.organizationAndTeamData?.organizationId,
                            'teamId': input.organizationAndTeamData?.teamId,
                            'prNumber': input.prNumber,
                        },
                    );
                }
            } catch {
                // Observability is best-effort
            }

            // Map findings to CodeSuggestion format.
            // The map keys on the normalized path so we tolerate LLM-emitted
            // variations (missing leading slash, backslashes), but the value
            // preserves the provider's original filename so downstream calls
            // (e.g. Azure threadContext.filePath) get the exact path the
            // provider gave us.
            const validFilesByNormalized = new Map<string, string>(
                input.changedFiles.map((f) => [
                    normalizeRepoPath(f.filename),
                    f.filename,
                ]),
            );
            const isKodyRules = this.getCategoryLabel() === 'kody_rules';
            const kodyRulesByUuid = new Map(
                (input.kodyRules || [])
                    .filter((r) => r.uuid)
                    .map((r) => [r.uuid!, r]),
            );

            const rawSuggestions = (
                agentResult.findings?.suggestions || []
            ).filter((s) => {
                if (!s.suggestionContent) return false;

                if (isKodyRules) {
                    // Kody Rules suggestions MUST carry a ruleUuid that maps
                    // to one of the rules we actually sent to the agent. The
                    // prompt enforces this, but we guard here too: without a
                    // valid ruleUuid we cannot render the rule link and the
                    // finding would be mis-attributed to kody_rules while
                    // being something else (e.g. a hallucinated generic
                    // finding the kody-rules agent should not be reporting).
                    const ruleUuid =
                        typeof s.ruleUuid === 'string' ? s.ruleUuid.trim() : '';
                    if (!ruleUuid) {
                        this.agentLogger.warn({
                            message: `[AGENT] Dropping kody_rules suggestion without ruleUuid: "${(s.oneSentenceSummary || s.suggestionContent).slice(0, 140)}"`,
                            context: this.getIdentity().name,
                            metadata: { prNumber: input.prNumber },
                        });
                        return false;
                    }
                    let resolvedRuleUuid = ruleUuid;
                    if (!kodyRulesByUuid.has(resolvedRuleUuid)) {
                        // LLMs occasionally corrupt a character when echoing
                        // the 36-char UUID (observed: a dropped digit), which
                        // would discard an otherwise-correct finding. Recover
                        // only when it maps unambiguously to one known rule.
                        const recovered = recoverRuleUuid(
                            resolvedRuleUuid,
                            kodyRulesByUuid.keys(),
                        );
                        if (recovered) {
                            this.agentLogger.warn({
                                message: `[AGENT] Recovered corrupted kody_rules ruleUuid=${resolvedRuleUuid} → ${recovered} (LLM UUID echo drift)`,
                                context: this.getIdentity().name,
                                metadata: { prNumber: input.prNumber },
                            });
                            // Normalize so downstream rule-link rendering uses
                            // the real UUID.
                            resolvedRuleUuid = recovered;
                            s.ruleUuid = recovered;
                        } else {
                            this.agentLogger.warn({
                                message: `[AGENT] Dropping kody_rules suggestion with unknown ruleUuid=${resolvedRuleUuid}: "${(s.oneSentenceSummary || s.suggestionContent).slice(0, 140)}"`,
                                context: this.getIdentity().name,
                                metadata: {
                                    prNumber: input.prNumber,
                                    ruleUuid: resolvedRuleUuid,
                                    knownRuleCount: kodyRulesByUuid.size,
                                },
                            });
                            return false;
                        }
                    }
                    // PR-level kody_rules omit relevantFile by design.
                    const kodyRulePathMatch =
                        !s.relevantFile ||
                        validFilesByNormalized.has(
                            normalizeRepoPath(s.relevantFile),
                        );
                    if (!kodyRulePathMatch) {
                        this.agentLogger.warn({
                            message: `@@PATH_MISMATCH@@ Dropping kody_rules suggestion — relevantFile not in changedFiles after normalization`,
                            context: this.getIdentity().name,
                            metadata: {
                                prNumber: input.prNumber,
                                relevantFile: s.relevantFile,
                                normalizedRelevantFile: normalizeRepoPath(
                                    s.relevantFile,
                                ),
                                changedFiles: [
                                    ...validFilesByNormalized.values(),
                                ],
                                suggestionPreview: (
                                    s.oneSentenceSummary ||
                                    s.suggestionContent ||
                                    ''
                                ).slice(0, 140),
                            },
                        });
                    }
                    return kodyRulePathMatch;
                }

                const pathMatch =
                    !!s.relevantFile &&
                    validFilesByNormalized.has(
                        normalizeRepoPath(s.relevantFile),
                    );
                if (!pathMatch && s.relevantFile) {
                    this.agentLogger.warn({
                        message: `@@PATH_MISMATCH@@ Dropping suggestion — relevantFile not in changedFiles after normalization`,
                        context: this.getIdentity().name,
                        metadata: {
                            prNumber: input.prNumber,
                            relevantFile: s.relevantFile,
                            normalizedRelevantFile: normalizeRepoPath(
                                s.relevantFile,
                            ),
                            changedFiles: [...validFilesByNormalized.values()],
                            severity: s.severity,
                            suggestionPreview: (
                                s.oneSentenceSummary ||
                                s.suggestionContent ||
                                ''
                            ).slice(0, 140),
                        },
                    });
                }
                return pathMatch;
            });

            const suggestions = rawSuggestions.map((s) => {
                const matchedRule = s.ruleUuid
                    ? kodyRulesByUuid.get(s.ruleUuid)
                    : undefined;

                // Replace the LLM-emitted relevantFile with the provider's
                // original filename so downstream comment posting uses the
                // exact path shape the provider expects (e.g. Azure requires
                // the leading slash it returns from its API).
                const canonicalRelevantFile = s.relevantFile
                    ? (validFilesByNormalized.get(
                          normalizeRepoPath(s.relevantFile),
                      ) ?? s.relevantFile)
                    : s.relevantFile;

                return {
                    relevantFile: canonicalRelevantFile,
                    language: s.language || '',
                    suggestionContent: s.suggestionContent,
                    existingCode: s.existingCode || '',
                    improvedCode: s.improvedCode || '',
                    oneSentenceSummary: s.oneSentenceSummary || '',
                    relevantLinesStart: s.relevantLinesStart,
                    relevantLinesEnd: s.relevantLinesEnd,
                    label: this.resolveSuggestionLabel(
                        s as Partial<CodeSuggestion> & { label?: string },
                        input,
                    ),
                    severity: matchedRule
                        ? resolveKodyRuleSeverityLevel(matchedRule)
                        : s.severity || 'medium',
                    llmPrompt: s.suggestionContent,
                    ...(s.ruleUuid && { brokenKodyRulesIds: [s.ruleUuid] }),
                };
            });

            // Emit progress: agent completed
            // Only mark as error if the agent hit a hard limit (timeout or MAX_STEPS with tool-calls finish).
            // source=empty with finishReason=stop is legitimate (agent investigated and found nothing).
            const hitHardLimit =
                agentResult.finishReason === 'timeout' ||
                (agentResult.source === 'empty' &&
                    agentResult.finishReason === 'tool-calls');

            input.onAgentProgress?.({
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                status: hitHardLimit ? 'error' : 'completed',
                findings: suggestions.length,
                durationMs,
                totalTokens: agentResult.usage.totalTokens,
                step: agentResult.steps,
                finishReason:
                    agentResult.finishReason === 'timeout'
                        ? 'timeout'
                        : hitHardLimit
                          ? 'max-steps'
                          : 'stop',
                source: agentResult.source,
                coverage: agentResult.coverage,
                verification: agentResult.verification,
                anomalies: agentResult.anomalies,
                suggestionsPreview: suggestions.slice(0, 10).map((s) => ({
                    relevantFile: s.relevantFile,
                    relevantLinesStart: s.relevantLinesStart,
                    relevantLinesEnd: s.relevantLinesEnd,
                    oneSentenceSummary: s.oneSentenceSummary,
                    label: s.label,
                    severity: s.severity,
                })),
                toolCalls: agentResult.toolCalls.map((tc) => ({
                    tool: tc.toolName || tc.tool,
                    args: JSON.stringify(tc.args).substring(0, 100),
                })),
            });

            const cacheReadTokens =
                (agentResult.usage as any).cacheReadTokens ?? 0;
            const cacheWriteTokens =
                (agentResult.usage as any).cacheWriteTokens ?? 0;
            const cacheHitRate =
                agentResult.usage.inputTokens > 0
                    ? Math.round(
                          (cacheReadTokens / agentResult.usage.inputTokens) *
                              100,
                      )
                    : 0;
            this.agentLogger.log({
                message: `[AGENT] ${identity.name} completed for PR#${input.prNumber}: ${suggestions.length} suggestions in ${durationMs}ms (source=${agentResult.source}, steps=${agentResult.steps}, tools=${agentResult.toolCalls.length}, input=${agentResult.usage.inputTokens} [cacheRead=${cacheReadTokens}, hit=${cacheHitRate}%], output=${agentResult.usage.outputTokens}, total=${agentResult.usage.totalTokens})`,
                context: identity.name,
                metadata: {
                    organizationId:
                        input.organizationAndTeamData?.organizationId,
                    prNumber: input.prNumber,
                    suggestionsCount: suggestions.length,
                    durationMs,
                    source: agentResult.source,
                    steps: agentResult.steps,
                    toolCalls: agentResult.toolCalls.length,
                    inputTokens: agentResult.usage.inputTokens,
                    cacheReadTokens,
                    cacheWriteTokens,
                    cacheHitRate,
                    outputTokens: agentResult.usage.outputTokens,
                    totalTokens: agentResult.usage.totalTokens,
                    finishReason: agentResult.finishReason,
                    model: modelName,
                    coverage: agentResult.coverage,
                    verification: agentResult.verification,
                    anomalies: agentResult.anomalies,
                },
            });

            return {
                suggestions,
                discardedBySeverity: (
                    agentResult.discardedBySeverity || []
                ).map((s) => ({
                    relevantFile: s.relevantFile,
                    suggestionContent: s.suggestionContent,
                    severity: s.severity || 'medium',
                    label: this.resolveSuggestionLabel(
                        s as Partial<CodeSuggestion> & { label?: string },
                        input,
                    ),
                    oneSentenceSummary: s.oneSentenceSummary || '',
                })),
                discardedByVerify: (agentResult.droppedByVerify || []).map(
                    (s) => ({
                        relevantFile: s.relevantFile,
                        suggestionContent: s.suggestionContent,
                        severity: s.severity || 'medium',
                        label: this.resolveSuggestionLabel(
                            s as Partial<CodeSuggestion> & { label?: string },
                            input,
                        ),
                        oneSentenceSummary: s.oneSentenceSummary || '',
                    }),
                ),
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                turnsUsed: agentResult.steps,
                durationMs,
                // Merge agent-loop-emitted warnings (currently none — the
                // loop's warnings: [] is the PR1 placeholder) with the
                // strategy warnings emitted in this provider above.
                warnings: [
                    ...agentWarnings,
                    ...(agentResult.warnings ?? []),
                ],
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            const errMsg =
                error instanceof Error ? error.message : String(error);
            const errName = error instanceof Error ? error.name : undefined;
            input.onAgentProgress?.({
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                status: 'error',
                durationMs,
                errorMessage: errMsg.substring(0, 500),
                errorName: errName,
            });
            this.agentLogger.error({
                message: `[AGENT] ${identity.name} failed for PR#${input.prNumber} after ${durationMs}ms: ${errMsg}`,
                context: identity.name,
                error,
                metadata: {
                    prNumber: input.prNumber,
                    durationMs,
                    model: modelName,
                    errorName: errName,
                    errorStack:
                        error instanceof Error
                            ? error.stack?.substring(0, 500)
                            : undefined,
                },
            });
            // Re-throw so the orchestrator's Promise.allSettled captures this
            // as a rejected agent and accounts for it in `failures[]`. Before
            // this, we returned `{ suggestions: [], turnsUsed: 0 }` which the
            // orchestrator treated as a fulfilled-with-no-findings result,
            // silently masking real crashes as legitimate "0 suggestions".
            throw error;
        }
    }

    /**
     * Runs the agent in multiple batches when the total diff size exceeds
     * the model's context window budget. Each batch gets a subset of files
     * with their full diffs, plus a summary of the other files in the PR.
     */
    private async executeChunked(
        input: ReviewAgentInput,
        ctx: {
            identity: ReviewAgentIdentity;
            agentCategory: string;
            byokConfig: any;
            model: any;
            modelName: string;
            startTime: number;
            diffBudget: number;
            parentWarnings?: ReviewWarning[];
        },
    ): Promise<ReviewAgentOutput> {
        const {
            identity,
            agentCategory,
            byokConfig,
            model,
            modelName,
            startTime,
            diffBudget,
            parentWarnings,
        } = ctx;
        const chunks = chunkFilesByTokenBudget(input.changedFiles, diffBudget);

        // Defense-in-depth: the chunker may pack small files together
        // into a single chunk (all files individually fit comfortably).
        // The execute() pre-check above already detects this case and
        // skips executeChunked, but if a caller bypassed the pre-check
        // we still don't want to recurse — that would re-enter execute()
        // with the same files at depth+1, trigger the same chunking
        // decision, and hit MAX_RECURSION_DEPTH with an opaque error.
        // Instead, just log and proceed; the inner agent loop's
        // assertPromptFitsInContext preflight is the real gate when the
        // prompt won't fit, and its mid-stream compressor handles
        // marginal overflow.
        if (
            chunks.length === 1 &&
            chunks[0].length === input.changedFiles.length &&
            input.changedFiles.length > 1
        ) {
            this.agentLogger.log({
                message: `[AGENT] ${identity.name} chunker returned 1 chunk for ${input.changedFiles.length} files (files pack comfortably); proceeding as single batch`,
                context: identity.name,
                metadata: {
                    prNumber: input.prNumber,
                    filesCount: input.changedFiles.length,
                    diffBudget,
                },
            });
        }

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} PR#${input.prNumber}: reviewing ${input.changedFiles.length} files in ${chunks.length} batch(es)`,
            context: identity.name,
            metadata: {
                batches: chunks.map((c, i) => ({
                    batch: i + 1,
                    files: c.length,
                    tokens: estimateDiffTokens(c),
                })),
            },
        });

        const allSuggestions: Partial<CodeSuggestion>[] = [];
        const allDiscardedBySeverity: Partial<CodeSuggestion>[] = [];
        const allDiscardedByVerify: Partial<CodeSuggestion>[] = [];
        // Seed aggregate warnings with the parent-level entries so the
        // chunker doesn't lose PROMPT_COMPACTED / DIFF_TRUNCATED etc.
        const allWarnings: ReviewWarning[] = [...(parentWarnings ?? [])];
        let totalTurns = 0;
        // Track per-batch failures so a totally-failed chunked run can
        // surface as an orchestrator failure instead of silently
        // returning empty findings (a pre-fix benchmark caught this:
        // every batch threw AGENT_PROMPT_OVERHEAD_EXCEEDS_BUDGET and the
        // user got "review completed, 0 findings" with no signal).
        const batchErrors: Error[] = [];

        const batchTotal = chunks.length;

        for (let i = 0; i < batchTotal; i++) {
            const batchFiles = chunks[i];
            const batchFileSet = new Set(batchFiles.map((f) => f.filename));
            const batchIndex = i + 1;
            // Always use the unmodified getIdentity().name to build the label
            // so recursive chunked runs do not accumulate
            // " batch X/Y batch X/Y ..." suffixes in the agent name
            // (logs grew unbounded — see the production smoking-gun trace
            // captured in issue #1056).
            const batchLabel = `${this.getIdentity().name} batch ${batchIndex}/${batchTotal}`;
            const batchStartedAt = Date.now();

            this.agentLogger.log({
                message: `[AGENT] ${batchLabel} starting: ${batchFiles.length} files`,
                context: identity.name,
                metadata: { files: batchFiles.map((f) => f.filename) },
            });

            // Surface batch boundaries in the PR logs UI so users can see
            // the review is chunked (otherwise the per-step counter appears
            // to "reset" between batches with no explanation).
            input.onAgentProgress?.({
                agentName: identity.name,
                agentCategory,
                agentReplicaIndex: input.agentReplicaIndex,
                agentReplicaTotal: input.agentReplicaTotal,
                status: 'batch_started',
                batchIndex,
                batchTotal,
                batchFiles: batchFiles.length,
            });

            try {
                const batchInput: ReviewAgentInput = {
                    ...input,
                    changedFiles: batchFiles,
                    agentRuntimeName: batchLabel,
                    // Forward batch info so per-step events emitted inside
                    // execute() can include it in their labels.
                    batchIndex,
                    batchTotal,
                    // Increment the recursion counter so the depth guard in
                    // execute() can short-circuit any unexpected re-entry.
                    recursionDepth: (input.recursionDepth ?? 0) + 1,
                };

                const batchResult = await this.execute(batchInput);

                allSuggestions.push(...batchResult.suggestions);
                if (batchResult.discardedBySeverity) {
                    allDiscardedBySeverity.push(
                        ...batchResult.discardedBySeverity,
                    );
                }
                if (batchResult.discardedByVerify) {
                    allDiscardedByVerify.push(...batchResult.discardedByVerify);
                }
                if (batchResult.warnings?.length) {
                    allWarnings.push(...batchResult.warnings);
                }
                totalTurns += batchResult.turnsUsed;

                this.agentLogger.log({
                    message: `[AGENT] ${batchLabel} completed: ${batchResult.suggestions.length} findings`,
                    context: identity.name,
                });

                input.onAgentProgress?.({
                    agentName: identity.name,
                    agentCategory,
                    agentReplicaIndex: input.agentReplicaIndex,
                    agentReplicaTotal: input.agentReplicaTotal,
                    status: 'batch_completed',
                    batchIndex,
                    batchTotal,
                    batchFiles: batchFiles.length,
                    findings: batchResult.suggestions.length,
                    durationMs: Date.now() - batchStartedAt,
                });
            } catch (error) {
                const errMsg =
                    error instanceof Error ? error.message : String(error);
                const errName = error instanceof Error ? error.name : undefined;
                this.agentLogger.error({
                    message: `[AGENT] ${batchLabel} failed: ${errMsg}`,
                    context: identity.name,
                    error,
                });

                input.onAgentProgress?.({
                    agentName: identity.name,
                    agentCategory,
                    agentReplicaIndex: input.agentReplicaIndex,
                    agentReplicaTotal: input.agentReplicaTotal,
                    status: 'error',
                    batchIndex,
                    batchTotal,
                    batchFiles: batchFiles.length,
                    durationMs: Date.now() - batchStartedAt,
                    errorMessage: errMsg.substring(0, 500),
                    errorName: errName,
                });

                batchErrors.push(
                    error instanceof Error ? error : new Error(errMsg),
                );
            }
        }

        // When every batch failed, propagate the first batch's error so
        // the orchestrator records the agent as failed (failures[]) and
        // the end-review comment shows the friendly reason. Partial
        // failures still return whatever findings we did collect — those
        // are real signal even if some batches couldn't complete.
        if (
            batchErrors.length === batchTotal &&
            batchTotal > 0 &&
            allSuggestions.length === 0
        ) {
            this.agentLogger.error({
                message: `[AGENT] ${identity.name} PR#${input.prNumber}: all ${batchTotal} batches failed; propagating first batch error to orchestrator`,
                context: identity.name,
                metadata: {
                    prNumber: input.prNumber,
                    batchTotal,
                    firstError: batchErrors[0]?.message,
                },
            });
            throw batchErrors[0];
        }

        const durationMs = Date.now() - startTime;

        this.agentLogger.log({
            message: `[AGENT] ${identity.name} PR#${input.prNumber} all batches done: ${allSuggestions.length} total findings in ${durationMs}ms`,
            context: identity.name,
        });

        input.onAgentProgress?.({
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            status: 'completed',
            findings: allSuggestions.length,
            durationMs,
        });

        return {
            suggestions: allSuggestions,
            discardedBySeverity: allDiscardedBySeverity,
            discardedByVerify: allDiscardedByVerify,
            agentName: identity.name,
            agentCategory,
            agentReplicaIndex: input.agentReplicaIndex,
            agentReplicaTotal: input.agentReplicaTotal,
            turnsUsed: totalTurns,
            durationMs,
            warnings: allWarnings,
        };
    }

    private buildSystemPrompt(input: ReviewAgentInput): string {
        const isSelfContained = !input.remoteCommands;
        if (isSelfContained) {
            return this.buildSelfContainedSystemPrompt(input);
        }

        // Adaptive fit: when the resolved profile is `compact` or
        // `minimal`, drop the Workflow PHASE 1/2/3 walk-through (~3K chars
        // / ~750 tokens) and the per-category long-form prompt. Mindset
        // and Scope stay — they're load-bearing behavioral cues. The
        // category and language requirements collapse to one line each.
        if (input.adaptiveProfile?.compactPrompt) {
            return this.buildCompactSystemPrompt(input);
        }

        const identity = this.getIdentity();
        const categoryPrompt = this.getCategoryPrompt(input);
        const overridesSection = this.formatOverrides(input);
        const memoryRulesSection = this.formatMemoryRules(input.memoryRules);

        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langSection = langLabel
            ? `\n  <Language>Write ALL review comments, summaries, and reasoning in ${langLabel}. This is mandatory — do not fall back to English.</Language>`
            : '';

        return `<CodeReviewAgent>
  <Date>${new Date().toLocaleDateString('en-GB')}</Date>
  <Role>
    You are ${identity.name}, ${identity.description}
    ${categoryPrompt}${langSection}
  </Role>

  <Mindset>
    Assume every change is broken until you prove it is safe.
    Your default is to report — you need evidence to DISMISS, not evidence to report.
    "Looks correct" is not enough to dismiss. You must explain WHY it cannot fail.
    High-recall mode: if the visible code gives you concrete, code-backed suspicion of a defect, emit the finding instead of self-censoring it. A later verifier will filter unsupported claims.
  </Mindset>

  <Workflow>
    Your first action must be a tool call — not text.

    PHASE 1 — INVESTIGATE (use tools)

      Step 1: Read the diffs. For each changed function/method, list what it does differently now.

      Step 2: For each method CHANGED in the diff, trace the call chain:
        a) grep("exactMethodName\\(", excludeTests=true) → find who calls it
        b) readFile the caller — what does it pass? What does it expect back?
        c) If the changed method calls ANOTHER method, grep for THAT method too — read it. What does it actually return? Is it the right target?
        d) Keep following calls until you hit a concrete implementation or return value. Do NOT stop at the first layer.
        For interfaces/abstract methods, grep "implements X" or "extends X" to find concrete implementations.
        e) Before every readFile call, identify the exact unanswered question that this read will answer.
        f) Do not reread a highly overlapping range of the same file unless you have a new concrete question, such as a newly discovered symbol, a specific caller/callee to verify, or a branch not covered by the previous read.
        g) Confidence-seeking rereads are a mistake. If the next read would mostly overlap with what you already saw and you cannot name a new question, do not make that read.

      Step 3: Read caller context. Understand HOW the changed code is used in production.
        If you have a concrete compile-time or contract hypothesis and checkTypes is available, you may use it to verify that hypothesis on the changed files.

      Step 4: If the code uses an external library or framework API that you are unsure about, use searchDocs to verify.
        Examples: "Does Rails serializer require ? suffix on include_ methods?", "Does Python dataclass use shared mutable defaults?", "Does Prisma @updatedAt fire with empty data object?"
        Do NOT guess framework behavior — verify it.

    STANCE — review like a senior engineer who treats the change as unproven.
      Before judging any changed unit, first UNDERSTAND it: what does the surrounding
      code actually do, and what is this change trying to accomplish (its intent/contract)?
      Then reason about IMPACT: what does this change ripple into — callers,
      implementations of a changed interface, shared state, invariants — and does it
      still hold there?
      A change being intentional does NOT make it correct. Your job is to PROVE it
      fulfills its intent everywhere it touches:
        - When the proof depends on another site (a caller, an implementation, a
          function it now relies on), use getCallers / grep / readFile to actually
          inspect that site — do not assume it was updated. A site left on the old
          contract is a concrete defect.
        - Apply the failure heuristics below to EACH changed unit — not only the one
          that caught your eye.
      Conclude "safe" only after a real attempt to break it came up empty.
      "It looks correct" is not a verdict; "I traced X and confirmed Y holds" is.

    PHASE 2 — CHALLENGE (think adversarially)

      For each changed function, ask yourself these questions:
        - "What if this input is null/nil/empty/zero?" → check if new code handles it. Then ask: "Does handling it by returning early silently disable a feature that should work in that case?"
        - "What if two requests hit this at the same time?" → check-then-act without lock = race condition
        - "What if a caller passes a different type than expected?" → datetime vs number, dict vs list
        - "What if this function is called from a path I haven't seen?" → grep again if unsure
        - "Does this change break any existing caller?" → did the signature, return type, or side effect change?
        - "Does this affect caching/invalidation?" → changed predicate = stale cache risk
        - "Does this code delegate to another layer (cache, proxy, adapter)?" → is it calling the right target — delegate vs self, concrete vs default?
        - "When code calls through an indirection (session.getProvider(), context.getService(), factory.create()), which concrete object is returned?" → grep for the registration/binding to verify. Only report a self-recursion if you found concrete evidence (e.g. a registration line binding the interface to the current class).
      If you cannot confidently answer "this is safe" for any question, investigate more or report it.

    PHASE 3 — RESPOND

      For each finding you report or dismiss, give a one-line certificate:
        Premise (what the changed code does) → Path (the concrete input/state that makes it fail, or why it cannot) → Verdict (report/dismiss + the evidence you inspected).
        BAD: "The code looks correct."
        GOOD: "CreateDevice: Premise — inserts a device after a count check. Path — two concurrent requests pass the check before either writes (caller impl.go:155, no lock or unique constraint). Verdict — race, reported."

      Do not stop after finding the first issue — investigate ALL changed code before responding.
      Do not burn steps rereading the same body. If a readFile range overlaps heavily with what you already saw, reread only when a newly discovered symbol or branch creates a new concrete question; otherwise continue with grep, caller/callee tracing, or another changed file.

    IMPORTANT — VERIFY BEFORE CLAIMING:
      NEVER claim something is missing, undefined, not imported, or does not exist without first using grep to verify.
      NEVER claim a method has the wrong signature without first reading its definition.
      NEVER claim a variable is unused or a branch is unreachable without tracing the actual code path.
      If you searched and did not find it, say "I searched for X and did not find it" — do not assert "X does not exist".
  </Workflow>

  <Scope>
    Root cause must be in lines added or modified by this PR.
    relevantFile/relevantLinesStart/relevantLinesEnd must point to the changed lines.
    Trace impact through callers — symptom can appear elsewhere, but the cause must be in the diff.${SCOPE_CROSS_FILE_EXTRA}
  </Scope>

${overridesSection}

${memoryRulesSection}

</CodeReviewAgent>`;
    }

    /**
     * Compact variant of `buildSystemPrompt` for the adaptive-fit
     * `compact` / `minimal` profiles. Drops the Workflow walk-through
     * (~3K chars) and the long category prompt, keeping only the
     * behavioral spine (Role, one-line Mindset, one-line Scope) plus the
     * user-configured override/memory blocks (those are not optional —
     * the user wrote them). Estimated saving: ~3–3.5K tokens vs the
     * full prompt.
     */
    private buildCompactSystemPrompt(input: ReviewAgentInput): string {
        const identity = this.getIdentity();
        const categoryLabel = this.getCategoryLabel();
        const overridesSection = this.formatOverrides(input);
        const memoryRulesSection = this.formatMemoryRules(input.memoryRules);
        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langLine = langLabel
            ? `\n  Write all review output in ${langLabel}.`
            : '';

        return `<CodeReviewAgent>
  <Role>You are ${identity.name}, a ${categoryLabel} code reviewer.${langLine}</Role>
  <Mindset>Assume each change is broken until you can name the input that proves it safe. Default to reporting when you have code-backed suspicion.</Mindset>
  <Workflow>For each changed function: grep callers and callees with the tools, read enough to confirm or dismiss, then submit via the submitResult tool.</Workflow>
  <Scope>Root cause must be in lines added or modified by this PR. Trace impact through callers but anchor the finding to a changed line.</Scope>
${overridesSection}
${memoryRulesSection}
</CodeReviewAgent>`;
    }

    protected buildUserPrompt(input: ReviewAgentInput): string {
        const isSelfContained = !input.remoteCommands;
        if (isSelfContained) {
            return this.buildSelfContainedUserPrompt(input);
        }

        // Adaptive fit: compact user prompt cuts the OutputFormat JSON
        // example (~1K chars; the submitResult tool schema already
        // carries it) and trims <Rules> from ~25 bullets down to the
        // core six that drive the reporting threshold.
        if (input.adaptiveProfile?.compactPrompt) {
            return this.buildCompactUserPrompt(input);
        }

        const prContextSection = this.formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = this.formatDiffs(input.changedFiles);
        // The callGraph string from kodus-graph already starts with <CallGraph>
        // and ends with </CallGraph> — wrapping it again produced nested duplicate
        // tags in the prompt.
        const callGraphSection = input.callGraph
            ? `\n  ${input.callGraph}`
            : '';
        const coverageTargets = formatCoverageTargetsForPrompt(
            input.changedFiles,
            20,
            input.fileTiers ? { fileTiers: input.fileTiers } : undefined,
        );

        const categoryLabel = this.getCategoryLabel();
        const mixedLabelMode = this.supportsMixedLabels();
        const allowedSuggestionLabels = this.getAllowedSuggestionLabels(input);
        const mixedLabelRules = mixedLabelMode
            ? `- Every finding must include a "label" and it must be one of: ${allowedSuggestionLabels.join(', ')}.
    - Use bug for correctness/regression issues, security for exploit or authorization issues, and performance for material slowdowns or resource blowups.
    - If the same root cause could fit multiple categories, choose the strongest primary label once — do not duplicate the same finding under multiple labels.`
            : '';
        const mixedLabelTaskGuidance = mixedLabelMode
            ? `
    Before finalizing, run an explicit pass for each enabled category: ${allowedSuggestionLabels.join(', ')}.
    Do not stop after finding only bug issues — you must still check whether the changed code introduces concrete security or performance problems when those categories are enabled.
    In your reasoning, explicitly note at least one concrete hypothesis you tested for each enabled category, even if that category produced no finding.`
            : '';
        const mixedLabelLensRules = mixedLabelMode
            ? `
    - For every enabled category (${allowedSuggestionLabels.join(', ')}), either report a concrete finding or explain in the reasoning why no concrete issue exists.
    - Do not suppress a concrete performance issue just because it is not a correctness bug. If the primary failure mode is scale, query count, cache blowup, unbounded loading, async fanout, or blocking I/O, label it as performance.
    - Do not suppress a concrete security issue just because the code also has a bug. If the primary failure mode is exploitability, authorization bypass, trust-boundary failure, or unsafe input reaching a sink, label it as security.`
            : '';
        const outputLabelLine = mixedLabelMode
            ? `"label": "${allowedSuggestionLabels.join('|')}",
      `
            : '';

        const taskDescriptions: Record<string, string> = {
            bug: 'real bugs introduced, exposed, or made worse by these changes',
            performance:
                'real performance regressions introduced or worsened by these changes',
            security:
                'real security vulnerabilities introduced, exposed, or made worse by these changes',
            generalist:
                'real bugs, security vulnerabilities, and material performance regressions introduced, exposed, or made worse by these changes',
        };
        const taskDescription =
            categoryLabel === 'generalist'
                ? `real ${allowedSuggestionLabels.join(', ')} issues introduced, exposed, or made worse by these changes`
                : (taskDescriptions[categoryLabel] ??
                  'issues introduced by these changes');

        return (
            `<ReviewTask>
  ${prContextSection}

  <Diffs>
${diffsSection}
  </Diffs>
${callGraphSection}

  <Task>
    Review this Pull Request for ${taskDescription}.
    For each changed function: grep callers → read context → challenge with adversarial questions.${input.callGraph ? '\n    Use the call graph above as a fast map of production callers/callees, but still verify with tools before reporting.' : ''}
    Promote a finding when the changed code gives you a code-backed suspicion of a defect. You don't need to fully prove the failure — anchor it to a specific changed line and let the verifier filter unsupported claims.
    Dismiss only what you can explain WHY it cannot fail; when in doubt, report rather than self-censor.
${mixedLabelTaskGuidance}
  </Task>

  <CoverageContract>
    Below are the changed hunks. Go DEEP on the ones that can hide a bug — trace callers, read the surrounding logic, challenge each with adversarial questions. SKIP trivial hunks (renames, formatting, comments, config/lockfiles). You do NOT need to read every hunk: fully reasoning about the few suspicious ones beats skimming all of them. Depth of analysis over breadth of reading.
${coverageTargets ? `${coverageTargets}\n` : ''}
  </CoverageContract>

  <Rules>
    - Root cause must be in lines added or modified by this PR.
    - Pre-existing issues: report only if this PR makes them worse or newly reachable.
    - "Looks correct" is not a valid reason to dismiss — explain the specific reason it is safe.
    - Before finalizing, make sure you went DEEP on the suspicious hunks — skipping trivial ones is fine.
    - Reporting threshold (high-recall): report any defect the changed code makes you suspect, as long as you (1) anchor it to a specific changed line and (2) name the kind of failure — wrong output, crash, broken contract, wrong target or branch, lost side effect, or broken caller/callee assumption. You do NOT need to prove the exact triggering input or rule out every safe explanation; a later verifier filters unsupported claims. Only pure speculation with no anchor in the changed code is out.
    - Resource-exhaustion, injection, bypass, or performance concerns: report them when the changed code makes you suspect them — anchor to a changed line and let the verifier filter; do not pre-suppress by class.
    - Clear local defects in the diff should still be reported immediately. Cross-file claims are welcome — anchor to a changed line and name the other site to check; the verifier confirms.
    - Before every readFile call, identify the exact unanswered question that this read will answer.
    - Do not reread the same or highly overlapping range just to gain confidence. Confidence-seeking rereads are a mistake.
    - Treat redundant readFile calls as a mistake. Only reread overlapping lines if a newly discovered symbol, caller/callee, or branch creates a new concrete question that the previous read did not answer.
    - Performance concerns (O(N), N+1, redundant calls, missing pagination/timeouts): report them when the changed code makes you suspect a real slowdown — label as performance and let the verifier filter; do not pre-suppress by class.
    - Missing defensive measures (CSRF, rate limiting, input validation): report them when the changed code plausibly exposes the gap — anchor to a changed line and let the verifier judge exploitability; do not pre-suppress by class.
    - Concrete findings include build-time and contract failures too. If the diff introduces a signature mismatch, wrong delegate call, impossible method call, or dropped required side effect, you may report it even without a runtime trace.
    - For wrappers, middleware, providers, caches, and adapters, verify both behavior and wiring: the changed code may be wrong because it calls the wrong target, preserves the wrong cached semantics, or silently stops propagating tracing/logging/metrics/auth state.
    - For security flows, challenge any value that became static, shared, or reused across requests/users when it should be per-request, per-session, or per-principal.
    ${mixedLabelRules}
    ${mixedLabelLensRules}
    - Assign a confidence score (1-10) to each finding. Be honest — overconfidence wastes verification budget:
      9-10: You read BOTH the callsite AND the callee definition, confirmed the types/signatures mismatch or the wrong return value, and can name the exact failing input. Reserve 10 for bugs where you verified the fix would work.
      7-8: You read the relevant code and traced the failure path, but did not verify the callee definition or could not confirm the exact input that triggers it.
      5-6: The code pattern looks wrong based on the diff, but you only read one side (caller OR callee, not both). The bug is plausible but not fully confirmed.
      1-4: Suspicious pattern, speculative concern, or you are reporting based on experience rather than evidence from this codebase.
    - Return only the JSON object inside markdown fences, no extra text.
  </Rules>

  <OutputFormat>
` +
            '```' +
            `json
{
  "reasoning": "For each changed function: what you challenged, what callers you found, why you reported or dismissed. Example: 'Challenged CreateDevice: what if two requests pass count check simultaneously? Grepped TagDevice(, found caller at impl.go:155. No lock or unique constraint — race condition. Reported.'",
  "suggestions": [
    {
      ${outputLabelLine}"relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact. HOW: concrete fix if clear from the code — omit if speculative.",
      "existingCode": "problematic code snippet from the diff",
      "improvedCode": "fixed code snippet (only if fix is clear from context)",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
` +
            '```' +
            `
  </OutputFormat>
</ReviewTask>`
        );
    }

    /**
     * Compact variant of `buildUserPrompt` for adaptive-fit
     * `compact` / `minimal` profiles. Drops the OutputFormat JSON example
     * (~1K chars — the submitResult tool schema already enforces shape)
     * and collapses <Rules> from ~25 bullets to the 6 that actually
     * drive the report/dismiss threshold. CoverageContract is kept but
     * trimmed to one line. Estimated saving: ~3–4K tokens vs the full
     * user prompt; the larger the PR, the higher the absolute savings
     * because <Diffs> is preserved (it's the actual data the model
     * reviews).
     */
    private buildCompactUserPrompt(input: ReviewAgentInput): string {
        const prContextSection = this.formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = this.formatDiffs(input.changedFiles);
        const callGraphSection = input.callGraph
            ? `\n  ${input.callGraph}`
            : '';
        const coverageTargets = formatCoverageTargetsForPrompt(
            input.changedFiles,
            20,
            input.fileTiers ? { fileTiers: input.fileTiers } : undefined,
        );
        const categoryLabel = this.getCategoryLabel();
        const mixedLabelMode = this.supportsMixedLabels();
        const allowedSuggestionLabels = this.getAllowedSuggestionLabels(input);
        const labelHint = mixedLabelMode
            ? `\n    Label each finding as one of: ${allowedSuggestionLabels.join(', ')}.`
            : '';

        return `<ReviewTask>
  ${prContextSection}
  <Diffs>
${diffsSection}
  </Diffs>
${callGraphSection}
  <Task>Review this PR for real ${categoryLabel} issues introduced by the diff. For each changed function: grep callers, read enough to confirm, then submit.${labelHint}</Task>
  <CoverageContract>readFile every hunk of every changed file below before submitting. grep does not count as coverage.
${coverageTargets ?? ''}</CoverageContract>
  <Rules>
    - Root cause must be in lines added or modified by this PR.
    - Report only with a concrete failure path: name the input, the wrong behavior, and the changed line that causes it.
    - "Looks correct" is not a dismissal — explain why it cannot fail.
    - No speculative findings (missing rate-limiting, generic N+1, defensive measures) unless the diff creates the exploit/slowdown.
    - Assign confidence 1–10. Be honest: ≥9 only when both caller and callee read; ≤4 = speculative, do not report below 5.
    - Submit via the submitResult tool; do not print free-form JSON.
  </Rules>
</ReviewTask>`;
    }

    /**
     * Builds a self-contained system prompt for trial / no-sandbox flows.
     *
     * The tool-heavy workflow (grep callers, readFile bodies, checkTypes)
     * from the normal system prompt does not apply — the agent has no
     * tools. This variant keeps the role/mindset/category guidance but
     * replaces the workflow with a single-pass analysis instruction set.
     */
    private buildSelfContainedSystemPrompt(input: ReviewAgentInput): string {
        const identity = this.getIdentity();
        const categoryPrompt = this.getCategoryPrompt(input);
        const overridesSection = this.formatOverrides(input);
        const memoryRulesSection = this.formatMemoryRules(input.memoryRules);

        const langLabel = resolveLanguageLabel(input.languageResultPrompt);
        const langSection = langLabel
            ? `\n  <Language>Write ALL review comments, summaries, and reasoning in ${langLabel}. This is mandatory — do not fall back to English.</Language>`
            : '';

        return `<CodeReviewAgent mode="self-contained">
  <Date>${new Date().toLocaleDateString('en-GB')}</Date>
  <Role>
    You are ${identity.name}, ${identity.description}
    ${categoryPrompt}${langSection}
  </Role>

  <Mindset>
    You are running without tools and without access to the repository.
    You see only the diffs and any inlined file contents.
    Report findings only when the evidence is fully visible in what you see.
    "Might be" is not enough — if you cannot point to specific visible lines as proof, do NOT report it.
    Low-hallucination mode: err on the side of silence when the defect depends on code you cannot see.
  </Mindset>

  <Workflow>
    PHASE 1 — READ
      Read every diff. For each changed function, understand what it does differently now.
      If full file contents are inlined below, also read those to understand the surrounding context of each change.

    PHASE 2 — CHALLENGE (strictly within the visible code)
      For each changed function, ask:
        - "Is there a null/undefined dereference on a path the diff introduces?"
        - "Is an off-by-one, inverted condition, missing break, or wrong operator visible?"
        - "Is a secret, credential, or token hardcoded in the diff?"
        - "Is there an obvious injection sink (SQL concat, shell interpolation, unsafe HTML) in the diff?"
        - "Is a resource opened but not closed on an error path visible in the diff?"
        - "Is a value used that is assigned later, or never assigned at all, in the shown code?"
      Do NOT ask questions you cannot answer from the visible code.

    PHASE 3 — RESPOND
      Return a JSON object with your findings. Every finding must cite exact line numbers from the diff.
      Assign confidence honestly: 7+ only when the defect is obvious from the shown lines, 3-5 when you suspect it but cannot fully prove it, below 3 for speculation (do NOT report below 5).

    FORBIDDEN:
      - Claiming a caller passes wrong data (you cannot see callers).
      - Claiming a dependency has a signature mismatch (you cannot read the dependency).
      - Reporting missing rate-limiting, CSRF, or defense-in-depth without a concrete exploit visible in the diff.
      - Any finding whose proof would require reading a file that is not inlined below.
  </Workflow>

  <Scope>
    Root cause must be in lines added or modified by this change.
    relevantFile/relevantLinesStart/relevantLinesEnd must point to the changed lines.${SCOPE_CROSS_FILE_EXTRA}
  </Scope>

${overridesSection}

${memoryRulesSection}

</CodeReviewAgent>`;
    }

    /**
     * Builds a self-contained user prompt for trial / no-sandbox flows.
     *
     * The agent has no tools and cannot explore the repo, so the prompt:
     *   - Inlines file content when the CLI shipped it (fileContent field)
     *   - Removes all tool instructions (no readFile/grep/checkTypes refs)
     *   - Drops the CoverageContract (nothing to cover against)
     *   - Explicitly forbids speculation about callers or cross-file behavior
     *   - Focuses on self-evident defects in the diff
     */
    protected buildSelfContainedUserPrompt(input: ReviewAgentInput): string {
        const prContextSection = this.formatPRContext(
            input.prTitle,
            input.prBody,
        );
        const diffsSection = this.formatDiffs(input.changedFiles);
        const fileContentsSection = this.formatInlineFileContents(
            input.changedFiles,
        );

        const categoryLabel = this.getCategoryLabel();
        const mixedLabelMode = this.supportsMixedLabels();
        const allowedSuggestionLabels = this.getAllowedSuggestionLabels(input);
        const outputLabelLine = mixedLabelMode
            ? `"label": "${allowedSuggestionLabels.join('|')}",
      `
            : '';

        const taskDescriptions: Record<string, string> = {
            bug: 'real bugs introduced, exposed, or made worse by these changes',
            performance:
                'real performance regressions introduced or worsened by these changes',
            security:
                'real security vulnerabilities introduced, exposed, or made worse by these changes',
            generalist:
                'real bugs, security vulnerabilities, and material performance regressions introduced, exposed, or made worse by these changes',
        };
        const taskDescription =
            categoryLabel === 'generalist'
                ? `real ${allowedSuggestionLabels.join(', ')} issues self-evident from these diffs`
                : (taskDescriptions[categoryLabel] ??
                  'issues introduced by these changes');

        return (
            `<ReviewTask mode="self-contained">
  ${prContextSection}

  <Diffs>
${diffsSection}
  </Diffs>
${fileContentsSection}

  <Task>
    You are running in self-contained mode. You have NO tools and NO access to the repository beyond the diffs and any inlined file contents shown above.

    Review these changes for ${taskDescription} that are self-evident from the diff alone.

    Report only findings you can fully justify from what you can see. Do NOT speculate about callers, cross-file behavior, or code you do not have.
  </Task>

  <Rules>
    - Root cause must be visible in the diff or in the inlined file contents.
    - Do NOT claim "function X might be called from somewhere that passes null" — you cannot verify that.
    - Do NOT claim "this might break an existing caller" — you cannot see callers.
    - DO report: null/undefined dereferences with no guard in the changed code, off-by-one errors, inverted conditions, missing await, hardcoded secrets, obvious injection paths, resource leaks in the changed function, missing error handling around risky operations, typos in identifiers that are local to the shown code.
    - DO NOT report: generic performance theories, missing CSRF/rate-limiting, speculative race conditions without a visible shared-state violation, suggestions that require knowing how the code is used elsewhere.
    - Every finding must pass this test: "Can I point to the exact lines in the diff and explain the failure path using only what is visible here?"
    - If in doubt, do NOT report it.
    - Assign a confidence score (1-10). In self-contained mode, confidence above 7 is rare — reserve it for defects that are obvious from the shown lines alone.
    - Return only the JSON object inside markdown fences, no extra text.
  </Rules>

  <OutputFormat>
` +
            '```' +
            `json
{
  "reasoning": "What you checked and why. Example: 'Looked at auth.ts line 42: new code dereferences user.email without checking if user is null. Parameter comes from an unchecked path in the same function. Reported.'",
  "suggestions": [
    {
      ${outputLabelLine}"relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact visible from the diff. HOW: concrete fix if clear.",
      "existingCode": "problematic code snippet from the diff",
      "improvedCode": "fixed code snippet",
      "oneSentenceSummary": "Brief summary",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 6
    }
  ]
}
` +
            '```' +
            `
  </OutputFormat>
</ReviewTask>`
        );
    }

    /**
     * Inlines full file contents for any FileChange that carries a
     * `fileContent` field. Used only in self-contained mode: the CLI
     * client ships the user's local file state so the agent has at least
     * the full modified files to reason over, even without a sandbox.
     */
    private formatInlineFileContents(files: FileChange[]): string {
        if (!files?.length) return '';

        const withContent = files.filter(
            (f) =>
                typeof f.fileContent === 'string' && f.fileContent.length > 0,
        );
        if (withContent.length === 0) return '';

        const blocks = withContent
            .map((f) => {
                const lang = (f as any).language || '';
                return `### ${f.filename}\n\`\`\`${lang}\n${f.fileContent}\n\`\`\``;
            })
            .join('\n\n');

        return `\n\n  <FileContents>\n${blocks}\n  </FileContents>`;
    }

    private formatPRContext(prTitle?: string, prBody?: string): string {
        if (!prTitle && !prBody) return '';

        const parts: string[] = [];
        if (prTitle) parts.push(`Title: ${prTitle}`);
        if (prBody) parts.push(prBody.substring(0, 500));

        return `\n  <PRContext>${parts.join('\n')}</PRContext>`;
    }

    private formatDiffs(
        files: FileChange[],
        fileTiers?: Map<string, CoverageTier>,
    ): string {
        if (!files?.length) return 'No changed files provided.';

        return files
            .map((file) => {
                const diff = file.patchWithLinesStr ?? file.patch ?? '';
                const tier = fileTiers?.get(
                    normalizeFilenameForTier(file.filename),
                );
                if (tier === 'optional') {
                    // Optional files: render filename + per-hunk headers
                    // only. Actual content is hidden to keep the prompt
                    // small; the agent can still readFile on demand.
                    const additions = file.additions ?? 0;
                    const deletions = file.deletions ?? 0;
                    const hunkHeaders = extractHunkHeaders(diff);
                    const headerLine = hunkHeaders.length
                        ? hunkHeaders.join('\n')
                        : '(no hunk headers)';
                    return `### ${file.filename} [optional, +${additions} -${deletions}]\n\`\`\`diff\n${headerLine}\n\`\`\``;
                }
                const tierSuffix =
                    tier === 'critical'
                        ? ' [CRITICAL]'
                        : tier === 'warm'
                          ? ' [warm]'
                          : '';
                return `### ${file.filename}${tierSuffix}\n\`\`\`diff\n${diff}\n\`\`\``;
            })
            .join('\n\n');
    }

    private formatMemoryRules(rules?: Partial<IKodyRule>[]): string {
        if (!rules?.length) return '';

        const formatted = rules
            .map((r) => `- **${r.title}**: ${r.rule}`)
            .join('\n');

        return `## Memory Rules (Team Conventions)\n${formatted}`;
    }

    private formatOverrides(input: ReviewAgentInput): string {
        const parts: string[] = [];

        const descriptions = input.v2PromptOverrides?.categories?.descriptions;
        if (descriptions) {
            if (this.supportsMixedLabels()) {
                const labels = this.getAllowedSuggestionLabels(input);

                const mixedCategorySections = labels
                    .map((label) => {
                        const value = resolvePromptOverrideText(
                            descriptions[label],
                        );
                        if (!value) return null;

                        const header =
                            label.charAt(0).toUpperCase() + label.slice(1);
                        return `### ${header}\n${value}`;
                    })
                    .filter((section): section is string => Boolean(section));

                if (mixedCategorySections.length > 0) {
                    parts.push(
                        `## Category Guidelines\n${mixedCategorySections.join('\n\n')}`,
                    );
                }
            } else {
                const categoryLabel = this.getCategoryLabel();
                const categoryDesc = resolvePromptOverrideText(
                    descriptions[categoryLabel as keyof typeof descriptions],
                );
                if (categoryDesc) {
                    parts.push(`## Category Guidelines\n${categoryDesc}`);
                }
            }
        }

        // Severity classification is handled by a separate post-processing step (classify-severity.ts)
        // to avoid biasing the agent's investigation. The agent assigns a rough severity but
        // the final classification uses dedicated criteria (default or client-custom).

        const generationMain = resolvePromptOverrideText(
            input.generationMain ?? input.v2PromptOverrides?.generation?.main,
        );
        if (generationMain) {
            parts.push(`## Writing Guidelines\n${generationMain}`);
        }

        return parts.join('\n\n');
    }

    private resolveSuggestionLabel(
        suggestion: Partial<CodeSuggestion> & { label?: string },
        input: ReviewAgentInput,
    ): string {
        if (!this.supportsMixedLabels()) {
            return this.getCategoryLabel();
        }

        const allowedLabels = new Set(this.getAllowedSuggestionLabels(input));
        const rawLabel =
            typeof suggestion.label === 'string'
                ? suggestion.label.toLowerCase()
                : '';

        if (
            (rawLabel === 'bug' ||
                rawLabel === 'security' ||
                rawLabel === 'performance') &&
            allowedLabels.has(rawLabel as 'bug' | 'security' | 'performance')
        ) {
            return rawLabel;
        }

        return this.getAllowedSuggestionLabels(input)[0] || 'bug';
    }
}

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

function resolveLanguageLabel(localeOrLabel?: string): string | null {
    if (!localeOrLabel || typeof localeOrLabel !== 'string') return null;
    try {
        return displayNames.of(localeOrLabel) || localeOrLabel;
    } catch {
        return localeOrLabel;
    }
}
