/**
 * code-review (domain) — Finder agent assembled on agent-harness.
 *
 * Step 1+2 of the strangler: compose the real finder as an AgentSpec over the
 * new runner (prompt + tool registry + the 3 prepareStep policies + coverage
 * gate), and extract the structured findings from the RunState.
 *
 * This is pure composition of already-tested primitives — no new loop, no new
 * concern. It runs ALONGSIDE the legacy agent (behind a flag, next step); the
 * legacy path is untouched.
 */
import type {
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { Compressor } from '@libs/agent-harness/domain/contracts/compression.contract';
import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import type {
    RunState,
    TokenUsage,
} from '@libs/agent-harness/domain/contracts/run-state.contract';
import type {
    AgentTool,
    ToolContext,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import { runVerificationPass } from '@libs/agent-harness/infrastructure/orchestration/verification-pass';
import { BudgetPolicy } from '@libs/agent-harness/infrastructure/policies/budget.policy';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import { CompletionGatePolicy } from '@libs/agent-harness/infrastructure/policies/completion-gate.policy';
import { ForceFinalizePolicy } from '@libs/agent-harness/infrastructure/policies/force-finalize.policy';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import { LlmVerifier } from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import { buildToolEvidenceSummary } from '@libs/code-review/infrastructure/agents/core/agent-anomalies';
import { supportsStrictToolsForRun } from '@libs/code-review/infrastructure/agents/core/model-strictness';
import type { ToolEvidenceSummary } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import type { Verdict } from '@libs/agent-harness/domain/contracts/verifier.contract';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';
// Domain helper relocated out of the legacy file (Zod validation of findings).
import { sanitizeFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';
import { LLM } from '@libs/llm/llm';
import { extractJsonFromText } from '@libs/llm/structured-output-repair';
import { collapseNearDuplicates } from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';
import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    buildExpertRolePrompt,
    buildExpertArbitrationPrompt,
    buildSkepticArbitrationPrompt,
    type ExpertRole,
} from '@libs/code-review/infrastructure/agents/core/expert-panel';
import {
    buildPlanPrompt,
    buildShardWorkerPrompt,
    groupSites,
    parseSignals,
    MAX_SELECTORS,
    SITES_PER_WORKER,
    type Selector,
    type SignalSite,
} from '@libs/code-review/infrastructure/agents/core/selector-shard';
import {
    buildScoutPrompt,
    buildInvestigatorPrompt,
    buildMultiFlagInvestigatorPrompt,
    groupFlagsByFile,
    buildInvestigatorChallengePrompt,
    buildInvestigatorSecondLookPrompt,
    buildFreeformPrompt,
    runScoutResample,
    runScoutSecondRound,
    runScoutByCategory,
    MAX_SCOUT_FLAGS,
    CATEGORY_SCOUT_CAP,
    type ScoutFlag,
    type ScoutCategory,
} from '@libs/code-review/infrastructure/agents/core/scout-investigator';
import { z } from 'zod';

export const FINDER_DONE_TOOL = 'submitResult' as const;

const finderLogger = createLogger('finder');

/** HEAVY mode: extra finder re-runs on top of the base pass (resampling for
 *  recall). 2 → 3 total runs, the offline+self-hosted-validated saturation point.
 *  The one heavy knob likely worth surfacing in a future web "advanced" config;
 *  everything else (dedup, threshold, temperature) is a fixed engine decision. */
const HEAVY_RESAMPLE_EXTRA_RUNS = 2;

/** A single finding as produced by the finder (matches the legacy
 *  FindingsOutput.suggestions item shape). */
export interface FinderSuggestion {
    relevantFile: string;
    language?: string;
    label?: 'bug' | 'security' | 'performance';
    suggestionContent: string;
    existingCode: string;
    improvedCode: string;
    oneSentenceSummary?: string;
    relevantLinesStart?: number;
    relevantLinesEnd?: number;
    severity?: 'critical' | 'high' | 'medium' | 'low';
    confidence?: number;
    ruleUuid?: string;
}

/** JSON schema for submitResult — mirrors the legacy _findingsSchema. */
const SUBMIT_RESULT_SCHEMA: JSONSchema = {
    type: 'object',
    // additionalProperties:false on every object is required by provider strict
    // tool use / structured output modes. Harmless in best-effort mode; optional
    // properties are still allowed.
    additionalProperties: false,
    properties: {
        reasoning: { type: 'string' },
        suggestions: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    relevantFile: { type: 'string' },
                    language: { type: 'string' },
                    label: {
                        type: 'string',
                        enum: ['bug', 'security', 'performance'],
                    },
                    suggestionContent: { type: 'string' },
                    existingCode: { type: 'string' },
                    improvedCode: { type: 'string' },
                    oneSentenceSummary: { type: 'string' },
                    relevantLinesStart: { type: 'number' },
                    relevantLinesEnd: { type: 'number' },
                    severity: {
                        type: 'string',
                        enum: ['critical', 'high', 'medium', 'low'],
                    },
                    confidence: { type: 'number' },
                    ruleUuid: { type: 'string' },
                },
                required: [
                    'relevantFile',
                    'suggestionContent',
                    'existingCode',
                    'improvedCode',
                ],
            },
        },
    },
    required: ['reasoning', 'suggestions'],
};

/** The done tool. No-op execute: it is a finalize SIGNAL the CompletionGatePolicy
 *  detects by name; its input (the findings) is captured in the RunState.
 *  Exported so the overhead estimator (core-agent-loop.adapter) counts its
 *  schema — buildFinderAgentSpec always adds it to the model's tool set, so it
 *  is real per-request overhead. */
export const submitResultTool: AgentTool = {
    name: FINDER_DONE_TOOL,
    description:
        'Submit your final findings and end the review. Call this once you have investigated the changed code.',
    inputSchema: SUBMIT_RESULT_SCHEMA,
    execute: async () => ({ output: 'submitted' }),
};

export interface BuildFinderSpecParams {
    systemPrompt: string;
    modelId: string;
    /** The runtime failover target's model id, when the resolved slot has one.
     *  Strict tool use is only enabled when BOTH this and `modelId` support it —
     *  a strict tool built for the primary but swapped onto a non-strict fallback
     *  (e.g. Gemini → OpenAI) is rejected by the fallback's Structured Outputs. */
    fallbackModelId?: string;
    /** Investigation tools (grep/readFile/...) from buildFinderToolRegistry. */
    tools: ToolRegistry;
    coverageLedger: ProgressLedger;
    compressor?: Compressor;
    maxSteps?: number;
    /** Provider options (reasoning/thinking config) forwarded to the model. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** Cost-span run name for this finder's leaf model calls (e.g.
     *  `code-review-bug`). Buckets the usage span to `review` in `deriveArea`.
     *  Defaults to `code-review` (still `review`) when unset. */
    usageRunName?: string;
    /** Cost-span agentName (the review agent's identity name). */
    agentName?: string;
    /** Provider options attached to the system message (e.g. Anthropic prompt
     *  caching) so the long system prompt is cached across the loop's steps. */
}

export function buildFinderAgentSpec(params: BuildFinderSpecParams): AgentSpec {
    const tools = new InMemoryToolRegistry([
        ...params.tools.list(),
        // Enable strict/structured tool calling on the done-tool for
        // strict-capable models (Gemini VALIDATED mode) so the findings payload
        // can't be omitted or emitted as prose. Best-effort otherwise. NOT
        // enabled for Anthropic — see model-strictness.ts (it craters recall).
        // Considers the failover target too: a strict tool built for a Gemini
        // primary must NOT be sent to an OpenAI fallback (it rejects the schema).
        {
            ...submitResultTool,
            strict: supportsStrictToolsForRun(
                params.modelId,
                params.fallbackModelId,
            ),
        },
    ]);

    const policies = [
        new BudgetPolicy(),
        ...(params.compressor
            ? [new CompressionPolicy(params.compressor)]
            : []),
        new CompletionGatePolicy(params.coverageLedger, {
            doneToolName: FINDER_DONE_TOOL,
        }),
        // Ports the legacy "force-text": in the last steps, restrict to the done
        // tool so the agent finalizes instead of running out of steps with
        // nothing submitted (which would lose all findings).
        new ForceFinalizePolicy({ doneToolName: FINDER_DONE_TOOL }),
    ];

    return {
        id: 'finder',
        // Cost-span identity: LLM.run records the ONE usage span per model call
        // with this runName; `deriveArea` buckets `code-review*` under `review`.
        runName: params.usageRunName ?? 'code-review',
        agentName: params.agentName,
        phase: 'review',
        systemPrompt: params.systemPrompt,
        tools,
        policies,
        maxSteps: params.maxSteps ?? 20,
        // CAPTURE concern: the runner materializes submitResult's payload into
        // RunState.artifacts. Stopping ON submitResult is the CompletionGatePolicy's
        // doneToolName concern — same tool, distinct roles.
        resultToolName: FINDER_DONE_TOOL,
        providerOptions: params.providerOptions,
    };
}

/** Extract findings from a finished run by reading the run's materialized
 *  artifacts (the "result tool" convention — the runner captures every
 *  submitResult call into RunState.artifacts in step order). The LAST artifact
 *  is the finder's final output. Falls back to [] if the agent never finalized
 *  (budget-exhausted). No hand re-scan of steps — that is the runner's job. */
export function extractFindings(state: RunState): {
    reasoning: string;
    suggestions: FinderSuggestion[];
} {
    // 1. The result-tool artifact (submitResult), latest first, Zod-validated.
    const artifact = [...state.artifacts]
        .reverse()
        .find((a) => a.type === FINDER_DONE_TOOL);
    // OBSERVABILIDADE: "zero findings" tem TRES causas distintas aqui e nenhuma
    // era registrada — artefato valido com lista vazia, artefato inutilizavel
    // (submitResult({}) vazio ou prosa), e artefato ausente. Sem isto, o numero
    // publicado nao distingue "revisou e nao achou" de "quebrou o formato".
    (state as any).__findingsOutcome = !artifact
        ? 'no-artifact'
        : sanitizeFindingsResult(artifact.payload as any)
          ? 'structured'
          : 'artifact-unusable';
    if (artifact) {
        const clean = sanitizeFindingsResult(artifact.payload as any);
        if (clean) {
            return {
                reasoning: clean.reasoning ?? '',
                suggestions: (clean.suggestions ?? []) as FinderSuggestion[],
            };
        }
        // Artifact present but unusable — either empty args (e.g. Gemini
        // `submitResult({})`) or, for Anthropic, the model wrote its findings as
        // PROSE in `reasoning` and omitted `suggestions`. Preserve that prose so
        // a downstream fallback-LLM can re-structure it into findings; otherwise
        // those (real) findings are silently lost.
        const proseReasoning =
            typeof (artifact.payload as { reasoning?: unknown })?.reasoning ===
            'string'
                ? ((artifact.payload as { reasoning: string }).reasoning ?? '')
                : '';
        return (
            findingsFromText(state) ?? {
                reasoning: proseReasoning,
                suggestions: [],
            }
        );
    }
    // 2. Fallback: the model answered in TEXT instead of calling submitResult
    //    (or called it empty). Recover the findings JSON from its final text.
    return findingsFromText(state) ?? { reasoning: '', suggestions: [] };
}

/** Recover findings from the model's final text — covers "answered in prose/JSON
 *  instead of calling submitResult" and empty-arg submitResult. */
function findingsFromText(state: RunState): {
    reasoning: string;
    suggestions: FinderSuggestion[];
} | null {
    for (let i = state.steps.length - 1; i >= 0; i--) {
        const text = state.steps[i].message.content;
        if (typeof text !== 'string' || !text.trim()) {
            continue;
        }
        const json = extractJsonFromText(text);
        if (!json) continue;
        try {
            const clean = sanitizeFindingsResult(JSON.parse(json));
            if (clean) {
                return {
                    reasoning: clean.reasoning ?? '',
                    suggestions: (clean.suggestions ??
                        []) as FinderSuggestion[],
                };
            }
        } catch {
            // not valid JSON in this step — try an earlier one
        }
    }
    // KNOWN LIMITATION (E) — total parse failure under-reports SILENTLY: no step
    // held extractable JSON. The caller falls to prose recovery
    // (recoverFindingsFromProse), which also returns [] when the prose doesn't read
    // like findings. If BOTH miss, the finder's findings are dropped with no
    // counter/log — a review can silently under-report. Accepted for now; a
    // parse-failure metric would make the drop observable.
    return null;
}

// ─── Prose-findings recovery (fallback LLM) ─────────────────────────────────
// When the finder writes its findings as PROSE (in `reasoning`) and omits the
// structured `suggestions` array — the dominant Anthropic failure mode — the
// findings are otherwise lost. A cheap internal LLM re-structures that prose
// into findings. This does NOT constrain the finder (unlike strict tool use,
// which craters recall); it only recovers what the model already found.

/** Cheap gate: only pay for the recovery LLM when the prose actually reads like
 *  code-review findings (file/line refs + issue verbs), not investigation notes. */
function looksLikeFindings(text: string): boolean {
    if (!text || text.length < 80) return false;
    const l = text.toLowerCase();
    const signals = [
        /\b(bug|issue|vulnerabilit|race|leak|npe|null|missing|incorrect|unsafe|injection|overflow|deadlock|toctou)\b/,
        /\b(should|must|fix|instead|because|so that|would)\b/,
        /(\.(ts|tsx|js|jsx|go|rb|py|java|rs|kt)\b|:\d+|line\s*\d+)/,
    ];
    return signals.filter((r) => r.test(l)).length >= 2;
}

const RECOVERY_SCHEMA = z.object({
    suggestions: z.array(
        z.object({
            relevantFile: z.string(),
            suggestionContent: z.string(),
            existingCode: z.string(),
            improvedCode: z.string(),
            language: z.string().nullable(),
            label: z.string().nullable(),
            oneSentenceSummary: z.string().nullable(),
            relevantLinesStart: z.number().nullable(),
            relevantLinesEnd: z.number().nullable(),
            severity: z.string().nullable(),
            confidence: z.number().nullable(),
        }),
    ),
});

/** Injected capability: re-structure a prose `reasoning` into findings. The
 *  domain (finder/recall passes) depends only on this function; the adapter
 *  wires it to the concrete internal-model fallback. Undefined = recovery off. */
export type ProseRecoverer = (reasoning: string) => Promise<FinderSuggestion[]>;

/** Extract findings from a run, and — if the model produced NONE but wrote
 *  finding-like prose in `reasoning` (the Anthropic omission mode) — recover
 *  them via the injected recoverer. Applied at EVERY extraction seam (main
 *  finder + each recall pass) so an omission in any pass is caught. */
export async function extractFindingsWithRecovery(
    state: RunState,
    recover?: ProseRecoverer,
): Promise<FinderFindings> {
    const found = extractFindings(state);
    if (found.suggestions.length > 0 || !recover) return found;
    const recovered = await recover(found.reasoning);
    return recovered.length > 0
        ? { reasoning: found.reasoning, suggestions: recovered }
        : found;
}

export async function recoverFindingsFromProse(
    prose: string,
    byokConfig: NormalizedModel | undefined,
    organizationId: string | undefined,
    usageRunName?: string,
): Promise<FinderSuggestion[]> {
    if (!looksLikeFindings(prose)) return [];
    try {
        // ONE primitive: LLM.run resolves the slot (or managed default), owns the
        // span + the json_schema→json_object fallback the recovery pass needs, and
        // returns the parsed object. The runName buckets this recovery call's
        // usage span to `review` (deriveArea) alongside the finder/verify calls —
        // it is part of the same review, not a separate `other` area.
        const result = await LLM.run({
            byokConfig,
            schema: RECOVERY_SCHEMA,
            user:
                "The following is a code reviewer's analysis written as " +
                'prose. Extract EVERY concrete finding it describes into ' +
                'the structured schema — one entry per distinct issue, ' +
                'using the file paths and line numbers mentioned. Do NOT ' +
                'invent findings; only extract what is explicitly ' +
                `described.\n\nANALYSIS:\n${prose}`,
            runName: usageRunName
                ? `${usageRunName}-recovery`
                : 'code-review-recovery',
            organizationId,
        });
        return (result.suggestions as unknown as FinderSuggestion[]) ?? [];
    } catch {
        // Best-effort: recovery must never break the review.
        return [];
    }
}

// ─── Finder + Verify (parity orchestration on the SAME runner) ──────────────

export interface RunFinderWithVerifyParams {
    runner: AgentRunner;
    finderSpec: AgentSpec;
    /** Experiment knob (default off): skip the base/generalist finder pass
     *  entirely — no LLM call, base contributes an empty {reasoning: '',
     *  suggestions: []} and a synthetic empty RunState. Final findings then
     *  come ONLY from whatever recall passes are configured (e.g.
     *  expertRoles + expertArbitrate) — for measuring whether an extra pass
     *  could stand on its own instead of layering on the generalist. Passes
     *  that reuse the base's own tool-call trail (secondLookSameFile,
     *  challengeDismissals) have nothing to reuse in this mode — don't
     *  combine with those. */
    skipBasePass?: boolean;
    /** Factory for a fresh finder spec (own coverage ledger) per concurrent
     *  heavy resample pass — see RecallPassesParams.makeResampleSpec. */
    makeResampleSpec?: () => AgentSpec;
    /** Factory for critical-file / atomic-hunk passes — same fresh-ledger
     *  contract as makeResampleSpec, but typically built with a lower maxSteps
     *  (these passes see far less content). Falls back to makeResampleSpec when
     *  unset, so existing callers keep working unchanged. */
    makeCriticalFileSpec?: () => AgentSpec;
    /** Model id for the verifier runs. */
    modelId: string;
    /** Failover target model id — threaded to the verifier so its strict tool
     *  use accounts for the failover model (Gemini→OpenAI must not send strict). */
    fallbackModelId?: string;
    /** Investigation tools shared with the verifier. */
    tools: ToolRegistry;
    /** Verify concurrency (default 4). */
    concurrency?: number;
    /** Provider options (reasoning/thinking config) forwarded to verifier runs. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** System-message provider options (e.g. Anthropic prompt caching), forwarded
     *  to the finder spec and the verifier runs. */
    /** Skip the recall pass entirely (fast mode / self-contained trial). */
    skipHeavyPasses?: boolean;
    /** Skip ONLY the synthesis-rescue pass. */
    skipSynthesisRescue?: boolean;
    /** HEAVY mode: run an EXTRA "what did you miss?" critic pass (on top of the
     *  synthesis-rescue) that re-scans for missed bugs. Opt-in per review — more
     *  recall at ~+1 finder pass of cost. Off by default. */
    heavy?: boolean;
    /** Files that get their own single-file pass, each with its own diff.
     *  Empty/undefined disables the passes. */
    criticalFiles?: Array<{ path: string; diff: string }>;
    /** Dedicated (diff-free — the caller injects the file/hunk's own diff)
     *  base for critical-file/atomic-hunk/atomic-file passes — A/B knob
     *  `criticalFileDedicatedPrompt`, see buildCriticalFilePrompt's doc for
     *  the confound this fixes and core-agent-loop.adapter.ts's
     *  CRITICAL_FILE_DEDICATED_BASE for what it contains. Undefined = these
     *  passes keep using the full userPrompt (old behavior). */
    criticalFileBasePrompt?: string;
    /** Roles for the expert-panel pass (see expert-panel.ts). Empty/undefined
     *  disables the panel entirely. */
    expertRoles?: ExpertRole[];
    /** Dedicated base for expert-panel role + arbitration prompts — same idea
     *  as scoutBasePrompt/freeformBasePrompt: the first cut of
     *  expertRoles/recognitionPanel had every role (and arbitration) read
     *  the FULL generalist userPrompt underneath its lens, same confound the
     *  scout had before scoutDedicatedPrompt/scoutCalibratedPrompt.
     *
     *  MEASURED (10 PRs) and corrected: a first, bare-diff-only version broke
     *  output — these are FULL AGENT-LOOP passes that report via the
     *  submitResult TOOL, not a schema-forced one-shot call like the scout,
     *  and stripping the full prompt's <OutputFormat> section lost the
     *  instruction that a concluded verdict must become a structured
     *  suggestion. See core-agent-loop.adapter.ts:expertPanelDedicatedBase
     *  for the corrected version (diff + category definitions + an explicit
     *  output-format reminder). Undefined = role/arbitration prompts keep
     *  using userPrompt (old behavior). */
    expertPanelBasePrompt?: string;
    /** true (default) = role passes go through the arbitration/cross-exam
     *  step; false = each role merges DIRECTLY into the pool (union, no
     *  cross-examination) — cheaper, no debate mechanism, A/B knob. */
    expertArbitrate?: boolean;
    /** A/B knob (default off, requires expertRoles + expertArbitrate): swaps
     *  the neutral arbitration prompt for buildSkepticArbitrationPrompt —
     *  more adversarial, and runs even on an all-silent panel. Pairs with
     *  expert-panel.ts's RECOGNITION_PANEL_ROLES (caller's job to pass those
     *  as expertRoles; this flag only selects the arbitration prompt).
     *  MEASURED (20 PRs, standalone — replacing the generalist, not layered
     *  on top) and discarded: F1 0.361, well below the reference config —
     *  see review-agent.contract.ts's recognitionPanel doc for the full
     *  golden-by-golden comparison (19 of 20 panel findings were already
     *  covered by the reference; only 1 was unique). */
    recognitionPanel?: boolean;
    /** Enable the scout → deep-investigator pass (see scout-investigator.ts).
     *  Requires `runScout` — a no-op without it. */
    scoutInvestigator?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): run the scout in
     *  SCOUT_RESAMPLE_ROUNDS sequential, context-aware rounds (each capped at
     *  SCOUT_ROUND_CAP) instead of one round capped at MAX_SCOUT_FLAGS. */
    scoutResample?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): run the scout in
     *  exactly TWO rounds instead of one — round 1 UNCHANGED (cap
     *  MAX_SCOUT_FLAGS, same as the default single-scout path), then ONE
     *  follow-up round capped at SCOUT_ROUND_CAP via buildScoutFollowUpPrompt
     *  (shown round 1's flags, asked for OTHER spots, empty list explicitly
     *  allowed). Isolates the two variables scoutResample conflated when it
     *  was measured negative: shrinking round 1's cap AND adding two extra
     *  rounds. This changes neither — round 1 stays at 5, only one round is
     *  added. Mutually exclusive with scoutResample; scoutResample wins if
     *  both are set (see the scout dispatch below). Not yet measured. */
    scoutSecondRound?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): ask the scout for the
     *  approximate diff line each flag is anchored to, and pass it on to the
     *  investigator as a concrete starting point. Aimed at the "reached the
     *  right FILE but drifted to a different part of it" failure mode a 30-PR
     *  trace audit found (see challengeDismissals) — a file-only hint doesn't
     *  say where to start looking. MEASURED (5 PRs) and discarded: recall was
     *  IDENTICAL to no-line-hint on every single case (found zero new true
     *  positives), while precision dropped 77%→62% (more findings reported,
     *  same ones real). The anchor didn't help the investigator see anything
     *  new — it just made it more confident about noise. Kept as a flag (off),
     *  not deleted, in case a future model benefits — not a validated config. */
    scoutLineHint?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): the scout names a
     *  SPECIFIC, falsifiable HYPOTHESIS for the defect (not a vague "worth a
     *  look" flag), and the investigator's job becomes confirm-or-refute that
     *  exact hypothesis instead of an open-ended investigation of the area
     *  — see buildScoutPrompt/buildInvestigatorPrompt's docs. Inspired by
     *  Greptile v5's "swarm of agents, each exploring one hypothesis"
     *  framing. Inverts a design assumption this session never actually
     *  tested (the scout's doc argued naming a mechanism early would just
     *  pay for a cheaper copy of the same connection failure) — worth
     *  testing directly given the ceiling audit found that connection
     *  failure, not under-investigation, is the dominant miss pattern.
     *  MEASURED (30 PRs) and discarded: F1 0.409 vs the 0.432 reference —
     *  see review-agent.contract.ts's hypothesisDriven doc for the full
     *  result (looked better at 20 PRs, reversed on the final 10). */
    hypothesisDriven?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): when 2+ scout flags
     *  land on the same file, ONE investigator pass investigates all of them
     *  together instead of N separate full agent-loop passes — see
     *  scout-investigator.ts:buildMultiFlagInvestigatorPrompt for the cost
     *  rationale and the risk it tests (an explicit "equal depth" instruction
     *  is a request, not a guarantee). challengeDismissals/secondLookSameFile
     *  are skipped for merged groups (their prompts assume one prior
     *  suspicion). MEASURED (30 PRs) and discarded: F1 0.371 vs the 0.432
     *  reference — the "equal depth" instruction likely doesn't hold in
     *  practice (one investigation split across 2+ flags gets shallower per
     *  flag than a dedicated pass each). */
    investigatorGroupByFile?: boolean;
    /** A/B knob (default off = MAX_SCOUT_FLAGS, requires scoutInvestigator):
     *  overrides the default single-scout cap (5). Cost experiment — the
     *  investigator is the dominant cost driver (~57% of total tokens on the
     *  champion config, one full agent-loop pass per flag), so fewer flags
     *  should cut cost roughly linearly. Only cap 10 (worse) has been tested
     *  in either direction so far; a lower cap is untested. Only applies to
     *  the default single-scout path, not scoutResample/scoutSecondRound/
     *  scoutByCategory (those have their own caps). Not yet measured. */
    scoutCap?: number;
    /** A/B knob (default off, requires scoutInvestigator): when an investigator
     *  pass clears its flag (0 added findings) after articulating real reasoning,
     *  run ONE follow-up pass that feeds that reasoning back and asks it to argue
     *  the opposite case before finalizing. Measured root cause (30-PR trace
     *  audit): of the goldens an investigator reached but still missed, ~55% were
     *  cases where it explicitly considered and talked itself out of the exact
     *  concern — not cases it never looked at. Deliberately narrower than "force
     *  every flag to produce a finding" (that pattern — more forced output,
     *  scout cap 10 / 3-category-scouts / resample — consistently tanked BOTH
     *  recall and precision every time it was tried this session): this only
     *  reopens a dismissal the pass itself already engaged with, and it can
     *  still end in an empty array. */
    challengeDismissals?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): when an investigator
     *  pass clears its flag (0 added) after making at least one tool call, run
     *  ONE follow-up pass that recaps its own tool-call trail (no re-reading)
     *  and asks whether the SAME FILE has any OTHER defect unrelated to the
     *  flagged concern. Distinct from challengeDismissals: challenge re-argues
     *  the same suspicion; this drops it and asks about a different one — see
     *  scout-investigator.ts:buildInvestigatorSecondLookPrompt for the root
     *  cause it targets.
     *
     *  MEASURED on a 5-PR sample first and looked like a clear loss (recall
     *  51%→41%, precision 77%→34%) — but that 5-PR baseline itself was an
     *  unusually easy subset (its OWN baseline recall/precision run well above
     *  the 30-PR baseline). Re-measured on the full 30-PR set: recall
     *  32.4%→40.8% (+8.4pp), precision 43.8%→44.2% (flat/slightly up), F1
     *  0.372→0.424 — the single best result of this investigation, at +18%
     *  tool-call cost (164→193 avg). Validated config, the direction being
     *  pursued — see secondLookAlways below for the variant that WAS dropped
     *  (that one roughly doubled cost for no confirmed additional gain). */
    secondLookSameFile?: boolean;
    /** A/B knob (default off, requires secondLookSameFile): fire the second
     *  look on EVERY investigator pass that made a tool call, not only the
     *  ones that cleared their flag (added === 0). Targeted the same
     *  blind-spot failure mode as secondLookSameFile, just not gated on
     *  finding nothing first — MEASURED on a small, interrupted, Keycloak-
     *  heavy sample (7 of 30 cases, run killed early on cost grounds) at
     *  ~14% recall — but every one of those low-scoring cases ALSO scored 0%
     *  under the validated secondLookSameFile config, confirming it is a hard
     *  subsample, not a regression this knob caused. Never reached a real
     *  30-PR verdict — abandoned before that for the same cost reason as
     *  secondLookSameFile (this variant is even more expensive: closer to 2×
     *  the investigator passes instead of the already-costly +18%). Kept as a
     *  flag, not a validated or recommended config. */
    secondLookAlways?: boolean;
    /** A/B knob (default off, requires secondLookSameFile): removes the
     *  "submit empty" escape hatch — forces the pass to name its single most
     *  plausible candidate instead. See
     *  scout-investigator.ts:buildInvestigatorSecondLookPrompt's doc for the
     *  rationale (61% of secondLook calls return empty on the current best
     *  config). Not yet measured. */
    secondLookForceReport?: boolean;
    /** A/B knob (default off): PATH-FEASIBILITY verify — replaces the HV2
     *  refute-to-drop verifier prompt (which keeps ~99% of candidates,
     *  measured 84/85 on the 30-PR light set, so it adds cost without
     *  filtering) with an inverted-burden prompt: a finding is kept only if
     *  the verifier establishes a concrete, unguarded trigger path by reading
     *  the code. LLM4PFA-style (arXiv 2601.18844: precision 0.26→0.93,
     *  recall preserved). Applies to both the main verify and the
     *  evidence-gate re-verify. Not yet measured on our set. */
    feasibilityVerify?: boolean;
    /** A/B knob (default off): skip the verify stage entirely. Measured across
     *  5 models on the 30-PR light set, verify kept 1,100 of 1,120 candidates
     *  (1.8% dropped, 0 by the evidence gate) while costing one tool-using LLM
     *  call PER finding — it is the most expensive stage that changes almost
     *  nothing. Pairs with the reducer, which judges the whole candidate set at
     *  once and can drop with global context the per-finding verifier never
     *  had. Not yet measured end-to-end. */
    skipVerify?: boolean;
    /** A/B knob (default off): run the scout chain (scout → investigators →
     *  second look) CONCURRENTLY with the base pass instead of after it. The
     *  chain reads neither the base findings nor its RunState — the ordering
     *  was incidental, and serialising them adds the whole chain to wall-clock
     *  for nothing. Behavior-identical: same passes, same prompts, same merge;
     *  only the schedule changes. */
    parallelScout?: boolean;
    /** A/B knob (default off): PLAN → SHARD. An LLM pass extracts the symbols
     *  the diff changed, those are grepped across the REPOSITORY, and one pass
     *  per group of call sites asks whether the change breaks them. The only
     *  mechanism we have that reads code OUTSIDE the diff — see
     *  selector-shard.ts. Needs real repo search (RECALL_REAL_REPO=1); with
     *  recorded fixtures the greps return nothing by construction. */
    selectorShard?: boolean;
    /** Injected repo-wide search (the eval wires it to the sandbox/worktree).
     *  Undefined = selectorShard is a no-op. */
    runGrep?: (pattern: string) => Promise<string>;
    /** Injected plan call — same decoupling as runScout. */
    runPlan?: (prompt: string, cap: number) => Promise<Selector[]>;
    /** Shard sites resolved from the AST blast radius instead of plan+grep.
     *  When present, `runPlan` and `runGrep` are not called at all. */
    graphSites?: SignalSite[];
    /** A second rendering of the user prompt — same diff, files in a different
     *  order — used to run the shard branch a second time.
     *
     *  Four runs of the identical config find the same 34 goldens give or take
     *  two, but which two moves: 20 goldens appear in one run and not another.
     *  That headroom is real (the union of four reaches 46%) and no structural
     *  change has ever touched it. Re-ordering decorrelates the second draw on
     *  purpose instead of hoping sampling noise does it: file order decides
     *  what sits early in the context, and the plan picks its symbols from
     *  there. Only the shard branch repeats — the generalist runs once. */
    shardAltPrompt?: string;
    /** Dedicated base for the shard workers, replacing the generalist's user
     *  prompt. See review-agent.contract.ts:shardDedicatedPrompt. */
    shardBasePrompt?: string;
    /** One narrow pass per class of defect, each with its own prompt AND its
     *  own spec (so it does not inherit the generalist's system prompt).
     *  Built by the adapter from core/micro-agents.ts. */
    microAgentPasses?: Array<{
        label: string;
        prompt: string;
        spec: AgentSpec;
    }>;
    /** Total shard sites per PR, and how many share one worker. Defaults to
     *  MAX_SELECTORS / SITES_PER_WORKER. */
    shardCap?: number;
    shardPerWorker?: number;
    /** Run the shard ONLY on graph-derived sites. Without this, a PR whose
     *  blast radius is empty silently falls back to plan+grep, which makes
     *  "replace the plan with the graph" unmeasurable: the first run of it
     *  fired 79 shard passes over 28 PRs instead of the 31 over 17 the graph
     *  actually supplies. Product code may still want the fallback; an
     *  experiment isolating the graph must not have it. */
    graphSitesOnly?: boolean;
    /** Paths in this PR's diff, so signals inside the diff are dropped. */
    changedFilePaths?: string[];
    /** A/B knob (default off): one independent full pass with a minimal,
     *  unstructured prompt — see scout-investigator.ts:buildFreeformPrompt.
     *  Not yet measured. */
    freeformPass?: boolean;
    /** Minimal diff-only base for the scout's prompt (A/B knob
     *  scoutDedicatedPrompt), pre-built by the adapter from changedFiles —
     *  decoupled the same way runScout is, since finder.agent.ts doesn't know
     *  about FileChange shapes. Undefined = scout keeps using userPrompt. */
    scoutBasePrompt?: string;
    /** A/B knob: three parallel scouts (bug/performance/security), each with
     *  its OWN base from `scoutCategoryBasePrompts` — see
     *  RunFinderWithVerifyParams (contract copy) in review-agent.contract.ts
     *  for the full rationale. Requires scoutCategoryBasePrompts; ignored
     *  otherwise. */
    scoutByCategory?: boolean;
    /** Per-category bases for scoutByCategory (diff + only that category's
     *  definitions), pre-built by the adapter from changedFiles — same
     *  decoupling as scoutBasePrompt. Undefined = scoutByCategory has nothing
     *  to run even if the flag is set. */
    scoutCategoryBasePrompts?: Record<ScoutCategory, string>;
    /** Same idea as scoutBasePrompt, for freeformPass: the first attempt at
     *  this A/B knob still prepended the FULL rule-laden userPrompt underneath
     *  the "ignore every rule above" line — not a genuinely different style,
     *  just the same prompt with a note on top. Undefined = freeform keeps
     *  using userPrompt (old behavior). */
    freeformBasePrompt?: string;
    /** Injected one-shot scout call (see scout-investigator.ts:runScout,
     *  pre-bound to byokConfig/organizationId by the adapter) — decoupled from
     *  BYOK the same way `recoverProse` is. Undefined = scout disabled even if
     *  `scoutInvestigator` is set. */
    runScout?: (
        prompt: string,
        category?: ScoutCategory,
        cap?: number,
    ) => Promise<ScoutFlag[]>;
    /** Langfuse telemetry context (org/team/PR/repo) — names the finder, recall
     *  and per-finding verify observations so the trace is attributable. */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** Agent name (finder/security/...) — prefixes every observation name. */
    agentName?: string;
    /** Cost-span run name base (e.g. `code-review-bug`) forwarded to the verifier
     *  runs so their leaf usage spans bucket to `review` in `deriveArea`. */
    usageRunName?: string;
    /** Injected prose-findings recovery capability (see ProseRecoverer). The
     *  adapter wires it to the internal-model fallback; omit to disable. */
    recoverProse?: ProseRecoverer;
}

export interface VerifyUsage {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    cacheReadTokens: number;
}

export interface FinderWithVerifyResult {
    reasoning: string;
    /** Counts from the shard's planning step (source, sites, workers, caps).
     *  Undefined when the shard did not run at all — which is a different
     *  state from running and finding nothing. */
    shardPlan?: {
        source: string;
        sites: number;
        workers: number;
        cap: number;
        perWorker: number;
    };

    kept: FinderSuggestion[];
    /** Per-finding verifier tool evidence for the KEPT findings (same order as
     *  `kept`): which files the verifier itself read/grepped while judging each.
     *  Empty summary when the verifier used no tools for that finding. */
    keptEvidence: ToolEvidenceSummary[];
    droppedByVerify: Array<{
        finding: FinderSuggestion;
        evidence?: string;
        verifierEvidence: ToolEvidenceSummary;
    }>;
    /** The finder's RunState (for usage/steps/trace mapping by callers). */
    finderState: RunState;
    /** Token usage of the verify sub-step (sum across verifier runs). The
     *  finder's own usage is in finderState.usage; this is reported separately
     *  so callers can attribute cost — it is NOT in finderState. */
    verifyUsage: VerifyUsage;
    /** Token usage of the recall pass (the extra synthesis-rescue finder run).
     *  NOT in finderState — summed here so the caller can add it to the finder
     *  cost. */
    recallUsage: VerifyUsage;
    /** New findings contributed by each extra pass (synthesis / critical-file /
     *  heavy resample), so a pass that pays for itself can be told from one
     *  that doesn't. */
    passStats: RecallPassStat[];
    /** See RecallPassesParams return — what the scout flagged, kept even for
     *  flags the investigator later cleared. */
    scoutFlags: ScoutFlag[];
}

const ZERO_VERIFY_USAGE: VerifyUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
};

/** Synthetic empty RunState for `skipBasePass` — no run ever happened, so
 *  there is nothing to report beyond a valid, empty shape. */
const EMPTY_BASE_FINDER_STATE: RunState = {
    runId: 'skip-base-pass',
    agentId: 'skip-base-pass',
    status: 'completed',
    steps: [],
    artifacts: [],
    usage: {},
    trace: [],
};

/**
 * Runs the finder, then verifies each finding on the SAME runner (HV2
 * refute-to-drop). This is the parity path with the legacy runAgentLoop
 * (finder + in-loop verify) — but as composition, no second loop.
 */
export async function runFinderWithVerify(
    params: RunFinderWithVerifyParams,
    input: { prompt: string },
    ctx: ToolContext,
): Promise<FinderWithVerifyResult> {
    // parallelScout: kick the scout chain off BEFORE awaiting the base pass.
    // Everything it needs (userPrompt, runScout, makeResampleSpec) is already
    // in params; it never reads base findings or finderState, so it can run
    // while the generalist is still working. Every other recall pass DOES
    // depend on the base, so only this chain is hoisted.
    const scoutChainPromise =
        params.parallelScout && params.scoutInvestigator && params.runScout
            ? runRecallPasses(
                  { reasoning: '', suggestions: [] },
                  {
                      ...params,
                      finderState: EMPTY_BASE_FINDER_STATE,
                      userPrompt: input.prompt,
                      scoutChainOnly: true,
                      skipSynthesisRescue: true,
                      heavy: false,
                      freeformPass: false,
                      criticalFiles: undefined,
                      expertRoles: undefined,
                      recognitionPanel: false,
                  },
                  ctx,
              )
            : null;

    const finderState = params.skipBasePass
        ? EMPTY_BASE_FINDER_STATE
        : await params.runner.run(
              params.finderSpec,
              {
                  ...input,
                  ...toAiSdkTelemetryArgs(
                      buildLangfuseTelemetry(
                          params.agentName ?? 'finder',
                          params.telemetryMetadata,
                      ),
                  ),
              },
              ctx,
          );
    // Main finder findings — with prose-recovery applied (the same wrapper the
    // recall passes use, so an omission in any pass is caught consistently).
    // skipBasePass: no run happened, nothing to recover from — empty findings.
    const base = params.skipBasePass
        ? { reasoning: '', suggestions: [] }
        : await extractFindingsWithRecovery(finderState, params.recoverProse);

    // RECALL PASS: synthesis rescue — one extra finder run that re-thinks from
    // the evidence already gathered and surfaces concrete MISSED bugs BEFORE
    // verify filters, dedup-merged into the candidate set. (Soft coverage: the
    // coverage-recovery + 2nd/3rd-chance passes were removed to match the
    // validated depth-first engine — main pass only, no coverage-forced re-runs.)
    const recall = await runRecallPasses(
        base,
        {
            runner: params.runner,
            finderSpec: params.finderSpec,
            makeResampleSpec: params.makeResampleSpec,
            makeCriticalFileSpec: params.makeCriticalFileSpec,
            finderState,
            userPrompt: input.prompt,
            skipHeavyPasses: params.skipHeavyPasses,
            skipSynthesisRescue: params.skipSynthesisRescue,
            heavy: params.heavy,
            criticalFiles: params.criticalFiles,
            criticalFileBasePrompt: params.criticalFileBasePrompt,
            expertRoles: params.expertRoles,
            expertPanelBasePrompt: params.expertPanelBasePrompt,
            expertArbitrate: params.expertArbitrate,
            recognitionPanel: params.recognitionPanel,
            scoutInvestigator: params.scoutInvestigator,
            scoutResample: params.scoutResample,
            scoutSecondRound: params.scoutSecondRound,
            scoutLineHint: params.scoutLineHint,
            hypothesisDriven: params.hypothesisDriven,
            investigatorGroupByFile: params.investigatorGroupByFile,
            scoutCap: params.scoutCap,
            skipScoutChain: !!scoutChainPromise,
            selectorShard: params.selectorShard,
            runGrep: params.runGrep,
            runPlan: params.runPlan,
            graphSites: params.graphSites,
            shardAltPrompt: params.shardAltPrompt,
            shardBasePrompt: params.shardBasePrompt,
            microAgentPasses: params.microAgentPasses,
            shardCap: params.shardCap,
            shardPerWorker: params.shardPerWorker,
            graphSitesOnly: params.graphSitesOnly,
            changedFilePaths: params.changedFilePaths,
            challengeDismissals: params.challengeDismissals,
            secondLookSameFile: params.secondLookSameFile,
            secondLookAlways: params.secondLookAlways,
            secondLookForceReport: params.secondLookForceReport,
            freeformPass: params.freeformPass,
            freeformBasePrompt: params.freeformBasePrompt,
            scoutBasePrompt: params.scoutBasePrompt,
            scoutByCategory: params.scoutByCategory,
            scoutCategoryBasePrompts: params.scoutCategoryBasePrompts,
            runScout: params.runScout,
            telemetryMetadata: params.telemetryMetadata,
            agentName: params.agentName,
            recoverProse: params.recoverProse,
        },
        ctx,
    );
    // Fold the concurrently-run scout chain back in: same merge the serial path
    // does, just applied once at the end instead of pass by pass.
    if (scoutChainPromise) {
        const scoutChain = await scoutChainPromise;
        recall.findings = mergeSuggestions(recall.findings, scoutChain.findings);
        recall.usage = sumVerifyUsage(recall.usage, scoutChain.usage);
        recall.passStats = [...recall.passStats, ...scoutChain.passStats];
        recall.scoutFlags = [...recall.scoutFlags, ...scoutChain.scoutFlags];
    }
    const reasoning = recall.findings.reasoning;
    // HEAVY: collapse near-duplicate candidates BEFORE verify. The resample
    // re-finds the same bug with different wording — those survive the exact-content
    // merge key and would each cost a (main-model, tool-using) verify call. Collapse
    // by CONTENT similarity (the shared primitive + the engine's calibrated
    // DEDUP_CONTENT_THRESHOLD), NOT by location: two DIFFERENT bugs on the same line
    // have different text → they do NOT collapse (only same-bug paraphrases do).
    // Self-hosted A/B: 12→4 / 11→7 candidates, ~50% fewer verify calls, all distinct
    // bugs preserved. Heavy-only — the normal path has no resample dupes to fold.
    let suggestions = recall.findings.suggestions;
    if (params.heavy) {
        const before = suggestions.length;
        suggestions = collapseNearDuplicates(suggestions);
        if (suggestions.length < before) {
            finderLogger.log({
                message: `[heavy-dedup] collapsed ${before} → ${suggestions.length} candidates before verify`,
                context: 'finder',
                serviceName: 'finder',
            });
        }
    }
    const recallUsage = recall.usage;
    const passStats = recall.passStats;
    const scoutFlags = recall.scoutFlags;
    const shardPlan = recall.shardPlan;

    if (suggestions.length === 0 || params.skipVerify) {
        return {
            reasoning,
            kept: params.skipVerify ? suggestions : [],
            keptEvidence: [],
            droppedByVerify: [],
            finderState,
            verifyUsage: ZERO_VERIFY_USAGE,
            recallUsage,
            passStats,
            shardPlan,
            scoutFlags,
        };
    }

    // Verify each finding (HV2 refute-to-drop, or path-feasibility when the
    // knob is on) with the confidence SPLIT inside LlmVerifier:
    // high-confidence → light depth, low-confidence → full depth.
    const verifier = new LlmVerifier(params.runner, {
        modelId: params.modelId,
        fallbackModelId: params.fallbackModelId,
        tools: params.tools,
        providerOptions: params.providerOptions,
        telemetryMetadata: params.telemetryMetadata,
        agentName: params.agentName,
        usageRunName: params.usageRunName,
        feasibilityMode: params.feasibilityVerify,
    });
    const pass = await runVerificationPass<FinderSuggestion>(
        { candidates: suggestions, verifier, concurrency: params.concurrency },
        ctx,
    );

    let kept = pass.kept;
    let dropped = pass.dropped;
    let gateUsage: VerifyUsage = ZERO_VERIFY_USAGE;

    // Per-finding verifier verdict (carries the verifier's investigation tool
    // calls) so we can attribute per-finding verifier evidence to the trace.
    const verdictByFinding = new Map<FinderSuggestion, Verdict>();
    pass.kept.forEach((f, i) => verdictByFinding.set(f, pass.keptVerdicts[i]));
    pass.dropped.forEach((d) => verdictByFinding.set(d.candidate, d.verdict));

    // EVIDENCE GATE (ported from legacy): a finding kept WITHOUT the finder
    // having investigated its file is not trusted blindly — it gets a thorough
    // FULL re-verify, which may then drop it.
    const investigated = strongFilesFromRun(finderState);
    const unevidenced = kept.filter(
        (f) => !fileWasInvestigated(investigated, f.relevantFile),
    );
    if (unevidenced.length > 0) {
        const fullVerifier = new LlmVerifier(params.runner, {
            modelId: params.modelId,
            fallbackModelId: params.fallbackModelId,
            tools: params.tools,
            forceFull: true,
            providerOptions: params.providerOptions,
            telemetryMetadata: params.telemetryMetadata,
            agentName: params.agentName,
            usageRunName: params.usageRunName,
            feasibilityMode: params.feasibilityVerify,
        });
        const gate = await runVerificationPass<FinderSuggestion>(
            {
                candidates: unevidenced,
                verifier: fullVerifier,
                concurrency: params.concurrency,
            },
            ctx,
        );
        // The gate's re-verify is the more thorough look — its verdict (and tool
        // evidence) supersedes the first pass for the re-checked findings.
        gate.kept.forEach((f, i) =>
            verdictByFinding.set(f, gate.keptVerdicts[i]),
        );
        gate.dropped.forEach((d) =>
            verdictByFinding.set(d.candidate, d.verdict),
        );
        const stillDropped = new Set(gate.dropped.map((d) => d.candidate));
        kept = kept.filter((f) => !stillDropped.has(f));
        dropped = [...dropped, ...gate.dropped];
        gateUsage = { ...fullVerifier.usage };
    }

    // Map the generic verdict.toolCalls (name/args/result) into the review
    // ToolEvidenceSummary (strong=readFile/checkTypes files, weak=grep hits).
    const evidenceOf = (f: FinderSuggestion): ToolEvidenceSummary =>
        buildToolEvidenceSummary(
            (verdictByFinding.get(f)?.toolCalls ?? []).map((tc) => ({
                tool: tc.name,
                toolName: tc.name,
                args: tc.args ?? {},
                result: tc.result,
            })),
        );

    // The harness speaks neutral "candidate"; code-review's own term is "finding".
    return {
        reasoning,
        kept,
        keptEvidence: kept.map(evidenceOf),
        droppedByVerify: dropped.map((d) => ({
            finding: d.candidate,
            evidence: d.verdict.rationale,
            verifierEvidence: evidenceOf(d.candidate),
        })),
        finderState,
        verifyUsage: sumVerifyUsage(verifier.usage, gateUsage),
        recallUsage,
        passStats,
        shardPlan,
        scoutFlags,
    };
}

/** Files the finder actually investigated via readFile/checkTypes — the "strong
 *  evidence" the evidence gate checks. (grep is excluded: a search doesn't prove
 *  the agent read the matched code, matching the legacy strongFiles notion.) */
function strongFilesFromRun(state: RunState): Set<string> {
    const out = new Set<string>();
    for (const step of state.steps) {
        for (const tc of step.message.toolCalls ?? []) {
            if (tc.name !== 'readFile' && tc.name !== 'checkTypes') {
                continue;
            }
            const input = tc.input as Record<string, unknown> | undefined;
            const p =
                (input?.path as string) ??
                (input?.filePath as string) ??
                (input?.file as string);

            if (typeof p === 'string' && p) {
                out.add(normalizePath(p));
            }
        }
    }
    return out;
}

export function normalizePath(p: string): string {
    // The finding type declares relevantFile as string, but LLM output
    // (observed with kimi-k2.7) sometimes omits it; an undefined here
    // crashed the whole finder run ("Completed with Warnings", agent
    // dropped, minutes of work lost).
    if (typeof p !== 'string' || !p) return '';
    return p
        .replace(/\\/g, '/')
        .replace(/^\.?\/+/, '')
        .toLowerCase();
}

export function fileWasInvestigated(
    investigated: Set<string>,
    file: string,
): boolean {
    // A finding without a file can't claim investigation evidence.
    if (!file) return false;
    const f = normalizePath(file);
    for (const s of investigated) {
        if (s === f || s.endsWith('/' + f) || f.endsWith('/' + s)) {
            return true;
        }
    }
    return false;
}

function sumVerifyUsage(a: VerifyUsage, b: VerifyUsage): VerifyUsage {
    return {
        inputTokens: a.inputTokens + b.inputTokens,
        outputTokens: a.outputTokens + b.outputTokens,
        reasoningTokens: a.reasoningTokens + b.reasoningTokens,
        cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    };
}

// ─── Recall pass (synthesis rescue) ──────────────────────────────────────────
// After the main finder pass, one extra synthesis-rescue run re-thinks from the
// evidence already gathered and surfaces concrete MISSED bugs, dedup-merged
// before verify. (Soft coverage: the legacy coverage-recovery + 2nd/3rd-chance
// passes were removed — no coverage-forced re-runs.) Skipped in fast/trial mode.

type FinderFindings = { reasoning: string; suggestions: FinderSuggestion[] };

interface RecallPassesParams {
    runner: AgentRunner;
    finderSpec: AgentSpec;
    /** Builds a FRESH finder spec with its OWN DiffCoverageLedger. Heavy resample
     *  passes run concurrently, so they must NOT share `finderSpec`'s ledger —
     *  the CompletionGatePolicy mutates it per tool call, and interleaved writes
     *  would corrupt each pass's coverage/stop decisions. Each parallel pass gets
     *  its own spec via this factory; falls back to `finderSpec` when absent. */
    makeResampleSpec?: () => AgentSpec;
    /** Same fresh-ledger contract as makeResampleSpec, for critical-file /
     *  atomic-hunk passes specifically — lets them run with a different
     *  maxSteps than heavy resample. Falls back to makeResampleSpec when unset. */
    makeCriticalFileSpec?: () => AgentSpec;
    finderState: RunState;
    /** The original review prompt — reused by the synthesis-rescue pass. */
    userPrompt: string;
    skipHeavyPasses?: boolean;
    skipSynthesisRescue?: boolean;
    /** HEAVY mode — one EXTRA critic pass after synthesis-rescue. */
    heavy?: boolean;
    /** Files to give a dedicated single-file pass, each with ITS OWN diff. The
     *  diff is injected, not requested — asking the model to fetch context made
     *  the pass depend on obedience, and models differ, so the same pass did
     *  different work on different models. */
    criticalFiles?: Array<{ path: string; diff: string }>;
    /** See RunFinderWithVerifyParams.criticalFileBasePrompt. */
    criticalFileBasePrompt?: string;
    /** Roles for the expert-panel pass (see expert-panel.ts). */
    expertRoles?: ExpertRole[];
    /** See RunFinderWithVerifyParams.expertPanelBasePrompt. */
    expertPanelBasePrompt?: string;
    /** See RecallPassesParams.expertArbitrate — default true. */
    expertArbitrate?: boolean;
    /** See RunFinderWithVerifyParams.recognitionPanel. */
    recognitionPanel?: boolean;
    /** See RecallPassesParams.scoutInvestigator / runScout. */
    scoutInvestigator?: boolean;
    /** A/B knob (default off, requires scoutInvestigator): run the scout in
     *  SCOUT_RESAMPLE_ROUNDS sequential, context-aware rounds (each capped at
     *  SCOUT_ROUND_CAP) instead of one round capped at MAX_SCOUT_FLAGS. */
    scoutResample?: boolean;
    /** See RunFinderWithVerifyParams.scoutSecondRound. */
    scoutSecondRound?: boolean;
    /** See RunFinderWithVerifyParams.scoutLineHint. */
    scoutLineHint?: boolean;
    /** See RunFinderWithVerifyParams.hypothesisDriven. */
    hypothesisDriven?: boolean;
    /** See RunFinderWithVerifyParams.investigatorGroupByFile. */
    investigatorGroupByFile?: boolean;
    /** See RunFinderWithVerifyParams.scoutCap. */
    scoutCap?: number;
    /** See RunFinderWithVerifyParams.selectorShard. */
    selectorShard?: boolean;
    /** See RunFinderWithVerifyParams.runGrep. */
    runGrep?: (pattern: string) => Promise<string>;
    /** See RunFinderWithVerifyParams.runPlan. */
    runPlan?: (prompt: string, cap: number) => Promise<Selector[]>;
    /** See RunFinderWithVerifyParams.graphSites. */
    graphSites?: SignalSite[];
    /** See RunFinderWithVerifyParams.shardAltPrompt. */
    shardAltPrompt?: string;
    /** See RunFinderWithVerifyParams.shardBasePrompt. */
    shardBasePrompt?: string;
    /** One narrow pass per class of defect, each with its own prompt AND its
     *  own spec (so it does not inherit the generalist's system prompt).
     *  Built by the adapter from core/micro-agents.ts. */
    microAgentPasses?: Array<{
        label: string;
        prompt: string;
        spec: AgentSpec;
    }>;
    /** See RunFinderWithVerifyParams.shardCap. */
    shardCap?: number;
    shardPerWorker?: number;
    /** See RunFinderWithVerifyParams.graphSitesOnly. */
    graphSitesOnly?: boolean;
    /** See RunFinderWithVerifyParams.changedFilePaths. */
    changedFilePaths?: string[];
    /** Run ONLY the scout chain (scout → investigators → second look) and skip
     *  every other pass. Used by parallelScout to execute that chain
     *  concurrently with the base pass — the chain needs neither the base
     *  findings nor its RunState, so serialising them only costs wall clock. */
    scoutChainOnly?: boolean;
    /** Skip the scout chain (it already ran, concurrently). */
    skipScoutChain?: boolean;
    /** See RunFinderWithVerifyParams.challengeDismissals. */
    challengeDismissals?: boolean;
    /** See RunFinderWithVerifyParams.secondLookSameFile. */
    secondLookSameFile?: boolean;
    /** See RunFinderWithVerifyParams.secondLookAlways. */
    secondLookAlways?: boolean;
    /** See RunFinderWithVerifyParams.secondLookForceReport. */
    secondLookForceReport?: boolean;
    /** See RunFinderWithVerifyParams.freeformPass. */
    freeformPass?: boolean;
    /** See RunFinderWithVerifyParams.freeformBasePrompt. */
    freeformBasePrompt?: string;
    /** See RunFinderWithVerifyParams.scoutBasePrompt. */
    scoutBasePrompt?: string;
    /** See RunFinderWithVerifyParams.scoutByCategory. */
    scoutByCategory?: boolean;
    /** See RunFinderWithVerifyParams.scoutCategoryBasePrompts. */
    scoutCategoryBasePrompts?: Record<ScoutCategory, string>;
    runScout?: (
        prompt: string,
        category?: ScoutCategory,
        cap?: number,
    ) => Promise<ScoutFlag[]>;
    telemetryMetadata?: LangfuseTelemetryMetadata;
    agentName?: string;
    /** Injected prose-findings recovery (see ProseRecoverer). */
    recoverProse?: ProseRecoverer;
}

const ZERO_RECALL_USAGE: VerifyUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
};

/** How many NEW findings each extra pass contributed. Without this, a pass that
 *  costs a full finder run and adds nothing is indistinguishable from one that
 *  carries the whole gain — the merged total looks the same either way. */
export interface RecallPassStat {
    label: string;
    added: number;
    /** Steps the pass ran before finalizing — what a maxSteps cap actually
     *  bounds. A step can issue multiple tool calls at once, so this is NOT
     *  derivable from toolCalls; without it there's no way to confirm a lower
     *  step cap (e.g. atomic-hunk passes) is being respected rather than just
     *  correlating with fewer tool calls by chance. */
    steps: number;
    /** Tool calls the pass made. Zero means it answered without investigating. */
    toolCalls: number;
    /** Range-less readFile calls — the whole-file reads. The critical-file pass
     *  is defined by reading the file end to end; if this stays 0 the pass ran
     *  but did not do the thing it exists to do, and its result says nothing
     *  about the idea being tested. */
    fullFileReads: number;
    /** Prompt-cache diagnostic: this pass's own inputTokens/cacheReadTokens.
     *  Every recall pass prepends the SAME giant userPrompt (diff + rules) —
     *  if the provider caches that shared prefix across passes in the same
     *  case, cacheReadTokens should be close to inputTokens for every pass
     *  after the first. If it stays near 0, the prefix is being paid for
     *  fresh every time. */
    inputTokens: number;
    cacheReadTokens: number;
}

export async function runRecallPasses(
    base: FinderFindings,
    params: RecallPassesParams,
    ctx: ToolContext,
): Promise<{
    findings: FinderFindings;
    usage: VerifyUsage;
    passStats: RecallPassStat[];
    /** What the scout flagged, if scoutInvestigator ran — kept even when a
     *  flag's investigator cleared it, so a miss can be diagnosed as "the
     *  scout never suspected this" vs "the scout was right and the deep pass
     *  still could not confirm it". Empty when scoutInvestigator is off. */
    scoutFlags: ScoutFlag[];
    /** Counts from the shard's planning step (source, sites, workers, caps).
     *  Undefined when the shard did not run at all — which is a different
     *  state from running and finding nothing. */
    shardPlan?: {
        source: string;
        sites: number;
        workers: number;
        cap: number;
        perWorker: number;
    };
}> {
    let findings = base;
    let usage = ZERO_RECALL_USAGE;
    const passStats: RecallPassStat[] = [];
    let scoutFlags: ScoutFlag[] = [];
    if (params.skipHeavyPasses) {
        return { findings, usage, passStats, scoutFlags };
    }

    const scoutChainOnly = params.scoutChainOnly === true;
    const toolCalls = collectToolCalls(params.finderState);
    // Re-run the finder with a focused prompt; merge its ADDITIONAL findings.
    // `label` names the observation so each pass is distinct in the trace.
    let shardPlan:
        | {
              source: string;
              sites: number;
              workers: number;
              cap: number;
              perWorker: number;
          }
        | undefined;

    const runPass = async (
        prompt: string,
        label: string,
        spec: AgentSpec = params.finderSpec,
    ): Promise<{
        reasoning: string;
        added: number;
        passToolCalls: Array<{ tool: string; args: unknown }>;
    }> => {
        const state = await params.runner.run(
            spec,
            {
                prompt,
                ...toAiSdkTelemetryArgs(
                    buildLangfuseTelemetry(
                        `${params.agentName ?? 'finder'}-${label}`,
                        params.telemetryMetadata,
                    ),
                ),
            },
            ctx,
        );
        // Extract BEFORE touching the shared accumulators: passes may run
        // concurrently (heavy resample), and `mergeSuggestions(findings, await …)`
        // would snapshot `findings` before the await — last writer would win and
        // silently drop a concurrent pass's merge. Extract first, then merge
        // synchronously (single-threaded, so the read-modify-write is atomic).
        const extracted = await extractFindingsWithRecovery(
            state,
            params.recoverProse,
        );
        const passUsage = usageOf(state.usage);
        usage = sumVerifyUsage(usage, passUsage);
        toolCalls.push(...collectToolCalls(state));
        // Which pass produced a finding is invisible downstream once the sets
        // merge, so "are the shard's findings less precise than the
        // generalist's?" has never been answerable — the question that decides
        // whether a precision filter should treat them differently.
        for (const sug of extracted.suggestions ?? []) {
            if (sug && !(sug as { producedBy?: string }).producedBy) {
                (sug as { producedBy?: string }).producedBy = label;
            }
        }
        const before = findings.suggestions.length;
        findings = mergeSuggestions(findings, extracted);
        const added = findings.suggestions.length - before;
        const passCalls = collectToolCalls(state);
        passStats.push({
            label,
            added,
            // Steps, not tool calls: a step can fire several tool calls at
            // once, so toolCalls alone can't confirm a maxSteps cap held —
            // this is the number ForceFinalizePolicy/maxSteps actually bounds.
            steps: state.steps.length,
            toolCalls: passCalls.length,
            fullFileReads: passCalls.filter(
                (c) =>
                    c.tool === 'readFile' &&
                    !(c.args as { startLine?: number })?.startLine,
            ).length,
            inputTokens: passUsage.inputTokens,
            cacheReadTokens: passUsage.cacheReadTokens,
        });
        return { reasoning: extracted.reasoning ?? '', added, passToolCalls: passCalls };
    };

    // Synthesis rescue — re-think from the evidence already gathered, surface
    // concrete MISSED bugs (no new variants/speculation). Always unless skipped.
    // Soft coverage: the coverage-recovery + 2nd/3rd-chance passes (and the
    // coverage-debt nudge) were removed — the main pass goes depth-first, with
    // no coverage-forced re-runs.
    if (!params.skipSynthesisRescue && !scoutChainOnly) {
        const inspected = strongFilesFromRun(params.finderState);
        await runPass(
            buildSynthesisPrompt(
                params.userPrompt,
                inspected,
                toolCalls,
                findings.suggestions,
            ),
            'synthesis-rescue',
        );
    }

    // FREEFORM PASS. One independent full agent-loop run with a minimal,
    // unstructured prompt (no scout, no category rules, no prior-findings
    // context) — a different PROMPTING STYLE, not a different architecture.
    // Every other pass this session reuses the same rule-laden base prompt;
    // this tests whether a plainer framing surfaces different bugs the way
    // generalist vs scout+investigator already do (measured: mostly disjoint
    // sets). Only rule kept: anchor to a changed line — dropping that was the
    // single biggest precision killer in every other "loosen the prompt"
    // experiment this session. `freeformBasePrompt`, when set, replaces
    // userPrompt as the base — same fix as scoutBasePrompt, since the first
    // attempt at this knob still prepended the full rules block underneath
    // the "ignore everything above" line. Not yet measured.
    if (params.freeformPass) {
        const freeformBase = params.freeformBasePrompt ?? params.userPrompt;
        await runPass(
            buildFreeformPrompt(freeformBase, !!params.freeformBasePrompt),
            'freeform',
        );
    }

    // CRITICAL-FILE / ATOMIC-HUNK PASSES. One dedicated finder run per entry in
    // `criticalFiles` — either one per highest-priority file (tier-based) or one
    // per diff hunk of every file (atomicHunks, deterministic split, no scoring).
    // Each pass gets ONLY that entry's diff injected, isolated from the rest of
    // the PR. This is NOT the heavy resample: heavy re-rolls the same prompt
    // over the same diff and hopes for a different sample; this gives each pass
    // a narrower slice of REAL content the main pass had to skim past. Each pass
    // is scoped to its own file so passes don't re-report the same defect; the
    // main pass keeps cross-file coverage.
    if (params.criticalFiles?.length) {
        // Same ledger race as heavy: these run concurrently, so each needs its
        // own DiffCoverageLedger rather than sharing finderSpec's.
        if (!params.makeResampleSpec && !params.makeCriticalFileSpec) {
            throw new Error(
                'runRecallPasses: critical-file passes require makeCriticalFileSpec ' +
                    'or makeResampleSpec (a fresh per-pass coverage ledger); refusing ' +
                    'to run concurrent passes on a shared ledger.',
            );
        }
        const makeSpec = params.makeCriticalFileSpec ?? params.makeResampleSpec!;
        const criticalFileBase =
            params.criticalFileBasePrompt ?? params.userPrompt;
        await Promise.all(
            params.criticalFiles.map((file, i) =>
                runPass(
                    buildCriticalFilePrompt(
                        criticalFileBase,
                        file,
                        findings.suggestions,
                        !!params.criticalFileBasePrompt,
                    ),
                    `critical-file-${i + 1}`,
                    makeSpec(),
                ),
            ),
        );
    }

    // EXPERT PANEL. Step 1: N role-specific passes over the WHOLE PR diff, each
    // through ONE lens only (language specialist, security, performance, QA,
    // conditional DBA) — same content the main pass saw, narrower FOCUS instead
    // of narrower scope. Their raw claims are NOT merged into the shared pool
    // yet. Step 2: ONE arbitration pass sees every role's raw claims (including
    // empty lenses) and reconciles them — corroborate, contradict, or merge
    // duplicates — into a final verdict. Only the arbitration output merges
    // into findings; merging the raw claims too would double-count every
    // confirmed one. This is why it's two steps, not N passes unioned like
    // heavy: unstructured multi-persona prompting has weak/unstable evidence,
    // but the debate shape (independent claims → cross-examination → verdict)
    // showed real reasoning gains in the literature — the arbitration step is
    // the mechanism, not decoration on top of resampling.
    if (params.expertRoles?.length) {
        if (!params.makeResampleSpec) {
            throw new Error(
                'runRecallPasses: expert panel requires makeResampleSpec (a ' +
                    'fresh per-pass coverage ledger); refusing to run concurrent ' +
                    'role passes on a shared ledger.',
            );
        }
        const makeSpec = params.makeResampleSpec;
        const expertBase = params.expertPanelBasePrompt ?? params.userPrompt;

        if (params.expertArbitrate === false) {
            // UNION mode: each role's findings merge DIRECTLY into the shared
            // pool via the normal runPass path (same safe concurrent-merge
            // pattern heavy/critical-file already use — extract, then merge
            // synchronously with no await in between). No cross-examination
            // step: cheaper, but also loses the ONE mechanism the literature
            // actually credits with a real reasoning gain (debate), so expect
            // the same recall-up/precision-down trade heavy showed, not a free
            // win. Kept alongside the arbitrated mode so both are A/B-able. Does
            // NOT return early — heavy mode below still runs if also enabled.
            await Promise.all(
                params.expertRoles.map((role) =>
                    runPass(
                        buildExpertRolePrompt(expertBase, role),
                        `expert-role-${role.name}`,
                        makeSpec(),
                    ),
                ),
            );
        } else {
        const roleFindings = await Promise.all(
            params.expertRoles.map(async (role) => {
                const state = await params.runner.run(
                    makeSpec(),
                    {
                        prompt: buildExpertRolePrompt(expertBase, role),
                        ...toAiSdkTelemetryArgs(
                            buildLangfuseTelemetry(
                                `${params.agentName ?? 'finder'}-expert-${role.name}`,
                                params.telemetryMetadata,
                            ),
                        ),
                    },
                    ctx,
                );
                const extracted = await extractFindingsWithRecovery(
                    state,
                    params.recoverProse,
                );
                const roleUsage = usageOf(state.usage);
                usage = sumVerifyUsage(usage, roleUsage);
                const roleCalls = collectToolCalls(state);
                toolCalls.push(...roleCalls);
                // added: 0 always — role-pass claims are raw material for
                // arbitration, not merged directly. Recorded anyway so the
                // per-role cost (steps/toolCalls) is observable; without this,
                // a role that burns 20 steps and finds nothing looks identical
                // to one that never ran.
                passStats.push({
                    // "expert-role-" prefix, distinct from the "expert-panel-
                    // synthesis" arbitration label below — callers that filter
                    // passStats by role vs arbitration need an unambiguous split.
                    label: `expert-role-${role.name}`,
                    added: 0,
                    steps: state.steps.length,
                    toolCalls: roleCalls.length,
                    fullFileReads: 0,
                    inputTokens: roleUsage.inputTokens,
                    cacheReadTokens: roleUsage.cacheReadTokens,
                });
                return { role: role.name, suggestions: extracted.suggestions };
            }),
        );

        // recognitionPanel's skeptic arbitration runs even on an all-silent
        // panel — see buildSkepticArbitrationPrompt's doc, that case is
        // exactly what it exists to challenge. The neutral arbitration keeps
        // its skip-if-all-empty guard: nothing to reconcile, a synthesis
        // call over N empty lenses is a wasted run.
        if (
            params.recognitionPanel ||
            roleFindings.some((r) => r.suggestions.length > 0)
        ) {
            await runPass(
                params.recognitionPanel
                    ? buildSkepticArbitrationPrompt(expertBase, roleFindings)
                    : buildExpertArbitrationPrompt(expertBase, roleFindings),
                'expert-panel-synthesis',
                makeSpec(),
            );
        }
        }
    }

    // SCOUT → DEEP-INVESTIGATOR. Three cheap one-shot calls (bug / performance
    // / security), each a NARROW lens, flag a FEW suspicious spots (no tools,
    // no investigation — just "this is worth a closer look"). Then one full
    // agent-loop pass per flag investigates it with FULL tool budget dedicated
    // to that one spot — one investigator per FLAG, never per category, even
    // though three scouts now feed it: batching multiple flags into one
    // investigator call would re-dilute the exact attention this mechanism
    // exists to concentrate. Unlike every other extra pass above, this doesn't
    // add another voice over the whole diff — it concentrates depth where a
    // cheap wide scan raised suspicion, attacking the diff-size bottleneck
    // directly instead of diluting attention further.
    // PLAN → SHARD: the only pass that reads code the diff does not contain.
    if (params.microAgentPasses?.length && !scoutChainOnly) {
        await Promise.all(
            params.microAgentPasses.map((m) =>
                runPass(m.prompt, m.label, m.spec),
            ),
        );
    }

    // Both draws run concurrently — the second is an independent branch, not a
    // follow-up that reads the first one's answers.
    const shardBranch = async (promptFor: string, tag: string) => {
        const changed = params.changedFilePaths ?? [];
        const cap = params.shardCap ?? MAX_SELECTORS;
        const perWorker = params.shardPerWorker ?? SITES_PER_WORKER;
        let sites: SignalSite[] = [];
        // Named in the pass label so a run's dump says which source actually
        // fed the shard. Four runs reported themselves as graph experiments
        // while silently running the grep default; a label makes that visible
        // in the trace instead of only in a token bill.
        let source = 'grep';

        if (params.graphSites?.length) {
            // Sites already resolved by the AST graph: no plan call, no grep,
            // and the ordering is the blast radius' own impact score.
            sites = params.graphSites;
            source = 'graph';
        } else if (params.graphSitesOnly) {
            // Graph found nothing to chase: that is the answer, not a reason
            // to go guess with grep.
            sites = [];
        } else if (params.runPlan && params.runGrep) {
            const selectors = await params.runPlan(
                buildPlanPrompt(promptFor, cap),
                cap,
            );
            // Greps are independent — run them together, then cap once across
            // all selectors so one noisy symbol can't eat the whole budget.
            const perSelector = await Promise.all(
                selectors.map(async (sel) => {
                    try {
                        return parseSignals(await params.runGrep!(sel.query), sel, changed);
                    } catch {
                        return [] as SignalSite[];
                    }
                }),
            );
            // Round-robin across selectors so the cap spreads over symbols
            // instead of being consumed by whichever one matched most.
            for (let i = 0; sites.length < cap * 4; i++) {
                let addedAny = false;
                for (const list of perSelector) {
                    if (list[i]) {
                        sites.push(list[i]);
                        addedAny = true;
                    }
                }
                if (!addedAny) break;
            }
        }

        const groups = sites.length ? groupSites(sites, cap, perWorker) : [];
        // A shard that produces nothing is indistinguishable in the trace from
        // a shard that was never configured. Recording the counts separates
        // "the plan came back empty" from "the wiring is broken" — the exact
        // ambiguity that let four runs measure the wrong thing.
        // Only the first draw records shardPlan; the second is a replica, and
        // overwriting would hide what the primary branch actually planned.
        if (!shardPlan) {
            shardPlan = { source, sites: sites.length, workers: groups.length, cap, perWorker };
        }
        if (groups.length) {
            const makeSpec = params.makeResampleSpec;
            await Promise.all(
                groups.map((group, i) =>
                    runPass(
                        buildShardWorkerPrompt(
                            params.shardBasePrompt ?? promptFor,
                            group,
                        ),
                        `${tag}-${source}-${i + 1}`,
                        makeSpec ? makeSpec() : params.finderSpec,
                    ),
                ),
            );
        }
    };

    if (params.selectorShard && !scoutChainOnly) {
        await Promise.all([
            shardBranch(params.userPrompt, 'shard'),
            ...(params.shardAltPrompt
                ? [shardBranch(params.shardAltPrompt, 'shard2')]
                : []),
        ]);
    }

    if (params.scoutInvestigator && params.runScout && !params.skipScoutChain) {
        // Single general-purpose scout, not one per category, by default: an
        // earlier "3-category-scouts" idea was measured (5 PRs) at 8-15 flags
        // per PR (vs 5 for one scout) and TANKED both recall (51%→11%) and
        // precision (77%→19%) — but every scout in that test still received
        // the FULL generalist userPrompt (all categories, all investigation
        // rules), with only a one-line focus sentence on top. Never a real
        // per-category prompt, never confirmed past 5 PRs. `scoutByCategory`
        // (below) is the properly isolated retest — each scout gets ONLY its
        // own category's definitions via scoutCategoryBasePrompts. MEASURED
        // (20 PRs, same set as scoutCalibratedPrompt) and discarded anyway:
        // F1 0.418 vs 0.456, at higher cost — more scouts still dilutes
        // signal even when properly isolated. scoutCalibratedPrompt (one
        // scout, all three categories) remains the reference.
        // scoutResample (3 sequential context-aware rounds, cap 3 each) was
        // measured (5 PRs) and made things WORSE again: recall 51%→25%,
        // precision 77%→17%, cost 331→531 calls. Same failure mode as every
        // other attempt to widen the scout beyond 5-in-one-round (10-cap,
        // 3-category-scouts): more flags dilutes the investigator's signal,
        // context-awareness didn't change that. Kept as a flag (off) with the
        // mechanism intact, not deleted, in case a future model/config
        // benefits — but 5-in-one-round is the only validated config.
        // scoutSecondRound isolates the two variables scoutResample conflated:
        // round 1 stays UNCHANGED (cap 5, same as the single-scout path) and
        // exactly ONE follow-up round is added (cap 3, reusing
        // SCOUT_ROUND_CAP), instead of shrinking round 1 to 3 AND adding TWO
        // extra rounds — see runScoutSecondRound's doc. Not yet measured.
        // Precedence when more than one scout-expansion knob is set (checked
        // in this order below): mutually exclusive strategies, not stackable.
        const scoutBase = params.scoutBasePrompt ?? params.userPrompt;
        const flags = params.scoutResample
            ? await runScoutResample(params.runScout, scoutBase)
            : params.scoutSecondRound
              ? await runScoutSecondRound(params.runScout, scoutBase)
              : params.scoutByCategory && params.scoutCategoryBasePrompts
                ? await runScoutByCategory(
                      params.runScout,
                      params.scoutCategoryBasePrompts,
                      CATEGORY_SCOUT_CAP,
                      params.scoutLineHint,
                  )
                : await params.runScout(
                      buildScoutPrompt(
                          scoutBase,
                          undefined,
                          params.scoutCap ?? MAX_SCOUT_FLAGS,
                          params.scoutLineHint,
                          !!params.scoutBasePrompt,
                          params.hypothesisDriven,
                      ),
                  );
        scoutFlags = flags;
        if (flags.length) {
            if (!params.makeResampleSpec) {
                throw new Error(
                    'runRecallPasses: scout-investigator requires ' +
                        'makeResampleSpec (a fresh per-pass coverage ledger); ' +
                        'refusing to run concurrent investigator passes on a ' +
                        'shared ledger.',
                );
            }
            const makeSpec = params.makeResampleSpec;
            // investigatorGroupByFile (A/B knob, see
            // scout-investigator.ts:buildMultiFlagInvestigatorPrompt): when 2+
            // flags land on the same file, ONE pass investigates all of them
            // instead of N separate full agent-loop passes each re-reading the
            // same file from scratch. Default off: groups.length ===
            // flags.length, one group per flag — identical to the pre-existing
            // behavior (every downstream `groups[i].length === 1` check below
            // is then always true).
            const groups = params.investigatorGroupByFile
                ? groupFlagsByFile(flags)
                : flags.map((flag) => [flag]);
            const results = await Promise.all(
                groups.map((group, i) =>
                    runPass(
                        group.length > 1
                            ? buildMultiFlagInvestigatorPrompt(
                                  params.userPrompt,
                                  group,
                              )
                            : buildInvestigatorPrompt(
                                  params.userPrompt,
                                  group[0],
                                  params.hypothesisDriven,
                              ),
                        `investigator-${i + 1}`,
                        makeSpec(),
                    ),
                ),
            );
            // CHALLENGE DISMISSALS. A pass that cleared its flag (0 added) but
            // wrote real reasoning (not a one-line "nothing here") already
            // engaged with a specific concern and talked itself out of it — the
            // dominant failure mode measured for this mechanism (see
            // challengeDismissals doc). One follow-up per such pass, fed its OWN
            // prior reasoning and asked to argue the opposite case; it can still
            // end empty. The 40-char floor just skips passes that never had a
            // real theory to re-litigate. Skipped for merged multi-flag groups
            // (group.length > 1): the prompt below assumes ONE prior suspicion
            // to re-litigate, which doesn't fit a pass that already investigated
            // several.
            if (params.challengeDismissals) {
                await Promise.all(
                    results.map((result, i) =>
                        groups[i].length === 1 &&
                        result.added === 0 &&
                        result.reasoning.trim().length > 40
                            ? runPass(
                                  buildInvestigatorChallengePrompt(
                                      params.userPrompt,
                                      groups[i][0],
                                      result.reasoning,
                                  ),
                                  `investigator-${i + 1}-challenge`,
                                  makeSpec(),
                              )
                            : Promise.resolve(),
                    ),
                );
            }

            // SECOND LOOK, SAME FILE. A pass that cleared its flag (0 added)
            // after making at least one tool call already gathered evidence
            // about the file — a trace audit found MOST reached-but-missed
            // goldens (7/9) were never engaged at all, not because the pass
            // gave up early, but because it was only ever asked to confirm or
            // clear ONE named suspicion. This reuses that pass's own tool-call
            // trail (no re-exploration) and asks about a DIFFERENT defect in
            // the same file — see secondLookSameFile doc. Independent of
            // challengeDismissals: that re-argues the SAME suspicion, this
            // drops it for a different one; both can fire off one dismissal.
            // Skipped for merged multi-flag groups, same reason as above.
            if (params.secondLookSameFile) {
                await Promise.all(
                    results.map((result, i) =>
                        groups[i].length === 1 &&
                        (params.secondLookAlways ||
                            result.added === 0) &&
                        result.passToolCalls.length > 0
                            ? runPass(
                                  buildInvestigatorSecondLookPrompt(
                                      params.userPrompt,
                                      groups[i][0],
                                      investigationSummary(
                                          result.passToolCalls,
                                      ),
                                      params.secondLookForceReport,
                                  ),
                                  `investigator-${i + 1}-second-look`,
                                  makeSpec(),
                              )
                            : Promise.resolve(),
                    ),
                );
            }
        }
    }

    // HEAVY mode — RESAMPLE. Re-run the finder HEAVY_RESAMPLE_EXTRA_RUNS more
    // times on the ORIGINAL prompt and dedup-merge. Validated offline
    // (evals/shard-seeder/resample.js) + on a real self-hosted A/B: a finder's
    // stochastic variance surfaces different real bugs each run, so the union
    // climbs recall (~2× candidates), saturating around 3 total runs — cheap
    // self-diversity without a 2nd model. Requires temperature > 0 (at 0 the
    // re-runs are identical); the finder omits temperature so the PROVIDER DEFAULT
    // (~1.0; reasoning models auto-clamp to 1) applies and diversifies out of the
    // box — no per-run override needed. The extra recall floods candidates, folded
    // by collapseNearDuplicates above + the verify. See project_critic_heavy_mode.
    if (params.heavy) {
        // Fail fast: the concurrent passes below MUST each get their own
        // DiffCoverageLedger (via makeResampleSpec). Falling back to the shared
        // `finderSpec` would silently reintroduce the ledger race across parallel
        // passes — refuse to run rather than corrupt coverage/stop decisions.
        if (!params.makeResampleSpec) {
            throw new Error(
                'runRecallPasses: heavy mode requires makeResampleSpec (a fresh ' +
                    'per-pass coverage ledger); refusing to run concurrent resample ' +
                    'passes on a shared ledger.',
            );
        }
        const makeSpec = params.makeResampleSpec;
        // The extra runs are INDEPENDENT (same original prompt, no data flow
        // between them) → run them CONCURRENTLY. Cuts heavy latency from
        // base+synthesis+N×finder to base+synthesis+~1×finder. Cost note: the
        // base run has already WRITTEN the Anthropic prompt cache (system prompt
        // via systemCacheControl), so the parallel re-runs both get
        // cache READS on the static prefix — the marginal cost of a re-run is
        // well under a full run's input price.
        await Promise.all(
            Array.from({ length: HEAVY_RESAMPLE_EXTRA_RUNS }, (_, i) =>
                // Fresh spec per pass (own DiffCoverageLedger) — these run
                // concurrently, so sharing a ledger would race.
                runPass(
                    params.userPrompt,
                    `heavy-resample-${i + 1}`,
                    makeSpec(),
                ),
            ),
        );
    }

    return { findings, usage, passStats, scoutFlags, shardPlan };
}

/** Dedup-merge extra findings into the base set (ported from legacy
 *  mergeFindings): key = file::startLine::endLine::content. */
function mergeSuggestions(
    baseF: FinderFindings,
    extraF: FinderFindings,
): FinderFindings {
    const keyOf = (s: FinderSuggestion) =>
        [
            s.relevantFile,
            s.relevantLinesStart ?? '',
            s.relevantLinesEnd ?? '',
            s.suggestionContent,
        ].join('::');
    const seen = new Set(baseF.suggestions.map(keyOf));
    const additions = extraF.suggestions.filter((s) => {
        const k = keyOf(s);
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
    return {
        reasoning: [baseF.reasoning, extraF.reasoning]
            .filter(Boolean)
            .join('\n\n'),
        suggestions: [...baseF.suggestions, ...additions],
    };
}

function collectToolCalls(
    state: RunState,
): Array<{ tool: string; args: unknown }> {
    return state.steps.flatMap((s) =>
        (s.message.toolCalls ?? []).map((tc) => ({
            tool: tc.name,
            args: tc.input ?? {},
        })),
    );
}

function usageOf(u: TokenUsage | undefined): VerifyUsage {
    return {
        inputTokens: u?.inputTokens ?? 0,
        outputTokens: u?.outputTokens ?? 0,
        reasoningTokens: u?.reasoningTokens ?? 0,
        cacheReadTokens: u?.cacheReadTokens ?? 0,
    };
}

function investigationSummary(
    toolCalls: Array<{ tool: string; args: unknown }>,
): string {
    return toolCalls
        .slice(-20)
        .map((tc) => {
            const args =
                typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args);
            return `${tc.tool}(${(args ?? '').substring(0, 150)})`;
        })
        .join('\n');
}

/**
 * Prompt for one critical-file pass.
 *
 * Two deliberate deviations from a plain re-run:
 *  - the agent must read the WHOLE file first, not just reason over the hunks
 *    the main prompt already showed it;
 *  - findings are confined to this file, so N concurrent passes can't all
 *    surface the same cross-file defect (the main pass owns cross-file).
 *
 * The changed-line anchoring rule is NOT relaxed: the surrounding body is
 * context for judging the change, not new review surface. Without that, a full
 * file read turns every pre-existing wart into a finding the anchoring filter
 * would drop anyway — cost with no recall.
 *
 * `minimalBase` (A/B knob `criticalFileDedicatedPrompt`, paired with
 * finder.agent.ts's `criticalFileBasePrompt`): the original version always
 * prepended the FULL generalist userPrompt (the whole PR's diff still
 * sitting in context) and told the model to "ignore" it — MEASURED (30 PRs,
 * atomicFiles, predates this session's MEASURED-annotation habit) at F1
 * 0.327, below baseline. Same confound this session found and fixed for the
 * scout and expert-panel: telling a model to ignore content that's still
 * right there is weaker than never sending it. minimalBase drops the dead
 * "ignore" instruction when the caller passes a genuinely diff-free base.
 */
function buildCriticalFilePrompt(
    userPrompt: string,
    file: { path: string; diff: string },
    current: FinderSuggestion[],
    minimalBase = false,
): string {
    const already = current
        .filter((s) => s.relevantFile === file.path)
        .map((s) => `- ${s.suggestionContent.substring(0, 120)}`)
        .join('\n');
    const ignoreAbove = minimalBase
        ? ''
        : 'Ignore the diffs above. ';

    return `${userPrompt}

<SingleFileFocus file="${file.path}">
  ${ignoreAbove}This pass reviews ONE file, and only this diff:

\`\`\`diff
${file.diff}
\`\`\`

  The main pass already reviewed the PR as a whole and owns anything that spans
  files. Your job is depth on this one change: what it assumes, what it breaks,
  what it stops doing. Use the tools to check whatever this diff depends on.

  Reporting scope:
    - Report ONLY defects whose relevantFile is ${file.path}.
    - The root cause must be in lines this diff adds or modifies.
${already ? `\n  Already reported for this file — do NOT repeat these:\n${already}\n` : ''}
  If nothing new surfaces, submit an empty suggestions array.
</SingleFileFocus>`;
}

function buildSynthesisPrompt(
    userPrompt: string,
    inspected: Set<string>,
    toolCalls: Array<{ tool: string; args: unknown }>,
    current: FinderSuggestion[],
): string {
    const inspectedList = inspected.size
        ? [...inspected].join('\n')
        : 'No files recorded as inspected.';
    const currentSummary = current.length
        ? current
              .map(
                  (s) =>
                      `- ${s.relevantFile}: ${s.suggestionContent.substring(0, 120)}`,
              )
              .join('\n')
        : 'No findings reported yet.';
    return `${userPrompt}

<AlreadyInspectedFiles>
${inspectedList}
</AlreadyInspectedFiles>

<RecentInvestigation>
${investigationSummary(toolCalls) || 'No tool calls captured.'}
</RecentInvestigation>

<CurrentFindings>
${currentSummary}
</CurrentFindings>

Your task:
- Re-think the review based on the context above.
- Do not add variants or restatements of existing findings.
- Do not add speculative risks.
- If there are concrete missed bugs, submit them.
- If there is no clearly missed bug, submit an empty suggestions array.`;
}
