/**
 * code-review — the shared CONTRACTS for a review-agent run: the input, output,
 * identity, progress and trace/anomaly shapes that the provider, the collaborators
 * (prompt-builder, batch-runner, model-factory, …) and the pipeline stage all
 * speak. Lives here (neutral home) rather than inside the provider class so the
 * collaborators don't have to import their vocabulary from the God class they
 * were extracted from (no type cycle).
 *
 * These are code-review domain shapes (changedFiles, kodyRules, remoteCommands,
 * coverage…), NOT harness primitives — the harness must never depend on them.
 *
 * `ReviewAgentInput` is composed from cohesive sub-interfaces (ISP): each
 * collaborator can depend on the narrow slice it needs (e.g.
 * `PrReviewContext & ReviewRuleConfig`) instead of the whole 34-field input.
 */
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CodeReviewConfig,
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import type { LanguageModel } from 'ai';
import { BYOKProvider, BYOKConfig } from '@kodus/kodus-common/llm';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import type { ReasoningEffort } from '@libs/llm/reasoning-options';

import { CoverageSummary, CoverageTier } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';
import { type AdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import type { ReviewWarning } from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import type { DocumentationSearchAdapter } from '@libs/code-review/infrastructure/agents/engine/agent-tools.factory';
import type { FindingsOutput } from '@libs/code-review/infrastructure/agents/core/findings-schema';

export type { FindingsOutput } from '@libs/code-review/infrastructure/agents/core/findings-schema';

/** DI token for the duplicate-logic agent provider. */
export const DUPLICATE_LOGIC_AGENT_TOKEN = Symbol.for('DuplicateLogicAgentProvider');

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
    /** Human-readable, actionable rendering of the failure ("The configured
     *  model is not available on the provider…"), classified at the throw
     *  site where the HTTP status is still intact. Prefer this over
     *  errorMessage for anything a user reads. */
    errorFriendlyMessage?: string;
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

// ─── ReviewAgentInput, composed from cohesive slices (ISP) ───────────────────

/** What's being reviewed: the PR + repo identity + the diffs. */
export interface PrReviewContext {
    organizationAndTeamData: OrganizationAndTeamData;
    changedFiles: FileChange[];
    prNumber: number;
    repositoryId?: string;
    repositoryFullName: string;
    prTitle?: string;
    prBody?: string;
    /** Base branch of the PR (e.g. "main"). Passed to tools for git diff. */
    baseBranch?: string;
}

/** How the agent investigates: sandbox + auth + call graph. */
export interface ToolingContext {
    /**
     * Remote commands for the E2B sandbox. When undefined, the agent runs
     * in self-contained mode (no tools, single-shot analysis on the diffs
     * inlined in the user prompt). Used by the CLI trial flow where there
     * is no sandbox available.
     */
    remoteCommands: RemoteCommands | undefined;
    gitHubToken?: string;
    /** Pre-computed call graph for changed functions. Generated once, shared across agents. */
    callGraph?: string;
    /** Structured AST graph JSON (nodes + edges) produced by kodus-graph.
     *  Used by the priority scorer to measure in-PR file centrality when
     *  tiered coverage is active. Safe to omit — the scorer falls back to
     *  a neutral structural weight of 1.0 when missing. */
    callGraphJson?: { nodes: unknown[]; edges: unknown[] };
}

/** Review behavior + rules the agent applies. */
export interface ReviewRuleConfig {
    languageResultPrompt: string;
    memoryRules?: Partial<IKodyRule>[];
    /** Kody rules passed through so findings tagged with ruleUuid can be cross-referenced. */
    kodyRules?: Partial<IKodyRule>[];
    v2PromptOverrides?: CodeReviewConfig['v2PromptOverrides'];
    generationMain?: string;
    /** Categories allowed for this run when using a mixed/generalist reviewer. */
    requestedCategories?: Array<'bug' | 'security' | 'performance'>;
    /** Review mode: 'fast' skips heavy passes (verify, coverage recovery, synthesis rescue) and caps agent steps; 'normal' skips verify only for very-high-confidence findings; 'deep' verifies everything. */
    reviewMode?: 'fast' | 'normal' | 'deep';
}

/** Model selection for the run. */
export interface ModelConfig {
    /**
     * When the caller has no BYOK config (e.g. the public-demo / trial
     * flow with `organizationId='trial'`), this overrides the hardcoded
     * gemini-3.1-pro default that `byokToVercelModel` falls back to.
     * Used by the trial pipeline to force a cheaper, faster model
     * (`gemini-2.5-flash`) so anonymous reviews don't take 5 minutes.
     */
    defaultModelOverride?: string;
    /**
     * Resolved BYOK *main* model override (directory -> repository -> BYOK
     * settings) from `codeReviewConfig.byokModel`. When set, it replaces
     * `byokConfig.main.model` for this run so the agent uses the same model
     * the rest of the pipeline does. Empty/undefined means "inherit".
     */
    byokModel?: string;
    /** Optional per-agent step budget for the main investigation loop. */
    maxSteps?: number;
}

/** Adaptive-fit decisions resolved upstream (by the stage) to fit the window. */
export interface FitConfig {
    /** Internal: populated by the large-PR non-deep branch of execute().
     *  Downstream consumers (buildUserPrompt, runAgentLoop) switch the
     *  coverage ledger into tiered mode when this is set. Maps each
     *  changed file to its tier ('critical' | 'warm' | 'optional'). */
    fileTiers?: Map<string, CoverageTier>;
    /**
     * Optional adaptive-fit profile resolved upstream (by the stage) from
     * the same BYOK config and model the agent will use. When present,
     * per-agent code paths read these flags instead of re-resolving the
     * profile locally — guarantees the stage's gating decisions (drop
     * callGraph, skip heavy passes) and the provider's behaviour
     * (compact prompt, all-optional, diff truncation) agree.
     */
    adaptiveProfile?: AdaptiveProfile;
    /** When true, skip recovery, second-chance, AND synthesis-rescue
     *  passes. Used by very-narrow agents (rule checks in fast mode,
     *  self-contained CLI flow). */
    skipHeavyPasses?: boolean;
    /** HEAVY mode — run an EXTRA critic pass in the finder for more recall
     *  (opt-in per review via CLI `--heavy` or PR `@kody review --heavy`). */
    heavy?: boolean;
    /** When true, run recovery + second-chance but skip ONLY the
     *  synthesis-rescue pass. The rescue pass re-words the same finding
     *  with different language, which is fine for open-ended bug review
     *  but produces duplicate comments for explicit-rule agents like
     *  kody-rules. */
    skipSynthesisRescue?: boolean;
}

/** Replica / batch / recursion bookkeeping (mostly internal). */
export interface RuntimeMeta {
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
    /** Internal: how many times executeChunked has re-entered execute()
     *  for this review. Bounded to MAX_RECURSION_DEPTH by execute() to
     *  prevent the historical execute() ↔ executeChunked() loop from
     *  exhausting the worker heap. Always undefined at the public entry
     *  point; populated by executeChunked when fanning out per-batch. */
    recursionDepth?: number;
}

/**
 * Input passed to the agent for a single review execution. Composed from the
 * cohesive slices above so a consumer can depend on just what it needs.
 */
export interface ReviewAgentInput
    extends PrReviewContext,
        ToolingContext,
        ReviewRuleConfig,
        ModelConfig,
        FitConfig,
        RuntimeMeta {
    onAgentProgress?: (event: AgentProgressEvent) => void;
    /** Parent (job-level) AbortSignal. Forwarded to runAgentLoop so the
     *  outer router timeout cancels the LLM call instead of leaving it
     *  running ghost in the background. */
    parentSignal?: AbortSignal;
    /** Gated A/B knob (default off): forwarded to AgentLoopInput.outlineFirst.
     *  The pipeline/experiment sets it; everything below threads it down. */
    outlineFirst?: boolean;
    /**
     * Commits that make up this PR (SHA + subject line), oldest→newest. Threaded
     * so commit-hygiene rules ("don't mix mechanical and behavioral changes")
     * are judged against real commit boundaries instead of the aggregated diff.
     * (PR #1412.)
     */
    commits?: Array<{ sha: string; message: string }>;
    /**
     * Optional per-review steering directive supplied by the user at trigger
     * time (e.g. `@kody review focus on the auth logic`). Free text. When set,
     * it renders as a high-priority `<ReviewFocus>` block at the top of the user
     * prompt so the finder concentrates depth on the named area WITHOUT
     * suppressing concrete issues found elsewhere. (PR #1417.)
     */
    reviewDirective?: string;
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
    /**
     * The agent stopped because it ran out of budget (per-agent timeout) or
     * steps, NOT because it finished investigating. Its `suggestions` are
     * whatever it happened to have by then — an empty list means "didn't get
     * far enough to tell", not "the code is clean".
     *
     * The distinction has to cross this boundary: without it the orchestrator
     * sees a fulfilled agent with zero findings and the pipeline auto-approves
     * a review that never completed (#1568).
     */
    hitHardLimit?: boolean;
    /** Why the agent loop stopped — 'timeout' (budget), 'max-steps', or 'stop'
     *  (ran to completion). Carried alongside hitHardLimit for telemetry and
     *  for the user-facing "review was cut short" notice. */
    finishReason?: 'timeout' | 'max-steps' | 'stop';
}

// ─── Agent-loop contracts (the low-level harness/agent boundary) ─────────────
// Relocated from the legacy llm/agent-loop.ts so the new agent path
// (core-agent-loop.adapter, finder.agent, agent-anomalies) speaks these shapes
// without importing them from the 4.5k-line legacy file. The originals there are
// now commented out.

export interface AgentLoopInput {
    model: LanguageModel;
    systemPrompt: string;
    userPrompt: string;
    agentName?: string; // e.g. 'kodus-bug-review-agent' — used as Langfuse observation name
    telemetryMetadata?: LangfuseTelemetryMetadata;
    maxSteps?: number;
    onStepFinish?: (event: any) => void;
    changedFiles?: any[];
    prNumber?: number;
    repositoryFullName?: string;
    /** Base branch of the PR (e.g. "main"). Used by git diff tools. */
    baseBranch?: string;
    /** Pre-computed call graph shared by reviewers and verifier. */
    callGraph?: string;
    /** Map of normalized filename to tier ('critical' | 'warm' | 'optional').
     *  When present, the coverage ledger runs in tiered mode: critical
     *  files must be covered; warm/optional count toward the 70% total
     *  floor. When absent, coverage stays flat (legacy 100%-all-files). */
    fileTiers?: Map<string, CoverageTier>;
    /** Review mode: 'fast' skips heavy passes and caps steps; 'normal' skips verify only for very-high-confidence findings; 'deep' verifies everything. */
    reviewMode?: 'fast' | 'normal' | 'deep';
    /** Model context window in tokens. Used to trigger context compression when the message history grows too large. */
    contextWindowTokens?: number;
    /** When true, skip recovery/rescue/second-chance passes. Used by rule-checking agents that don't benefit from open-ended exploration. */
    skipHeavyPasses?: boolean;
    /** HEAVY mode — run an EXTRA critic pass in the finder for more recall
     *  (opt-in per review via CLI `--heavy` or PR `@kody review --heavy`). */
    heavy?: boolean;
    /** Gated A/B knob (default off): wrap readFile so a range-less read of a
     *  large file returns a symbol outline + expand hint instead of dumping the
     *  head — fewer model tokens. Off = current behavior. */
    outlineFirst?: boolean;
    /** When true, skip ONLY the synthesis-rescue pass while still running
     *  coverage-recovery and coverage-second-chance. Useful for agents
     *  that benefit from re-investigating uncovered files but don't need
     *  the open-ended "rethink the review" pass — typically rule-checking
     *  agents where rules are explicit and synthesis just re-words the
     *  same findings, leading to dedup churn and duplicate comments. */
    skipSynthesisRescue?: boolean;
    /** Reasoning effort level from BYOK config. Mapped to provider-specific
     *  providerOptions (anthropic.thinking, google.thinkingConfig, etc). */
    reasoningEffort?: ReasoningEffort;
    /** Raw JSON override for reasoning config — takes precedence over effort preset. */
    reasoningConfigOverride?: string;
    /** BYOK provider type — needed to map reasoning effort to the correct
     *  provider-specific format in providerOptions. */
    byokProvider?: BYOKProvider | string;
    /** Which BYOK role this attempt is running as. Selects the concurrency
     *  limiter bucket in the model wrapper ('main' vs 'fallback'). Defaults to
     *  'main' when omitted. */
    byokRole?: 'main' | 'fallback';
    /** Pin OpenRouter requests to specific upstream providers (in order).
     *  Ignored when byokProvider !== 'openrouter'. */
    openrouterProviderOrder?: string[];
    /** Allow OpenRouter to fall back to other upstreams when the preferred
     *  order is unavailable. Defaults to OpenRouter's default (true) when
     *  undefined; set to false to hard-fail if the pinned providers aren't
     *  available. */
    openrouterAllowFallbacks?: boolean;
    /** Parent (job-level) AbortSignal. When it aborts, the local
     *  AGENT_TIMEOUT_MS controller is aborted too, propagating cancellation
     *  to the underlying generateText call (which respects abortSignal). */
    parentSignal?: AbortSignal;
}

/**
 * Secrets and service references that must NEVER be serialized into
 * tracing spans or LLM payloads. Extracted from the old AgentLoopInput
 * to prevent accidental leaks (NestJS ConfigService carries all env vars).
 */
export interface AgentLoopSecrets {
    /**
     * Remote commands for the E2B sandbox. When undefined, the agent runs
     * in self-contained mode (no tools, single-shot analysis on the diffs
     * inlined in the user prompt). Used by the CLI trial flow where there
     * is no sandbox available.
     */
    remoteCommands: RemoteCommands | undefined;
    byokConfig?: BYOKConfig;
    gitHubToken?: string;
    /**
     * External documentation search adapter (Exa-backed). When provided,
     * registers the `searchDocs` tool on the agent so it can verify
     * framework/library behavior against official docs. Required for the
     * verifier to validate findings about third-party APIs.
     */
    documentationSearchService?: DocumentationSearchAdapter;
    /** Options forwarded to the documentation search adapter on each call. */
    documentationSearchOptions?: Record<string, unknown>;
    /**
     * Queue timeout passed to runWithBYOKLimiter for all LLM calls in this loop.
     * When undefined, falls back to DEFAULT_LIMITER_QUEUE_TIMEOUT_MS (0 = infinite).
     * Conversation callers set this to 60_000 to fail fast if review holds the slot.
     * MAINT-02: This is a generic field — not conversation-specific; review callers
     * can also set it if they need bounded queue behavior.
     */
    byokQueueTimeoutMs?: number;
    /**
     * Optional sink for BYOK LLM failures. Called once per failed
     * `generateText` call inside the loop; safe to omit. Used to drive
     * the `byok.llm_errors_threshold` notification — caller wires it to
     * `ByokErrorCounter.record`.
     */
    byokErrorReporter?: (input: {
        organizationId?: string;
        provider: string;
        errorMessage: string;
    }) => void;
}

export interface AgentLoopOutput {
    findings: FindingsOutput;
    text: string;
    steps: number;
    toolCalls: Array<{
        tool: string;
        toolName?: string;
        args: Record<string, unknown>;
        result?: string;
    }>;
    finishReason: string;
    /** Present only when finishReason === 'error': the underlying provider/model
     *  error surfaced by the harness. Used to classify the failure and surface a
     *  friendly reason in the end-review comment. */
    errorMessage?: string;
    errorName?: string;
    /** Upstream HTTP status and raw response body, when the provider supplied
     *  them. The AI SDK leaves `errorMessage` as a terse status phrase ("Not
     *  Found") and stashes the actionable detail here, so classification needs
     *  both to avoid falling through to "Unexpected error" (#1568). */
    errorStatus?: number;
    errorResponseBody?: string;
    /** Whether findings came from direct JSON parse or fallback generateObject */
    source: 'json-parse' | 'generate-object' | 'empty';
    usage: {
        /** Total input tokens sent to the model (includes cached). */
        inputTokens: number;
        /** Portion of input tokens served from provider cache (Gemini/OpenAI/
         *  Moonshot/DeepSeek implicit cache, Anthropic ephemeral reads). */
        cacheReadTokens: number;
        /** Portion of input tokens written to cache on this request (pays
         *  Anthropic's write premium; 0 for implicit-cache providers). */
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        totalTokens: number;
    };
    /** Suggestions discarded by severity filter (before verify). */
    discardedBySeverity?: FindingsOutput['suggestions'];
    /** Suggestions discarded by the verifier. */
    droppedByVerify?: FindingsOutput['suggestions'];
    /** Token usage for the verification sub-step only (included in total usage). */
    verificationUsage?: {
        inputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        outputTokens: number;
        reasoningTokens: number;
    };
    coverage: CoverageSummary;
    verification?: VerificationTraceSummary | null;
    anomalies: AgentAnomalySummary;
    /** Fidelity warnings emitted during the loop (small context window
     *  forced compact prompt, dropped callGraph, etc). Always present;
     *  empty array when no adaptive strategy fired. */
    warnings: ReviewWarning[];
    /** Low-level harness trace. Intended for eval/debug artifacts; product
     *  callers should keep using the domain fields above. */
    debugTrace?: Array<{
        at: number;
        source: string;
        kind: string;
        detail?: Readonly<Record<string, unknown>>;
    }>;
}

export interface ToolEvidenceSummary {
    strongFiles: string[];
    weakFiles: string[];
}

export interface VerificationDecisionTrace {
    index: number;
    relevantFile: string;
    action: 'keep' | 'drop' | 'refine';
    parseMode: 'direct' | 'fallback-llm' | 'default-keep';
    rationale: string;
    confidence?: 'high' | 'medium' | 'low';
    verifierEvidence: ToolEvidenceSummary;
    rawTextPreview?: string;
}

export interface VerificationTraceSummary {
    beforeCount: number;
    afterCount: number;
    droppedByVerifier: number;
    /** @deprecated Always 0 — evidence gate now forces verification instead of dropping. Kept for backwards compatibility. */
    droppedByEvidenceFilter: number;
    sentToEvidenceGate?: number;
    decisions: VerificationDecisionTrace[];
}

export interface AgentAnomalySummary {
    stepsLe2: boolean;
    zeroToolCalls: boolean;
    zeroStrongEvidenceFiles: boolean;
    zeroCoverage: boolean;
    lowCoverage: boolean;
    lowStrongEvidenceFiles: boolean;
}
