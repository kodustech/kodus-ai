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
import type { SignalSite } from '@libs/code-review/infrastructure/agents/core/selector-shard';
import {
    CodeReviewConfig,
    CodeSuggestion,
    FileChange,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import type { TraceContextDecision } from '@libs/cli-review/domain/types/trace-context.types';

import { BYOKProvider } from '@libs/llm/model-providers';
import type { NormalizedModel } from '@libs/llm/byok-config';
import type { LangfuseTelemetryMetadata } from '@libs/core/log/langfuse';
import type { ReasoningEffort } from '@libs/llm/reasoning-options';

import { CoverageSummary, CoverageTier } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';
import { type AdaptiveProfile } from '@libs/code-review/infrastructure/agents/engine/adaptive-fit';
import type { ReviewWarning } from '@libs/code-review/infrastructure/agents/engine/review-warnings';
import type { DocumentationSearchAdapter } from '@libs/code-review/infrastructure/agents/engine/agent-tools.factory';
import type { FindingsOutput } from '@libs/code-review/infrastructure/agents/core/findings-schema';
import type { LinkedRepoAccess } from '@libs/ee/linked-repositories';

export type { FindingsOutput } from '@libs/code-review/infrastructure/agents/core/findings-schema';

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
    /**
     * Cross-repo context (#1576): lazy access to linked sibling repositories.
     * When set, grep/readFile/listDir accept an optional `repo` param and the
     * system prompt gains a boundary-check directive. Absent = feature off.
     */
    linkedRepoAccess?: LinkedRepoAccess;
}

/** Review behavior + rules the agent applies. */
export interface ReviewRuleConfig {
    languageResultPrompt: string;
    memoryRules?: Partial<IKodyRule>[];
    /**
     * Historical implementation decisions selected from Kodus Trace for the
     * paths in this review. They explain intent, but are not evidence that the
     * current implementation is correct.
     */
    traceDecisions?: TraceContextDecision[];
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
     * gemini-3.1-pro default that `buildModelFromSlot` falls back to.
     * Used by the trial pipeline to force a cheaper, faster model
     * (`gemini-2.5-flash`) so anonymous reviews don't take 5 minutes.
     */
    defaultModelOverride?: string;
    /**
     * Resolved BYOK *main* model override (directory -> repository -> BYOK
     * settings) from `codeReviewConfig.byokModel`. When set, it replaces
     * `byokConfig.main.model` for this run so the agent uses the same model
     * the rest of the pipeline does. Empty/undefined means "inherit".
     *
     * Legacy NAME-based override, kept for the transition window (D-05).
     */
    byokModel?: string;
    /**
     * Id-based BYOK model override (Phase 4) from `codeReviewConfig.byokModelId`.
     * References a v2 `models[]` entry by its stable id. When set, the model
     * factory routes the `codeReview` task to this exact model (top of the
     * routing precedence) via `StaticTaskStrategy`. Takes precedence over the
     * legacy `byokModel` NAME. Empty/undefined means "inherit".
     */
    byokModelId?: string;
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
    // No built model here — LLM.run resolves it from the slot (in AgentLoopSecrets.
    // byokConfig). The finder reads the slot's model id for the strict-tools
    // decision; nothing downstream needs a pre-built LanguageModel.
    systemPrompt: string;
    userPrompt: string;
    agentName?: string; // e.g. 'kodus-bug-review-agent' — used as Langfuse observation name
    /** Cost-span run name base for THIS review category (e.g. `code-review-bug`).
     *  Threaded onto every leaf model call the review makes (finder + verify +
     *  resample + prose-recovery) so `deriveArea` buckets them all under
     *  `review`. LLM.run records the ONE usage span per call — there is no
     *  separate aggregate recording. Absent → the finder default (`code-review`),
     *  which still buckets to `review`. */
    usageRunName?: string;
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
    /** A/B knob (default off): give each `critical`-tier file its own finder
     *  pass that reads the whole file, on top of the diff-wide review. Requires
     *  `fileTiers` — without tiers there is nothing to select. */
    criticalFilePasses?: boolean;
    /** A/B knob (default off): give EVERY diff hunk of EVERY changed file its
     *  own finder pass, scoped to that hunk. Deterministic split on the diff's
     *  own `@@` markers — no scoring, no LLM. Exhaustive superset of
     *  `criticalFilePasses`; wins when both are set. Pairs with
     *  `criticalFileMaxSteps` to keep the per-hunk cost down. */
    atomicHunks?: boolean;
    /** A/B knob (default off): give EVERY changed file its own finder pass with
     *  its own full diff (all its hunks together) — the coarser sibling of
     *  `atomicHunks`. Cost scales with file count instead of hunk count,
     *  cheaper on PRs with few files but many hunks per file. `atomicHunks`
     *  wins when both are set.
     *
     *  MEASURED (30 PRs, from an earlier session predating this
     *  investigation's MEASURED-annotation habit — found as
     *  evals/investigation/results/atomicfiles30.json) and discarded: F1
     *  0.327, below the current 0.432 reference. That run used the FULL
     *  generalist userPrompt for every per-file pass, plus an "ignore the
     *  diffs above" instruction — the confound this session found and fixed
     *  for the scout/expert-panel. See `criticalFileDedicatedPrompt` for the
     *  isolated retest. */
    atomicFiles?: boolean;
    /** Step cap for critical-file / atomic-hunk / atomic-file passes,
     *  independent of the main pass's `maxSteps`. Defaults to 10 under
     *  `atomicHunks`/`atomicFiles` (many small passes — cost compounds) or 20
     *  under `criticalFilePasses` (few, larger passes). */
    criticalFileMaxSteps?: number;
    /** A/B knob (default off, requires atomicHunks/atomicFiles/
     *  criticalFilePasses): give every critical-file/atomic pass a dedicated
     *  base (category definitions + output-format reminder, NO diff — the
     *  pass's own <SingleFileFocus> injects its file/hunk's diff) instead of
     *  the full userPrompt + "ignore the diffs above" hack. See
     *  finder.agent.ts:buildCriticalFilePrompt's doc and
     *  core-agent-loop.adapter.ts:CRITICAL_FILE_DEDICATED_BASE. Not yet
     *  measured. */
    criticalFileDedicatedPrompt?: boolean;
    /** A/B knob (default off): run the expert panel — N role-specific passes
     *  over the WHOLE PR diff (a specialist per language present, security,
     *  performance, QA, and a conditional DBA), followed by one arbitration
     *  pass that reconciles their claims into a final verdict. Narrows FOCUS
     *  per pass, not scope — cost is a roughly-fixed multiplier (role count +
     *  1), not proportional to diff size like `atomicHunks`/`atomicFiles`. */
    expertPanel?: boolean;
    /** A/B knob (default off): the leaner, no-debate sibling of `expertPanel`
     *  — language specialist + security + performance only (no QA, no DBA),
     *  each merged DIRECTLY into the pool (union) instead of arbitrated.
     *  Cheaper, but drops the cross-examination step. `expertPanel` wins if
     *  both are set. */
    roleEnsemble?: boolean;
    /** A/B knob (default off): a genuinely different expert panel from
     *  `expertPanel`/`roleEnsemble` — 4 fixed roles chosen by RECOGNITION
     *  FAILURE MODE (Contract Auditor, Data-Flow/Reference Tracer,
     *  Cross-Method Consistency Checker, Failure-Path Specialist — see
     *  expert-panel.ts:RECOGNITION_PANEL_ROLES), not by topic category. This
     *  session's ceiling audit found only ~3% of missed goldens were due to
     *  missing information — most were the finder reading the right code
     *  and not connecting it to a defect; every role here targets a specific
     *  confirmed pattern of that failure. Arbitration is always the more
     *  adversarial buildSkepticArbitrationPrompt (see finder.agent.ts's
     *  recognitionPanel), which also runs on an all-silent panel unlike the
     *  other two knobs' neutral arbitration. Wins over expertPanel/
     *  roleEnsemble if set.
     *
     *  MEASURED (20 PRs, standalone — skipBasePass + skipSynthesisRescue +
     *  expertPanelDedicatedPrompt, i.e. panel replacing the generalist
     *  entirely, not layered on top) and discarded: recall 31.1%, precision
     *  50.2%, F1 0.361 — well below the secondLookSameFile-era reference
     *  (F1 0.432-0.456 on the same PRs). Golden-by-golden comparison against
     *  the current best config (batedor calibrado + investigador +
     *  secondLookSameFile) on the same 20 PRs: panel found 20 goldens total,
     *  reference found 27, and 19 of the panel's 20 were ALREADY covered by
     *  the reference — only 1 was genuinely unique (a race-condition finding
     *  in one PR). Not a viable generalist replacement, and the one unique
     *  catch is too rare to justify running it as an addition either. Kept
     *  as a flag, not a validated config. */
    recognitionPanel?: boolean;
    /** A/B knob (default off, requires expertPanel/roleEnsemble/
     *  recognitionPanel): give every role + arbitration pass a dedicated base
     *  (diff + category definitions + an output-format reminder — see
     *  core-agent-loop.adapter.ts:expertPanelDedicatedBase) instead of the
     *  full userPrompt. The first cut of the expert panel (any variant) had
     *  every role read the full generalist prompt underneath its lens — same
     *  confound scoutDedicatedPrompt fixed for the scout.
     *
     *  First cut of THIS fix (bare diff, no output-format reminder) was
     *  itself broken: MEASURED (10 PRs, recognitionPanel) at near-zero recall
     *  (3.3%) — but 3/10 cases had the skeptic's own reasoning conclude
     *  "verdict—reported" for a real defect while `findings` stayed empty.
     *  Agent-loop passes report via the submitResult TOOL, not a forced
     *  schema like the scout's one-shot call — losing the full prompt's
     *  <OutputFormat> section lost the instruction that a concluded verdict
     *  must become a structured suggestion, not just reasoning prose. The
     *  investigation itself was often working; the output was getting lost.
     *  Not yet re-measured with the reminder included. */
    expertPanelDedicatedPrompt?: boolean;
    /** A/B knob (default off): a cheap one-shot scout flags a few suspicious
     *  spots across the whole diff (no tools, no investigation), then one
     *  full agent-loop pass per flag investigates it with full tool budget
     *  dedicated to that spot. Concentrates depth by SUSPICION rather than by
     *  file/tier/role — see scout-investigator.ts. */
    scoutInvestigator?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): run the one-shot
     *  scout call with reasoning ("medium") instead of off. MEASURED (8 PRs)
     *  and discarded: F1 0.469→0.379, and a golden-by-golden diff found 0
     *  gained / 3 previously-found goldens now missed — a straight regression,
     *  not a recall/precision tradeoff. See scout-investigator.ts:runScout. */
    scoutThinking?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): 3 sequential,
     *  context-aware scout rounds (each capped at 3) instead of one round
     *  capped at 5 — see scout-investigator.ts. */
    scoutResample?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): run the scout in
     *  exactly two rounds — round 1 unchanged (cap 5), then one follow-up
     *  round (cap 3) asking for OTHER spots. Isolates the two variables
     *  scoutResample conflated (shrunk round-1 cap + two extra rounds); this
     *  changes neither. Mutually exclusive with scoutResample (scoutResample
     *  wins if both set) — see scout-investigator.ts. Not yet measured. */
    scoutSecondRound?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): ask the scout for the
     *  diff line each flag is anchored to and pass it to the investigator as a
     *  starting point, instead of a file-only hint. MEASURED (5 PRs) and
     *  discarded: recall was identical to no-line-hint on every case, precision
     *  dropped 77%→62% — see finder.agent.ts:scoutLineHint for detail. Kept as
     *  a flag, not a validated config. */
    scoutLineHint?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): the scout names a
     *  SPECIFIC, falsifiable hypothesis for the defect instead of a vague
     *  "worth a look" flag, and the investigator's job becomes confirm-or-
     *  refute that exact hypothesis — see finder.agent.ts:hypothesisDriven.
     *  Inspired by Greptile v5's "swarm of agents, each exploring one
     *  hypothesis" framing; inverts a design assumption this session never
     *  tested (naming a mechanism early was assumed to just move the
     *  connection failure downstream, not fix it).
     *
     *  MEASURED (30 PRs) and discarded: F1 0.409 (recall 41.8%, precision
     *  48.1%) vs the 0.432 reference. Looked promising at 20 PRs (F1 0.485,
     *  better than reference on the same 20) but reversed on the final 10 —
     *  another confirmed 20-vs-30-PR inversion, the same pattern that bit
     *  secondLookSameFile and scoutDedicatedPrompt earlier. The drop wasn't
     *  just "harder batch" — the reference config also dipped on that same
     *  batch (F1 0.385) but hypothesisDriven dropped proportionally more
     *  (F1 0.256). secondLookSameFile + scoutCalibratedPrompt remain the
     *  reference. Kept as a flag, not a validated config. */
    hypothesisDriven?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): cost experiment —
     *  when 2+ scout flags land on the SAME file, one investigator pass
     *  investigates all of them together (with an explicit "investigate
     *  every one with equal depth" instruction) instead of N separate full
     *  agent-loop passes each re-reading the same file from scratch. Files
     *  with a single flag are unaffected. See
     *  scout-investigator.ts:buildMultiFlagInvestigatorPrompt. Motivated by
     *  secondLookSameFile's validated result (reusing one file's context for
     *  a second bug works) — distinct from scoutByCategory/recognitionPanel
     *  (MEASURED worse), which merged DIFFERENT files/topics, not flags
     *  already sharing one file. challengeDismissals/secondLookSameFile are
     *  skipped for merged groups. MEASURED (30 PRs) and discarded: F1 0.371
     *  vs the 0.432 reference — the "equal depth" instruction likely doesn't
     *  hold, a merged pass goes shallower per flag than a dedicated one. */
    investigatorGroupByFile?: boolean;
    /** A/B knob (default off = MAX_SCOUT_FLAGS/5, requires scoutInvestigator):
     *  overrides the scout's default cap. Cost experiment — the investigator
     *  is ~57% of total tokens on the champion config (one full agent-loop
     *  pass per flag), so fewer flags should cut cost roughly linearly.
     *  Raising to 10 was measured worse (qualitatively — predates this
     *  investigation's number tracking); a LOWER cap is untested. Only
     *  applies to the default single-scout path. See
     *  finder.agent.ts:scoutCap. Not yet measured. */
    scoutCap?: number;
    /** A/B knob (default off, requires scoutInvestigator): when an investigator
     *  clears its flag (0 findings) after writing real reasoning, run one
     *  follow-up pass that feeds that reasoning back and asks it to argue the
     *  opposite case before finalizing — see scout-investigator.ts. */
    challengeDismissals?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): when an investigator
     *  clears its flag (0 findings) after making a tool call, run one follow-up
     *  pass that recaps its own evidence (no re-reading) and asks about a
     *  DIFFERENT defect in the same file. MEASURED on the full 30-PR set: F1
     *  0.372→0.424 (recall +8.4pp, precision flat), the best result of this
     *  investigation — a 5-PR sample first read as a clear loss, but that
     *  sample's own baseline was itself unusually favorable, not representative
     *  — see finder.agent.ts:secondLookSameFile for detail. Validated config. */
    secondLookSameFile?: boolean;
    /** A/B knob (default off, requires secondLookSameFile): fire the second
     *  look on every investigator pass that made a tool call, not only the
     *  ones that cleared their flag — see finder.agent.ts. Not yet measured. */
    secondLookAlways?: boolean;
    /** A/B knob (default off, requires secondLookSameFile): removes the
     *  "submit empty" escape hatch from secondLook — forces it to name its
     *  single most plausible candidate instead of an honest empty array. 61%
     *  of secondLook calls return empty on the current best config (25/41 on
     *  30 PRs) — see scout-investigator.ts:buildInvestigatorSecondLookPrompt.
     *  Not yet measured. */
    secondLookForceReport?: boolean;
    /** A/B knob (default off): path-feasibility verify — replaces the HV2
     *  refute-to-drop verifier (keeps ~99% of candidates, no precision value)
     *  with an inverted-burden prompt: keep only findings whose trigger path
     *  the verifier proves reachable and unguarded by reading the code.
     *  See finder.agent.ts:feasibilityVerify. Not yet measured. */
    feasibilityVerify?: boolean;
    /** A/B knob (default off): run the scout FIRST and append its flags to the
     *  generalist's prompt as a MANDATORY checklist, instead of fanning out one
     *  investigator per flag. Targets recall-by-conservatism on frontier models
     *  (a flag it must rule on is a closed question; "is this worth reporting?"
     *  is the open one it answers with silence). See
     *  scout-investigator.ts:buildScoutVerdictBlock. Not yet measured. */
    scoutVerdict?: boolean;
    /** A/B knob (default off): skip verify (kept 98.2% of candidates across 5
     *  models at one LLM call per finding). See finder.agent.ts:skipVerify. */
    skipVerify?: boolean;
    /** A/B knob (default off): run the scout chain concurrently with the base
     *  pass. Pure scheduling change — see finder.agent.ts:parallelScout. */
    parallelScout?: boolean;
    /** A/B knob (default off): PLAN → SHARD — grep the repo for code the diff
     *  AFFECTS and check whether the change breaks it. Needs real repo search.
     *  See selector-shard.ts. */
    selectorShard?: boolean;
    /** Shard sites resolved from the AST blast radius, replacing the LLM plan
     *  and the grep. Empty with `graphSitesOnly` means no shard at all. */
    graphSites?: SignalSite[];
    graphSitesOnly?: boolean;
    /** Second rendering of the user prompt (same diff, different file order)
     *  for a decorrelated second shard draw. */
    shardAltPrompt?: string;
    /** Give the shard workers a DEDICATED base prompt instead of the
     *  generalist's.
     *
     *  Measured on the 30-PR set: of 104 candidates the shard produced, 100%
     *  pointed at a file inside the diff and 71% at a spot the generalist had
     *  already flagged — from a pass whose entire purpose is code the diff does
     *  NOT contain. The cause is proportion: the worker inherits ~58k chars of
     *  "review this whole diff, cover every file, follow this workflow",
     *  including a CoverageContract that actively demands diff coverage, and
     *  then ~600 chars asking about two specific sites. It does the task it
     *  read first.
     *
     *  That also invalidates the comparisons between site SOURCES (grep vs AST
     *  graph) and site CAPS (6 vs 8, one worker per site): they varied what was
     *  fed to a worker that was ignoring the sites. */
    shardDedicatedPrompt?: boolean;
    /** Replace the single broad pass with one narrow pass per class of defect
     *  (see core/micro-agents.ts). Pair with skipBasePass + skipSynthesisRescue
     *  for a micro-agents-only run. */
    microAgents?: boolean;
    /** Run a routing pass first: read the diff, pick which of the twelve
     *  classes it could contain, and run only those. */
    microPlanner?: boolean;
    /** Shard sites per PR, and how many share one worker (default 6 / 2). */
    shardCap?: number;
    shardPerWorker?: number;
    /** A/B knob (default off): replace the review task with an adversarial one
     *  — find the input/state that BREAKS the changed code. See
     *  scout-investigator.ts:buildAdversarialPrompt. Not yet measured. */
    adversarial?: boolean;
    /** A/B knob (default off): one independent full pass with a minimal,
     *  unstructured senior-dev-style prompt, only anchoring-to-changed-line
     *  kept — see scout-investigator.ts:buildFreeformPrompt. Not yet measured. */
    freeformPass?: boolean;
    /** A/B knob (default off, requires freeformPass): give the freeform pass
     *  a MINIMAL dedicated base (diff only) instead of the full userPrompt.
     *  First attempt at freeformPass still prepended the full rules block
     *  underneath an "ignore it" instruction — not a genuinely different
     *  style. Same fix as scoutDedicatedPrompt, same rawDiffPrompt builder.
     *  Not yet measured. */
    freeformDedicatedPrompt?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): give the scout a
     *  MINIMAL dedicated prompt (diff only), instead of the full userPrompt
     *  (diff + the whole rules/category/output-format block
     *  built for a deep investigation) every other pass reuses. MEASURED
     *  (30 PRs) and discarded: recall/precision both WORSE — F1 0.375 vs the
     *  0.424 baseline, consistent across all 3 batches of 10 (not sample
     *  noise) — despite a real, if more modest than first assumed, token
     *  reduction (see core-agent-loop.adapter.ts:calibratedDiffPrompt's doc
     *  for the corrected size numbers). The prompt's boilerplate was
     *  apparently doing real calibration work for the scout, not just riding
     *  along for free. Kept as a flag, not a validated config —
     *  secondLookSameFile alone remains the reference. See
     *  `scoutCalibratedPrompt` for the follow-up testing WHICH boilerplate
     *  mattered. */
    scoutDedicatedPrompt?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): give the scout the
     *  diff PLUS the same BUG/PERFORMANCE/SECURITY definitions the main pass
     *  reviews against (V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT) — everything
     *  else (investigation Rules, OutputFormat schema, CoverageContract, PR
     *  context) stays out. Follow-up to `scoutDedicatedPrompt` (bare diff,
     *  MEASURED worse): confirms that loss came specifically from dropping
     *  the definitions that calibrate what counts as suspicious, not from
     *  trimming context in general. MEASURED (30 PRs) and validated: recall
     *  44.6%, precision 46.3%, F1 0.432 — at or slightly above the
     *  secondLookSameFile baseline (F1 0.424), and well above
     *  scoutDedicatedPrompt's bare-diff result (F1 0.375), at a fraction of
     *  the full userPrompt's size. Candidate to become the scout's default
     *  base once combined with secondLookSameFile in one config. */
    scoutCalibratedPrompt?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): THREE parallel
     *  scouts instead of one, each dedicated to a single category (bug,
     *  performance, security), each seeing ONLY that category's definitions
     *  (see core-agent-loop.adapter.ts:categoryDiffPrompt) — not the other
     *  two categories', and not the investigation rules. Cap 3 flags per
     *  scout (CATEGORY_SCOUT_CAP), so up to 9 total vs 5 for the single
     *  general scout.
     *
     *  A prior "3-category-scouts" idea was measured on 5 PRs and tanked
     *  both recall (51%→11%) and precision (77%→19%) — but that test gave
     *  every scout the FULL generalist userPrompt with only a one-line focus
     *  sentence layered on top (see scout-investigator.ts's
     *  SCOUT_CATEGORY_FOCUS), never a genuinely isolated per-category prompt.
     *  This is the properly isolated retest — MEASURED (20 PRs, same set
     *  both ways for a direct comparison) and discarded anyway: F1 0.418 vs
     *  0.456 for the single calibrated scout on the identical 20 PRs, at
     *  HIGHER cost (more flags → more investigator passes). More scouts
     *  diluted signal the same way every other "widen the scout" attempt
     *  this investigation tried (scoutResample, cap 10) did — splitting by
     *  category isn't free breadth either. `scoutCalibratedPrompt` (one
     *  scout, all three categories' definitions) remains the reference. */
    scoutByCategory?: boolean;
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
    /** Experiment knob (default off): skip the base/generalist finder pass
     *  entirely (no LLM call) — final findings come ONLY from whatever recall
     *  passes are configured (e.g. expertPanel/roleEnsemble). For measuring
     *  whether an extra pass could REPLACE the generalist rather than layer
     *  on top of it. Combine with `skipSynthesisRescue` too, or the
     *  always-on synthesis-rescue pass (itself a generalist-style rethink)
     *  contaminates the "panel only" measurement. Passes that reuse the
     *  base's own tool-call trail (secondLookSameFile, challengeDismissals)
     *  have nothing to reuse in this mode. See
     *  finder.agent.ts:RunFinderWithVerifyParams.skipBasePass. */
    skipBasePass?: boolean;
    /** Reasoning effort level from BYOK config. Mapped to provider-specific
     *  providerOptions (anthropic.thinking, google.thinkingConfig, etc). */
    reasoningEffort?: ReasoningEffort;
    /** Raw JSON override for reasoning config — takes precedence over effort preset. */
    reasoningConfigOverride?: string;
    /** BYOK provider type — needed to map reasoning effort to the correct
     *  provider-specific format in providerOptions. */
    byokProvider?: BYOKProvider | string;
    /** Model id for this attempt, as `provider:model`. The provider alone is
     *  not enough to shape the reasoning payload: Anthropic changed its
     *  thinking API twice, and each generation rejects the others' shape. */
    modelName?: string;
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
    byokConfig?: NormalizedModel;
    /** An already-built model to run instead of resolving one from `byokConfig`.
     *  Eval-only seam for transports no BYOK slot can express (the Codex
     *  subscription). Production leaves it unset; when set it also reaches the
     *  verifier, since finder and verify share one runner. */
    prebuiltModel?: unknown;
    gitHubToken?: string;
    /** Cross-repo linked-repo access for agent tools (#1576). */
    linkedRepoAccess?: LinkedRepoAccess;
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
    /** New findings each extra finder pass contributed (synthesis-rescue,
     *  critical-file, heavy resample). Attribution the merged total hides: a
     *  pass costing a full run and adding nothing looks identical otherwise. */
    /** What the shard's planning step produced, so an empty shard is legible:
     *  which source fed it, how many sites survived, how many workers ran. */
    shardPlan?: {
        source: string;
        sites: number;
        workers: number;
        cap: number;
        perWorker: number;
    };
    recallPasses?: Array<{
        label: string;
        added: number;
        steps: number;
        toolCalls: number;
        fullFileReads: number;
    }>;
    /** What the scout flagged (scoutInvestigator), kept even for flags the
     *  investigator later cleared with no finding — lets a miss be diagnosed
     *  as "never suspected" vs "suspected and still not confirmed". */
    scoutFlags?: Array<{ relevantFile: string; hint: string }>;
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
