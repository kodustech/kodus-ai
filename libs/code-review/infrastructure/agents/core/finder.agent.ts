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
import { ExecutableVerifier } from '@libs/agent-harness/infrastructure/verify/executable-verifier';
import { CompositeVerifier } from '@libs/agent-harness/infrastructure/verify/composite-verifier';
import type { CommandRunner } from '@libs/agent-harness/domain/contracts/command-runner.contract';
import { BudgetPolicy } from '@libs/agent-harness/infrastructure/policies/budget.policy';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import { CompletionGatePolicy } from '@libs/agent-harness/infrastructure/policies/completion-gate.policy';
import { ForceFinalizePolicy } from '@libs/agent-harness/infrastructure/policies/force-finalize.policy';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import { LlmVerifier } from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import { tscCheck } from '@libs/code-review/infrastructure/agents/core/tsc-check';
import { buildToolEvidenceSummary } from '@libs/code-review/infrastructure/agents/core/agent-anomalies';
import { supportsStrictTools } from '@libs/code-review/infrastructure/agents/core/model-strictness';
import type { ToolEvidenceSummary } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import type { Verdict } from '@libs/agent-harness/domain/contracts/verifier.contract';
import {
    buildLangfuseTelemetry,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';
// Domain helper relocated out of the legacy file (Zod validation of findings).
import { sanitizeFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';
import { withStructuredOutputFallback } from '@libs/llm/byok-to-vercel';
import { collapseNearDuplicates } from '@libs/code-review/infrastructure/agents/engine/dedup-prompt';
import { createLogger } from '@libs/core/log/logger';
import type { BYOKConfig } from '@kodus/kodus-common/llm';
import { generateObject } from 'ai';
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
 *  detects by name; its input (the findings) is captured in the RunState. */
const submitResultTool: AgentTool = {
    name: FINDER_DONE_TOOL,
    description:
        'Submit your final findings and end the review. Call this once you have investigated the changed code.',
    inputSchema: SUBMIT_RESULT_SCHEMA,
    execute: async () => ({ output: 'submitted' }),
};

export interface BuildFinderSpecParams {
    systemPrompt: string;
    modelId: string;
    /** Investigation tools (grep/readFile/...) from buildFinderToolRegistry. */
    tools: ToolRegistry;
    coverageLedger: ProgressLedger;
    compressor?: Compressor;
    maxSteps?: number;
    /** Provider options (reasoning/thinking config) forwarded to the model. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** Provider options attached to the system message (e.g. Anthropic prompt
     *  caching) so the long system prompt is cached across the loop's steps. */
    systemProviderOptions?: Readonly<Record<string, unknown>>;
}

export function buildFinderAgentSpec(params: BuildFinderSpecParams): AgentSpec {
    const tools = new InMemoryToolRegistry([
        ...params.tools.list(),
        // Enable strict/structured tool calling on the done-tool for
        // strict-capable models (Gemini VALIDATED mode) so the findings payload
        // can't be omitted or emitted as prose. Best-effort otherwise. NOT
        // enabled for Anthropic — see model-strictness.ts (it craters recall).
        { ...submitResultTool, strict: supportsStrictTools(params.modelId) },
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
        systemPrompt: params.systemPrompt,
        modelId: params.modelId,
        tools,
        policies,
        maxSteps: params.maxSteps ?? 20,
        // CAPTURE concern: the runner materializes submitResult's payload into
        // RunState.artifacts. Stopping ON submitResult is the CompletionGatePolicy's
        // doneToolName concern — same tool, distinct roles.
        resultToolName: FINDER_DONE_TOOL,
        providerOptions: params.providerOptions,
        systemProviderOptions: params.systemProviderOptions,
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
        if (typeof text !== 'string' || !text.trim()) continue;
        const json = extractJsonBlock(text);
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
    return null;
}

/** Pull a JSON object out of free text: a ```json fenced block, else the
 *  widest {...} span. */
function extractJsonBlock(text: string): string | null {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) return fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) return text.slice(start, end + 1);
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
export type ProseRecoverer = (
    reasoning: string,
) => Promise<FinderSuggestion[]>;

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
    byokConfig: BYOKConfig | undefined,
    organizationId: string | undefined,
): Promise<FinderSuggestion[]> {
    if (!looksLikeFindings(prose)) return [];
    try {
        const suggestions = await withStructuredOutputFallback(
            {
                byokConfig,
                organizationId,
                label: 'finder-prose-recovery',
            },
            async (model) => {
                const { object } = await generateObject({
                    model,
                    schema: RECOVERY_SCHEMA,
                    prompt:
                        "The following is a code reviewer's analysis written as " +
                        'prose. Extract EVERY concrete finding it describes into ' +
                        'the structured schema — one entry per distinct issue, ' +
                        'using the file paths and line numbers mentioned. Do NOT ' +
                        'invent findings; only extract what is explicitly ' +
                        `described.\n\nANALYSIS:\n${prose}`,
                });
                return object.suggestions as unknown as FinderSuggestion[];
            },
        );
        return suggestions ?? [];
    } catch {
        // Best-effort: recovery must never break the review.
        return [];
    }
}

// ─── Finder + Verify (parity orchestration on the SAME runner) ──────────────

export interface RunFinderWithVerifyParams {
    runner: AgentRunner;
    finderSpec: AgentSpec;
    /** Factory for a fresh finder spec (own coverage ledger) per concurrent
     *  heavy resample pass — see RecallPassesParams.makeResampleSpec. */
    makeResampleSpec?: () => AgentSpec;
    /** Model id for the verifier runs. */
    modelId: string;
    /** Investigation tools shared with the verifier. */
    tools: ToolRegistry;
    /** Verify concurrency (default 4). */
    concurrency?: number;
    /** Provider options (reasoning/thinking config) forwarded to verifier runs. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** System-message provider options (e.g. Anthropic prompt caching), forwarded
     *  to the finder spec and the verifier runs. */
    systemProviderOptions?: Readonly<Record<string, unknown>>;
    /** Objective-first verify (gated): a CommandRunner (sandbox exec) so the
     *  verifier can run `tsc` and trust a compiler-confirmed finding. Absent →
     *  LLM-only verify (current behavior). */
    commandRunner?: CommandRunner;
    /** Gated A/B knob (default off): wrap the LLM verifier in a CompositeVerifier
     *  that runs `tsc` first (ExecutableVerifier) and defers only the uncertain
     *  candidates to the LLM. Requires `commandRunner`. */
    executableVerify?: boolean;
    /** Skip the recall pass entirely (fast mode / self-contained trial). */
    skipHeavyPasses?: boolean;
    /** Skip ONLY the synthesis-rescue pass. */
    skipSynthesisRescue?: boolean;
    /** HEAVY mode: run an EXTRA "what did you miss?" critic pass (on top of the
     *  synthesis-rescue) that re-scans for missed bugs. Opt-in per review — more
     *  recall at ~+1 finder pass of cost. Off by default. */
    heavy?: boolean;
    /** Langfuse telemetry context (org/team/PR/repo) — names the finder, recall
     *  and per-finding verify observations so the trace is attributable. */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** Agent name (finder/security/...) — prefixes every observation name. */
    agentName?: string;
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
}

const ZERO_VERIFY_USAGE: VerifyUsage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
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
    const finderState = await params.runner.run(
        params.finderSpec,
        {
            ...input,
            telemetry: buildLangfuseTelemetry(
                params.agentName ?? 'finder',
                params.telemetryMetadata,
            ),
        },
        ctx,
    );
    // Main finder findings — with prose-recovery applied (the same wrapper the
    // recall passes use, so an omission in any pass is caught consistently).
    const base = await extractFindingsWithRecovery(
        finderState,
        params.recoverProse,
    );

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
            finderState,
            userPrompt: input.prompt,
            skipHeavyPasses: params.skipHeavyPasses,
            skipSynthesisRescue: params.skipSynthesisRescue,
            heavy: params.heavy,
            telemetryMetadata: params.telemetryMetadata,
            agentName: params.agentName,
            recoverProse: params.recoverProse,
        },
        ctx,
    );
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

    if (suggestions.length === 0) {
        return {
            reasoning,
            kept: [],
            keptEvidence: [],
            droppedByVerify: [],
            finderState,
            verifyUsage: ZERO_VERIFY_USAGE,
            recallUsage,
        };
    }

    // Verify each finding (HV2 refute-to-drop) with the confidence SPLIT inside
    // LlmVerifier: high-confidence → light depth, low-confidence → full depth.
    const llmVerifier = new LlmVerifier(params.runner, {
        modelId: params.modelId,
        tools: params.tools,
        providerOptions: params.providerOptions,
        systemProviderOptions: params.systemProviderOptions,
        telemetryMetadata: params.telemetryMetadata,
        agentName: params.agentName,
    });
    // Objective-first (gated): run `tsc` in the sandbox and TRUST a
    // compiler-confirmed finding (high confidence → the composite skips the LLM);
    // defer everything else to the LLM. Off, or no sandbox exec → LLM-only. The
    // evidence-gate re-verify below stays LLM-only (secondary net).
    const verifier =
        params.executableVerify && params.commandRunner
            ? new CompositeVerifier<FinderSuggestion>(
                  new ExecutableVerifier<FinderSuggestion>(
                      params.commandRunner,
                      tscCheck,
                  ),
                  llmVerifier,
              )
            : llmVerifier;
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
            tools: params.tools,
            forceFull: true,
            providerOptions: params.providerOptions,
            systemProviderOptions: params.systemProviderOptions,
            telemetryMetadata: params.telemetryMetadata,
            agentName: params.agentName,
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
        gate.dropped.forEach((d) => verdictByFinding.set(d.candidate, d.verdict));
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
        // LLM verify usage lives on the LlmVerifier itself; findings the
        // ExecutableVerifier decides skip the LLM, so this counts only what the
        // LLM actually judged (whether or not it was wrapped in a composite).
        verifyUsage: sumVerifyUsage(llmVerifier.usage, gateUsage),
        recallUsage,
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
    finderState: RunState;
    /** The original review prompt — reused by the synthesis-rescue pass. */
    userPrompt: string;
    skipHeavyPasses?: boolean;
    skipSynthesisRescue?: boolean;
    /** HEAVY mode — one EXTRA critic pass after synthesis-rescue. */
    heavy?: boolean;
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

export async function runRecallPasses(
    base: FinderFindings,
    params: RecallPassesParams,
    ctx: ToolContext,
): Promise<{ findings: FinderFindings; usage: VerifyUsage }> {
    let findings = base;
    let usage = ZERO_RECALL_USAGE;
    if (params.skipHeavyPasses) {
        return { findings, usage };
    }

    const toolCalls = collectToolCalls(params.finderState);
    // Re-run the finder with a focused prompt; merge its ADDITIONAL findings.
    // `label` names the observation so each pass is distinct in the trace.
    const runPass = async (
        prompt: string,
        label: string,
        spec: AgentSpec = params.finderSpec,
    ): Promise<void> => {
        const state = await params.runner.run(
            spec,
            {
                prompt,
                telemetry: buildLangfuseTelemetry(
                    `${params.agentName ?? 'finder'}-${label}`,
                    params.telemetryMetadata,
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
        usage = sumVerifyUsage(usage, usageOf(state.usage));
        toolCalls.push(...collectToolCalls(state));
        findings = mergeSuggestions(findings, extracted);
    };

    // Synthesis rescue — re-think from the evidence already gathered, surface
    // concrete MISSED bugs (no new variants/speculation). Always unless skipped.
    // Soft coverage: the coverage-recovery + 2nd/3rd-chance passes (and the
    // coverage-debt nudge) were removed — the main pass goes depth-first, with
    // no coverage-forced re-runs.
    if (!params.skipSynthesisRescue) {
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
        // via anthropicSystemCacheControl), so the parallel re-runs both get
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

    return { findings, usage };
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
