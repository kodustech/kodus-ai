/**
 * code-review (domain) — runAgentLoopViaCore: runs a review finder + verify on
 * the agent-harness engine.
 *
 * This is THE engine for EVERY review agent (bug / security / performance /
 * generalist / kody-rules) — the legacy in-house loop was removed, and all
 * providers route here via BaseCodeReviewAgentProvider (`loopFn =
 * runAgentLoopViaCore`, unconditional). The per-agent difference is the
 * AgentSpec (prompt + tools), not a forked loop.
 *
 * Fidelity notes:
 *  - recall/FP fields are faithful: findings.suggestions = verified-kept,
 *    droppedByVerify = refuted. This is what the benchmark measures.
 *  - usage is faithful: finder + verify sub-step combined, with cacheRead and
 *    reasoning tokens (cacheWrite stays 0 — implicit-cache providers don't
 *    report writes). verificationUsage carries the verify sub-step alone.
 *  - verification trace is reconstructed: before/after/dropped counts + a
 *    per-finding keep/drop decision list with verifierEvidence — the files the
 *    verifier itself read/grepped while judging each finding (threaded from the
 *    verifier RunState through Verdict.toolCalls).
 *  - discardedBySeverity is [] by design: the new path has no severity
 *    pre-filter — verify alone decides keep/drop.
 */
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';

import { ContextWindowCompressor } from '@libs/agent-harness/infrastructure/compression/context-window-compressor';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import { OverflowRecoveringRunner } from './overflow-recovering-runner';
import { estimateOverheadTokens } from '@libs/agent-harness/infrastructure/compression/token-estimator';
import { DiffCoverageLedger } from '@libs/code-review/infrastructure/agents/adapters/diff-coverage-ledger.adapter';
import { buildFinderToolRegistry } from '@libs/code-review/infrastructure/agents/adapters/finder-tools.adapter';
import {
    buildFinderAgentSpec,
    runFinderWithVerify,
    recoverFindingsFromProse,
    submitResultTool,
    type FinderSuggestion,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import {
    buildFindingsFromVerify,
    summarizeFunnel,
} from '@libs/code-review/infrastructure/agents/core/review-finding';
import { createLogger } from '@libs/core/log/logger';
import {
    type AgentLoopInput,
    type AgentLoopOutput,
    type AgentLoopSecrets,
    type VerificationTraceSummary,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';
import { createAgentRunContext } from '@libs/llm/agent-run-context';
import { buildProviderOptions } from '@libs/llm/reasoning-options';
import {
    splitDiffIntoHunks,
    extractHunkHeaders,
    normalizeFilenameForTier,
} from '@libs/code-review/infrastructure/agents/collaborators/context-fit-planner';
import { CoverageTier } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';
import {
    buildExpertRoles,
    RECOGNITION_PANEL_ROLES,
} from '@libs/code-review/infrastructure/agents/core/expert-panel';
import { runPlan } from '@libs/code-review/infrastructure/agents/core/selector-shard';
import {
    runScout,
    buildScoutPrompt,
    buildScoutVerdictBlock,
    buildAdversarialPrompt,
    MAX_SCOUT_FLAGS,
    type ScoutCategory,
} from '@libs/code-review/infrastructure/agents/core/scout-investigator';
// buildAgentAnomalies is review-specific (anomaly summary shapes) — lives in its
// own module (relocated out of the legacy llm/agent-loop.ts).
import { buildAgentAnomalies } from '@libs/code-review/infrastructure/agents/core/agent-anomalies';
import { V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT } from '@libs/common/utils/codeReview/v2Defaults';
import {
    MICRO_AGENTS,
    MICRO_AGENT_SYSTEM_PROMPT,
    buildMicroAgentPrompt,
    runMicroPlanner,
    CROSS_FILE_AGENT_ID,
} from '@libs/code-review/infrastructure/agents/core/micro-agents';
import {
    SIMULATION_SYSTEM_PROMPT,
    buildSimulationPrompt,
} from '@libs/code-review/infrastructure/agents/core/simulation-agent';

const funnelLogger = createLogger('review-funnel');

/**
 * The `critical`-tier filenames, resolved back to the paths the agent can
 * actually pass to readFile. The tier map is keyed by the scorer's normalized
 * path; handing that key straight to the prompt would give the model a path the
 * sandbox may not resolve, so match it back to the real changedFiles entry.
 */
function criticalFilesFrom(
    fileTiers: AgentLoopInput['fileTiers'],
    changedFiles: AgentLoopInput['changedFiles'],
): Array<{ path: string; diff: string }> | undefined {
    if (!fileTiers?.size) return undefined;
    const norm = (p: string) => p.replace(/^\/+/, '').toLowerCase();
    const critical = new Set(
        [...fileTiers.entries()]
            .filter(([, tier]) => tier === 'critical')
            .map(([file]) => norm(file)),
    );
    if (!critical.size) return undefined;

    // A file whose diff we don't have is dropped: a pass over an empty diff is a
    // wasted run that still looks like a real one in the pass stats.
    const picked = (changedFiles ?? [])
        .filter((f) => f?.filename && critical.has(norm(f.filename)))
        .map((f) => ({
            path: f.filename as string,
            diff: (f.patchWithLinesStr ?? f.patch ?? '').trim(),
        }))
        .filter((f) => f.diff.length > 0);

    return picked.length ? picked : undefined;
}

/**
 * Diff-only content, no rules/categories/output-format boilerplate. Shared by
 * two A/B knobs: `scoutDedicatedPrompt` (MEASURED on 30 PRs and discarded —
 * F1 0.375 vs the 0.424 baseline) and `freeformDedicatedPrompt` (not yet
 * measured).
 *
 * CORRECTION to earlier session notes: the full userPrompt was described as
 * "150k-380k tokens, only 62-76% cache-covered" — that figure is the
 * CUMULATIVE inputTokens of a multi-step investigator/synthesis pass (every
 * step resends the growing tool-call history, so it scales with step count,
 * not prompt size). Measured directly on the light 30-PR set: diffs alone run
 * 500-9,500 tokens, and the rules/category boilerplate adds only a few
 * thousand more — the scout's actual one-shot prompt (no tool loop, so its
 * inputTokens ARE its prompt size) was realistically in the 10k-25k token
 * range, not 150k+. The size savings from going diff-only is real but smaller
 * than that number implied — and scoutDedicatedPrompt still cost real
 * recall/precision despite it, meaning the boilerplate being cut was doing
 * real calibration work for the scout, not free-riding noise. */
/**
 * Regua de tier sobre o diff que vai no prompt.
 *
 * O diff e a parte FIXA: ele entra inteiro no prompt de cada passada e e
 * reenviado a cada step do loop, entao encolhe-lo encolhe tudo
 * proporcionalmente. Medido no conjunto de 30 PRs: nos quatro com diff acima
 * de 200k, resumir `warm` e `optional` corta 14% dos tokens do benchmark
 * inteiro e custa 2 goldens; resumir so `optional` corta 2% e nao custa
 * nenhum. O `optional` e pequeno (9% do volume) — quase toda a economia esta
 * no `warm` (33%).
 *
 * O limiar existe porque a composicao de tiers varia muito: o maior PR do
 * conjunto encolhe 15% com a regra e outro encolhe 66%. Aplicar em todo PR
 * custaria 12 goldens; aplicar so nos grandes custa 2.
 *
 * O ROTULO e parte do mecanismo, nao enfeite. Um arquivo truncado em silencio
 * some; um arquivo que se anuncia como resumido, diz o tier e diz qual
 * ferramenta traz o corpo, deixa a decisao de buscar com o agente — que e a
 * unica forma de o corte ser recuperavel. Os cabecalhos de hunk custam ~70
 * caracteres por arquivo, 3% do diff no pior caso aqui.
 */
export type DiffTierBudget = {
    /** Acima de quantos caracteres de diff a regua liga. */
    thresholdChars: number;
    /** Tiers que entram resumidos. Vazio desliga. */
    summarize: CoverageTier[];
};

export function rawDiffPrompt(
    changedFiles: AgentLoopInput['changedFiles'],
    fileTiers?: AgentLoopInput['fileTiers'],
    budget?: DiffTierBudget,
): string {
    const files = changedFiles ?? [];
    const diffDe = (f: (typeof files)[number]) =>
        (f?.patchWithLinesStr ?? f?.patch ?? '').trim();

    const total = files.reduce((n, f) => n + diffDe(f).length, 0);
    const resumir = new Set(budget?.summarize ?? []);
    const ligado =
        !!budget &&
        resumir.size > 0 &&
        !!fileTiers?.size &&
        total >= budget.thresholdChars;

    return files
        .map((f) => {
            const diff = diffDe(f);
            if (!diff) return '';
            const tier = fileTiers?.get(
                normalizeFilenameForTier(String(f?.filename ?? '')),
            );
            const marca = tier === 'critical' ? ' [CRITICAL]' : tier ? ` [${tier}]` : '';
            if (!ligado || !tier || !resumir.has(tier)) {
                return `--- ${f?.filename} (${f?.status})${marca} ---\n${diff}`;
            }
            const headers = extractHunkHeaders(diff);
            const linhas = diff.split('\n').length;
            return [
                `--- ${f?.filename} (${f?.status}) [${tier}, SUMMARISED] ---`,
                headers.length ? headers.join('\n') : '(no hunk headers)',
                `(body withheld: ${linhas} diff lines. This file is ${tier}, not critical, so only its hunk ranges are shown. Call readFile on this path to read any range you need.)`,
            ].join('\n');
        })
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Diff + the same BUG/PERFORMANCE/SECURITY definitions the main pass reviews
 * against (V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT) — everything else
 * (investigation Rules, OutputFormat schema, CoverageContract, PR
 * context) stays out. A/B knob `scoutCalibratedPrompt`, sibling to
 * `scoutDedicatedPrompt` (bare diff, MEASURED worse on 30 PRs — F1 0.375 vs
 * 0.424). MEASURED (30 PRs) and validated: F1 0.432 — the loss from going
 * diff-only was specifically the missing definitions of what counts as
 * suspicious, not context in general. A scout with no notion of "what is a
 * bug" was skimming blind. */
/** Shared by calibratedDiffPrompt (diff prepended) and criticalFileDedicatedBase
 *  (no diff — the caller injects a file/hunk-specific diff of its own downstream,
 *  e.g. buildCriticalFilePrompt's <SingleFileFocus>). */
const DETECTION_CATEGORIES_BLOCK = `
<DetectionCategories>
  A defect worth flagging falls into one of these:

  BUG:
${V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT.bug}

  PERFORMANCE:
${V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT.performance}

  SECURITY:
${V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT.security}
</DetectionCategories>`;

function calibratedDiffPrompt(
    changedFiles: AgentLoopInput['changedFiles'],
): string {
    return `${rawDiffPrompt(changedFiles)}
${DETECTION_CATEGORIES_BLOCK}`;
}

/** Reminder block for dedicated/calibrated bases used by FULL AGENT-LOOP
 * passes (expert-panel roles + arbitration) — distinct from the scout's
 * calibratedDiffPrompt, which is a one-shot LLM.run call with the response
 * SHAPE forced by a schema param, not a submitResult tool call. Agent-loop
 * passes report via calling the submitResult TOOL; the full userPrompt's
 * <OutputFormat> section is what teaches the model that a concluded verdict
 * must become a structured suggestion entry, not just prose in "reasoning".
 * MEASURED (10 PRs): stripping this block entirely (bare calibratedDiffPrompt,
 * no output-format reminder) broke that transcription for the expert-panel
 * skeptic — 3 of 10 cases had the skeptic's own reasoning conclude
 * "verdict—reported" for a concrete, real defect while `findings` stayed
 * empty. Recall came back near-zero (3.3%), but the panel's OWN investigation
 * was often working — this reminder exists to fix that gap, not because the
 * roles/skeptic mechanism itself was re-measured as bad. */
const AGENT_LOOP_OUTPUT_FORMAT_REMINDER = `

<OutputFormat>
  Report findings by calling the submitResult tool — do not just narrate a verdict in your
  reasoning text. If your own analysis concludes a concrete defect is real (including after
  challenging a dismissal or a silent lens), it MUST become an entry in the "suggestions"
  array — writing "reported" or "confirmed" in your reasoning without a matching suggestions
  entry means the finding is LOST, not submitted.

  Each suggestion needs: relevantFile, language, suggestionContent (WHAT the problem is, WHY
  it matters, HOW to fix if clear), existingCode, improvedCode (if a fix is clear),
  relevantLinesStart/relevantLinesEnd, severity (critical|high|medium|low), and confidence
  (1-10, honest — 9-10 only when you verified both caller and callee).
</OutputFormat>`;

/**
 * Diff + BUG/PERFORMANCE/SECURITY definitions + the output-format reminder
 * above — the expert-panel sibling of calibratedDiffPrompt, for
 * `expertPanelDedicatedPrompt` (see finder.agent.ts's expertPanelBasePrompt).
 * First cut of this knob was bare calibratedDiffPrompt with NO output-format
 * reminder — see AGENT_LOOP_OUTPUT_FORMAT_REMINDER's doc for what that broke.
 * With the reminder fixed, re-measured (20 PRs, via `recognitionPanel`
 * standalone) — the output-loss bug was fixed, but the underlying
 * roles+skeptic mechanism itself was discarded anyway (F1 0.361, see
 * review-agent.contract.ts's recognitionPanel doc). This base-prompt
 * builder is not itself the reason it was discarded — the mechanism was
 * re-measured as genuinely mediocre once its output pipe was intact. */
function expertPanelDedicatedBase(
    changedFiles: AgentLoopInput['changedFiles'],
): string {
    return calibratedDiffPrompt(changedFiles) + AGENT_LOOP_OUTPUT_FORMAT_REMINDER;
}

/**
 * Category definitions + output-format reminder, NO diff — for
 * `criticalFileDedicatedPrompt` (atomicHunks/atomicFiles/criticalFilePasses,
 * see finder.agent.ts's criticalFileBasePrompt). Unlike
 * expertPanelDedicatedBase, this carries no diff of its own: the caller
 * (buildCriticalFilePrompt's <SingleFileFocus>) already injects that one
 * file/hunk's diff downstream — prepending the WHOLE PR's diff here too
 * would defeat the isolation these passes exist for.
 *
 * MEASURED (30 PRs, atomicFiles, from an earlier session predating this
 * investigation's MEASURED-annotation habit): F1 0.327, below baseline — see
 * finder.agent.ts:buildCriticalFilePrompt's doc. That version used the FULL
 * generalist userPrompt (the whole diff still sitting in context) plus an
 * "ignore the diffs above" instruction — the same confound this session
 * found and fixed for the scout and expert-panel. Untested whether a
 * genuinely isolated base (this one) changes that result. */
const CRITICAL_FILE_DEDICATED_BASE =
    DETECTION_CATEGORIES_BLOCK + AGENT_LOOP_OUTPUT_FORMAT_REMINDER;

/**
 * Diff + ONLY one category's definitions — the per-category sibling of
 * calibratedDiffPrompt, for `scoutByCategory` (three parallel scouts, one per
 * category, see scout-investigator.ts:runScoutByCategory). A prior
 * "3-category-scouts" experiment gave every scout the FULL userPrompt with
 * just a one-line focus sentence on top — never actually isolated to its own
 * category. This is the genuinely isolated version — MEASURED (20 PRs) and
 * discarded anyway: F1 0.418 vs 0.456 for one scout with all three
 * categories' definitions (scoutCalibratedPrompt), at higher cost. See
 * scout-investigator.ts:runScoutByCategory's doc. */
function categoryDiffPrompt(
    changedFiles: AgentLoopInput['changedFiles'],
    category: 'bug' | 'performance' | 'security',
): string {
    const diff = rawDiffPrompt(changedFiles);
    return `${diff}

<DetectionCategory category="${category}">
  A defect worth flagging in this category:
${V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT[category]}
</DetectionCategory>`;
}

/**
 * Every hunk of every changed file, split purely from the diff's own `@@`
 * markers — no tier scoring, no model call. This is the whole-PR variant of
 * `criticalFilesFrom`: instead of one pass per critical FILE, one pass per
 * hunk of EVERY file. Multiple entries share the same `path` when a file has
 * several hunks; each still gets its own isolated pass (buildCriticalFilePrompt
 * scopes reporting to `path`, not to a specific hunk, so a later hunk's pass
 * sees earlier hunks' findings for the same file via the "already reported"
 * list — intentional, it prevents the same file's hunks from duplicating a
 * finding that spans more than one hunk).
 */
function atomicHunksFrom(
    changedFiles: AgentLoopInput['changedFiles'],
): Array<{ path: string; diff: string }> | undefined {
    const picked = (changedFiles ?? [])
        .filter((f) => f?.filename)
        .flatMap((f) => {
            const patch = (f.patchWithLinesStr ?? f.patch ?? '').trim();
            if (!patch) return [];
            return splitDiffIntoHunks(patch).map((diff) => ({
                path: f.filename as string,
                diff,
            }));
        });
    return picked.length ? picked : undefined;
}

/**
 * Every CHANGED FILE gets its own pass with its own full diff (all its hunks
 * together) — the coarser sibling of atomicHunksFrom. A file's hunks are
 * already grouped in `changedFiles` (one entry per file, one patch string with
 * every `@@` block), so this needs no splitting at all: unlike hunk-level,
 * where cost scales with hunk count (up to 26 in this set), this scales with
 * file count (capped at 6 by the dataset's own extraction), a much smaller
 * multiplier for PRs with few large hunks concentrated in few files.
 */
function atomicFilesFrom(
    changedFiles: AgentLoopInput['changedFiles'],
): Array<{ path: string; diff: string }> | undefined {
    const picked = (changedFiles ?? [])
        .filter((f) => f?.filename)
        .map((f) => ({
            path: f.filename as string,
            diff: (f.patchWithLinesStr ?? f.patch ?? '').trim(),
        }))
        .filter((f) => f.diff.length > 0);
    return picked.length ? picked : undefined;
}

export async function runAgentLoopViaCore(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
): Promise<AgentLoopOutput> {
    // The adapter resolves ONLY the slot — LLM.run (inside the runner) builds +
    // wraps the model (limiter with the finder's own queueTimeoutMs + reporter),
    // derives tuning, applies the prompt-cache, and records the cost span. The
    // finder's config-derived reasoning is passed as a spec override below.
    const runner = new AiSdkAgentRunner(secrets.byokConfig, {
        organizationId: input.telemetryMetadata?.organizationId,
        provider:
            typeof input.byokProvider === 'string'
                ? input.byokProvider
                : undefined,
        queueTimeoutMs: secrets.byokQueueTimeoutMs,
        reporter: secrets.byokErrorReporter,
        prebuiltModel: secrets.prebuiltModel,
    });

    const { registry: tools, cache: toolCache } = buildFinderToolRegistry({
        remoteCommands: secrets.remoteCommands,
        gitHubToken: secrets.gitHubToken,
        repositoryFullName: input.repositoryFullName,
        documentationSearchService: secrets.documentationSearchService,
        documentationSearchOptions: secrets.documentationSearchOptions,
        callGraph: input.callGraph,
        outlineFirst: input.outlineFirst,
        linkedRepoAccess: secrets.linkedRepoAccess,
    });

    const coverageLedger = new DiffCoverageLedger({
        changedFiles: input.changedFiles,
        fileTiers: input.fileTiers,
    });

    // Reasoning/thinking config (provider-specific) → providerOptions, forwarded
    // to every model call (finder + verifier). Ported from the legacy loop.
    const providerOptions = buildProviderOptions(
        input.agentName ?? 'finder',
        input.telemetryMetadata,
        {
            reasoningEffort: input.reasoningEffort,
            reasoningConfigOverride: input.reasoningConfigOverride,
            byokProvider: input.byokProvider,
            modelName: input.modelName,
            openrouterProviderOrder: input.openrouterProviderOrder,
            openrouterAllowFallbacks: input.openrouterAllowFallbacks,
        },
    );

    // Recall-pass gating — ported from the legacy loop: skip the heavy passes in
    // fast mode, self-contained (no tools) trial flow, or when the caller asks.
    // EXCEPTION: an explicit `heavy` opt-in (CLI `--heavy` / PR `@kody review
    // --heavy`) forces the recall passes to run regardless — the whole point of
    // heavy is more recall via resampling, so it must not be silently nullified
    // by the default fast/self-contained gating.
    const isSelfContained = tools.list().length === 0;
    const skipHeavyPasses =
        !input.heavy &&
        (input.reviewMode === 'fast' ||
            isSelfContained ||
            !!input.skipHeavyPasses);
    const skipSynthesisRescue = !!input.skipSynthesisRescue;

    const contextWindowTokens = input.contextWindowTokens;
    // Fixed per-request overhead (system prompt + tool schemas) the provider
    // re-sends on EVERY step. Counting it lets the compressor reserve a real
    // budget for the accumulating tool-loop messages instead of over-committing
    // the window — the miss behind the mid-loop overflow (issue #1574).
    // buildFinderAgentSpec adds submitResultTool to the model's tool set, so its
    // schema (~210 tokens) is part of the real overhead and must be counted too
    // — it matters on small windows where the safety margin is tight.
    const overheadTokens = contextWindowTokens
        ? estimateOverheadTokens(input.systemPrompt, [
              ...tools.list(),
              submitResultTool,
          ])
        : 0;
    // The finder spec's modelId is NOT used to resolve the model (LLM.run does
    // that, from the slot). It IS used to decide provider-native strict tool use
    // (supportsStrictTools), so pass the REAL model id straight off the resolved
    // slot — the same id `buildModelFromSlot` would have stamped on the built
    // model. Undefined (managed/env default → no slot) degrades to 'resolved',
    // which disables strict — parity with before, since the managed default
    // isn't a strict-capable (Gemini) model.
    const specModelId = secrets.byokConfig?.model ?? 'resolved';
    // The runtime failover target (if the slot has one). Strict tool use must
    // account for it: LLM.run can swap primary → fallback mid-call, and a strict
    // tool built for the primary would be rejected by a non-strict fallback
    // (e.g. Gemini primary → OpenAI fallback). See supportsStrictToolsForRun.
    const fallbackModelId = secrets.byokConfig?.fallback?.model;
    const buildSpecWithLedger = (
        ledger: DiffCoverageLedger,
        maxStepsOverride?: number,
        systemPromptOverride?: string,
    ) =>
        buildFinderAgentSpec({
            systemPrompt: systemPromptOverride ?? input.systemPrompt,
            requireFindingReason: input.requireFindingReason,
            modelId: specModelId,
            fallbackModelId,
            usageRunName: input.usageRunName,
            agentName: input.agentName,
            tools,
            coverageLedger: ledger,
            compressor: contextWindowTokens
                ? new ContextWindowCompressor(contextWindowTokens, {
                      overheadTokens,
                  })
                : undefined,
            maxSteps: maxStepsOverride ?? input.maxSteps ?? 20,
            providerOptions,
        });

    // Base pass uses the reported `coverageLedger` (read back below for the
    // coverage summary). Heavy resample passes run CONCURRENTLY, so each gets a
    // FRESH ledger via makeResampleSpec — the CompletionGatePolicy mutates the
    // ledger per tool call, and a shared one would race across parallel passes.
    // Routing step: which of the twelve classes this diff could even contain.
    // Falls back to all twelve on any failure — a planner that errors must not
    // quietly turn a full review into a partial one.
    const microPlan =
        input.microAgents && input.microPlanner
            ? await runMicroPlanner(
                  rawDiffPrompt(input.changedFiles, input.fileTiers, input.diffTierBudget),
                  secrets.byokConfig,
                  input.telemetryMetadata?.organizationId,
                  input.usageRunName,
              )
            : null;
    const microGroups = microPlan?.groups ?? MICRO_AGENTS;

    const finderSpec = buildSpecWithLedger(coverageLedger);

    // scoutVerdict (A/B knob): run the scout FIRST and hand its flags to the
    // generalist as a mandatory checklist, instead of fanning out one
    // investigator per flag. See scout-investigator.ts:buildScoutVerdictBlock.
    // A scout failure must never block the review — the generalist runs on the
    // plain prompt, exactly as it would with the knob off.
    // adversarial (A/B knob): swap the review task for a break-it task. Uses a
    // diff-only base — the generalist's rules block would re-impose the
    // reviewer framing this knob exists to replace.
    let finderPrompt = input.adversarial
        ? buildAdversarialPrompt(rawDiffPrompt(input.changedFiles, input.fileTiers, input.diffTierBudget), true)
        : input.userPrompt;
    if (input.scoutVerdict) {
        try {
            const flags = await runScout(
                buildScoutPrompt(
                    input.userPrompt,
                    undefined,
                    input.scoutCap ?? MAX_SCOUT_FLAGS,
                ),
                secrets.byokConfig,
                input.telemetryMetadata?.organizationId,
                input.usageRunName,
            );
            finderPrompt = `${finderPrompt}${buildScoutVerdictBlock(flags)}`;
        } catch {
            /* scout is best-effort: keep the plain prompt */
        }
    }
    const makeResampleSpec = () =>
        buildSpecWithLedger(
            new DiffCoverageLedger({
                changedFiles: input.changedFiles,
                fileTiers: input.fileTiers,
            }),
        );
    // Critical-file / atomic-hunk passes get their OWN step budget: a pass
    // scoped to one hunk investigates far less than the full-PR pass, so a
    // lower cap forces it to conclude instead of exploring at the same depth
    // regardless of scope (measured: without this, a single-file pass used as
    // many tool calls as the whole-PR pass). Atomic (whole-diff) mode defaults
    // tighter than tier-based critical-file mode since it runs far more of
    // these passes per PR and the per-pass cost compounds.
    const criticalFileMaxSteps =
        input.criticalFileMaxSteps ??
        (input.atomicHunks || input.atomicFiles ? 10 : 20);
    const makeCriticalFileSpec = () =>
        buildSpecWithLedger(
            new DiffCoverageLedger({
                changedFiles: input.changedFiles,
                fileTiers: input.fileTiers,
            }),
            criticalFileMaxSteps,
        );

    // Overflow net (issue #1574): if a mis-sized window lets any finder sub-run
    // overflow mid-loop, re-run THAT pass once at a tighter window instead of
    // failing the review. Wrapping the shared runner covers every pass (base +
    // resamples + synthesis-rescue) at one seam. Only when a window is known —
    // otherwise `tighten` can't scale anything, so we skip the wrapper entirely.
    const tightenCompression = (spec: typeof finderSpec, scale: number) =>
        contextWindowTokens
            ? {
                  ...spec,
                  policies: spec.policies.map((p) =>
                      p.name === 'compression'
                          ? new CompressionPolicy(
                                new ContextWindowCompressor(
                                    Math.floor(contextWindowTokens * scale),
                                    { overheadTokens },
                                ),
                            )
                          : p,
                  ),
              }
            : spec;
    const finderRunner = contextWindowTokens
        ? new OverflowRecoveringRunner(runner, tightenCompression)
        : runner;

    // Standard agent run context: runId + a signal that aborts on the parent job
    // signal OR after the hard per-agent timeout. Shared with conversation +
    // business so every agent has the same cancellation/timeout guarantee.
    const { ctx, cleanup } = createAgentRunContext({
        runId: `${input.prNumber ?? 'pr'}:${input.agentName ?? 'finder'}`,
        parentSignal: input.parentSignal,
    });

    const r = await runFinderWithVerify(
        {
            runner: finderRunner,
            finderSpec,
            makeResampleSpec,
            modelId: specModelId,
            fallbackModelId,
            tools,
            providerOptions,
            skipHeavyPasses,
            skipSynthesisRescue,
            skipBasePass: input.skipBasePass,
            // HEAVY mode — extra critic pass. Only meaningful when heavy passes
            // run at all (not fast/self-contained); harmless otherwise.
            heavy: !!input.heavy && !skipHeavyPasses,
            // One pass per critical-tier file, OR one pass per changed FILE
            // (atomicFiles), OR one pass per diff HUNK of every file
            // (atomicHunks — the finest, wins if multiple are set). Gated the
            // same way as heavy: pointless in fast mode, impossible without
            // tools.
            criticalFiles:
                !skipHeavyPasses
                    ? (input.atomicHunks
                          ? atomicHunksFrom(input.changedFiles)
                          : input.atomicFiles
                            ? atomicFilesFrom(input.changedFiles)
                            : input.criticalFilePasses
                              ? criticalFilesFrom(
                                    input.fileTiers,
                                    input.changedFiles,
                                )
                              : undefined)
                    : undefined,
            criticalFileBasePrompt: input.criticalFileDedicatedPrompt
                ? CRITICAL_FILE_DEDICATED_BASE
                : undefined,
            makeCriticalFileSpec,
            // Expert panel — narrows FOCUS (one lens per role), not scope; runs
            // over the same whole-PR diff as the main pass. Gated like the
            // others: pointless in fast mode, impossible without tools.
            // roleEnsemble is the leaner, no-debate sibling: language +
            // security + performance only (no QA, no DBA), merged directly
            // instead of arbitrated — cheaper, no cross-examination step.
            // recognitionPanel: fixed roster targeting recognition-failure
            // patterns confirmed by this session's ceiling audit, not topic
            // categories — see expert-panel.ts:RECOGNITION_PANEL_ROLES.
            // Checked first: a genuinely different experiment, not a variant
            // of expertPanel/roleEnsemble.
            expertRoles:
                skipHeavyPasses
                    ? undefined
                    : input.recognitionPanel
                      ? RECOGNITION_PANEL_ROLES
                      : input.expertPanel
                        ? buildExpertRoles(input.changedFiles)
                        : input.roleEnsemble
                          ? buildExpertRoles(input.changedFiles, {
                                includeQa: false,
                                includeDba: false,
                            })
                          : undefined,
            expertArbitrate: input.roleEnsemble ? false : undefined,
            recognitionPanel: input.recognitionPanel,
            expertPanelBasePrompt: input.expertPanelDedicatedPrompt
                ? expertPanelDedicatedBase(input.changedFiles)
                : undefined,
            scoutInvestigator: input.scoutInvestigator && !skipHeavyPasses,
            scoutResample: input.scoutResample,
            scoutSecondRound: input.scoutSecondRound,
            scoutLineHint: input.scoutLineHint,
            hypothesisDriven: input.hypothesisDriven,
            investigatorGroupByFile: input.investigatorGroupByFile,
            scoutCap: input.scoutCap,
            challengeDismissals: input.challengeDismissals,
            secondLookSameFile: input.secondLookSameFile,
            secondLookAlways: input.secondLookAlways,
            secondLookForceReport: input.secondLookForceReport,
            feasibilityVerify: input.feasibilityVerify,
            skipVerify: input.skipVerify,
            parallelScout: input.parallelScout,
            selectorShard: input.selectorShard,
            // These four are load-bearing and were missing: this object is
            // built field-by-field, so anything added to the finder's params
            // but not listed HERE is dropped in silence. Four 30-PR runs went
            // by measuring the plan+grep default while reporting themselves as
            // graph-shard and raised-ceiling experiments.
            graphSites: input.graphSites,
            graphSitesOnly: input.graphSitesOnly,
            shardAltPrompt: input.shardAltPrompt,
            // Same base the expert panel uses: bare diff + what counts as a
            // defect + the reminder that a verdict must become a suggestions
            // entry. Everything the generalist carries that competes with the
            // shard's question — Workflow, CoverageContract, Rules, the
            // <Diffs> rendering — stays out.
            shardBasePrompt: input.shardDedicatedPrompt
                ? expertPanelDedicatedBase(input.changedFiles)
                : undefined,
            // One narrow pass per class of defect. Each gets its OWN system
            // prompt: inheriting the generalist's 21k ("review this PR, cover
            // every file, follow this workflow") is what made the shard workers
            // re-review the diff instead of doing their assignment, and the
            // whole point here is that the agent carries one class and nothing
            // else.
            // `simulationAgent` is a DIFFERENT procedure, not another class: no
            // category list at all, a walk through concrete states instead. It
            // rides the same plumbing because it is still one narrow pass with
            // its own prompt and system prompt — see core/simulation-agent.ts.
            // Os dois juntos quando ambos vem ligados: a simulacao e um
            // procedimento diferente, nao uma decima sexta classe, entao medir
            // o conjunto exige que ela rode AO LADO dos quinze, nao no lugar.
            microAgentPasses: (() => {
                // Undefined quando a flag esta desligada: os dois builders
                // omitem o bloco inteiro nesse caso. Vale para TODAS as
                // passadas — as doze de classe e a simulacao.
                const grafoParaOsAgentes = input.microAgentCallGraph
                    ? input.callGraph
                    : undefined;
                const ledger = () =>
                    new DiffCoverageLedger({
                        changedFiles: input.changedFiles,
                        fileTiers: input.fileTiers,
                    });
                const passes = [
                    ...(input.microAgents
                        ? microGroups.map((group) => ({
                              label: `micro-${group.id}`,
                              phase: 0,
                              prompt: buildMicroAgentPrompt(
                                  group,
                                  rawDiffPrompt(input.changedFiles, input.fileTiers, input.diffTierBudget),
                                  grafoParaOsAgentes,
                              ),
                              spec: buildSpecWithLedger(
                                  ledger(),
                                  input.maxSteps ?? 12,
                                  MICRO_AGENT_SYSTEM_PROMPT,
                              ),
                          }))
                        : []),
                    // FASE 1: depois dos agentes de classe, e vendo o que eles
                    // levantaram. Antes esta passada ia junto na fase 0 e o
                    // bloco <AlreadyRaised> so podia ser preenchido por fora
                    // (o eval injetava a saida de OUTRA rodada no dataset) —
                    // um estado que producao nunca tem, porque em producao nao
                    // existe rodada anterior. Rodando em fase ela recebe os
                    // candidatos desta mesma review, que e a unica forma de
                    // esse contexto existir de verdade.
                    ...(input.simulationAgent
                        ? [
                              {
                                  label: 'micro-simulate-the-change',
                                  phase: 1,
                                  prompt: (todos: FinderSuggestion[]) => {
                                      // O agente cross-file roda na fase 0 como
                                      // os outros, mas o que ele levanta NAO
                                      // entra aqui: <AlreadyRaised> existe para
                                      // a simulacao escolher terreno nao
                                      // coberto, e nao ha medida de como ela
                                      // reage a um achado que relaciona dois
                                      // arquivos. Fora da lista, o A/B do
                                      // agente novo mede so o agente novo.
                                      const prior = todos.filter(
                                          (p) =>
                                              (p as { producedBy?: string })
                                                  .producedBy !==
                                              `micro-${CROSS_FILE_AGENT_ID}`,
                                      );
                                      return buildSimulationPrompt(
                                          rawDiffPrompt(input.changedFiles, input.fileTiers, input.diffTierBudget),
                                          prior.length
                                              ? prior.map((p) => ({
                                                    file: p.relevantFile,
                                                    line: p.relevantLinesStart,
                                                    summary: p.oneSentenceSummary,
                                                }))
                                              : // Sem fase 0 (simulacao rodando
                                                // sozinha) nao ha o que passar;
                                                // o campo do dataset cobre o
                                                // caso experimental.
                                                input.priorFindings,
                                          grafoParaOsAgentes,
                                      );
                                  },
                                  spec: buildSpecWithLedger(
                                      ledger(),
                                      input.maxSteps ?? 12,
                                      SIMULATION_SYSTEM_PROMPT,
                                  ),
                              },
                          ]
                        : []),
                ];
                return passes.length ? passes : undefined;
            })(),
            shardCap: input.shardCap,
            shardPerWorker: input.shardPerWorker,
            changedFilePaths: (input.changedFiles ?? [])
                .map((f) => f?.filename)
                .filter(Boolean) as string[],
            // Repo-wide search for the selectors. Goes through the same
            // remoteCommands the tools use, so it hits the sandbox in
            // production and the real worktree in the eval.
            runGrep: input.selectorShard
                ? async (pattern: string) => {
                      try {
                          return await (secrets.remoteCommands?.grep?.(pattern, '.') ??
                              Promise.resolve(''));
                      } catch {
                          return '';
                      }
                  }
                : undefined,
            runPlan: input.selectorShard
                ? (prompt: string, cap: number) =>
                      runPlan(
                          prompt,
                          secrets.byokConfig,
                          input.telemetryMetadata?.organizationId,
                          input.usageRunName,
                          cap,
                      )
                : undefined,
            freeformPass: input.freeformPass,
            freeformBasePrompt: input.freeformDedicatedPrompt
                ? rawDiffPrompt(input.changedFiles, input.fileTiers, input.diffTierBudget)
                : undefined,
            scoutBasePrompt: input.scoutDedicatedPrompt
                ? rawDiffPrompt(input.changedFiles, input.fileTiers, input.diffTierBudget)
                : input.scoutCalibratedPrompt
                  ? calibratedDiffPrompt(input.changedFiles)
                  : undefined,
            scoutByCategory: input.scoutByCategory,
            scoutCategoryBasePrompts: input.scoutByCategory
                ? {
                      bug: categoryDiffPrompt(input.changedFiles, 'bug'),
                      performance: categoryDiffPrompt(
                          input.changedFiles,
                          'performance',
                      ),
                      security: categoryDiffPrompt(
                          input.changedFiles,
                          'security',
                      ),
                  }
                : undefined,
            // Same decoupling as recoverProse below: finder.agent.ts calls this
            // function without knowing byokConfig exists.
            runScout: input.scoutInvestigator
                ? (prompt: string, category?: ScoutCategory, cap?: number) =>
                      runScout(
                          prompt,
                          secrets.byokConfig,
                          input.telemetryMetadata?.organizationId,
                          input.usageRunName,
                          category,
                          cap,
                          input.scoutThinking ? 'medium' : undefined,
                      )
                : undefined,
            previousDecisions: input.previousDecisions,
            telemetryMetadata: input.telemetryMetadata,
            agentName: input.agentName,
            usageRunName: input.usageRunName,
            // Wire the prose-findings recovery to the internal-model fallback.
            // The finder/recall passes stay decoupled from BYOK — they only see
            // the ProseRecoverer function.
            recoverProse: (reasoning: string) =>
                recoverFindingsFromProse(
                    reasoning,
                    secrets.byokConfig,
                    input.telemetryMetadata?.organizationId,
                    input.usageRunName,
                ),
        },
        { prompt: finderPrompt },
        ctx,
    ).finally(cleanup);

    // --- recall funnel made observable (ReviewFinding lifecycle) ---
    // Slice 1: the VERIFY gate — where recall dies most (verify drops the
    // majority of candidates). Building the lifecycle here (richest data: kept +
    // evidence + dropped + reason, all aligned) turns "30% recall" into an
    // attributable, per-severity/per-category dataset for the ratchet. Additive:
    // pure derivation + a structured log, zero behavior change.
    const findings = buildFindingsFromVerify(r, {
        agent: input.agentName ?? 'finder',
        pass: 'initial',
    });
    const funnel = summarizeFunnel(findings);
    funnelLogger.log({
        message: 'review recall funnel (verify gate)',
        context: 'review-funnel',
        metadata: {
            organizationId: input.telemetryMetadata?.organizationId,
            teamId: input.telemetryMetadata?.teamId,
            pullRequestId: input.telemetryMetadata?.pullRequestId,
            repositoryId: input.telemetryMetadata?.repositoryId,
            agent: input.agentName ?? 'finder',
            funnel,
            // Read-only tool memoization for this run: hits = repeated calls
            // served without re-execution (tokens saved). High hits = the agent
            // re-reads a lot — and the cache absorbed it.
            toolCache: toolCache.stats,
        },
    });

    // --- map RunState -> AgentLoopOutput (essential fields faithful) ---
    const toolCalls = r.finderState.steps.flatMap((s) =>
        (s.message.toolCalls ?? []).map((tc) => ({
            tool: tc.name,
            toolName: tc.name,
            args:
                tc.input && typeof tc.input === 'object'
                    ? (tc.input as Record<string, unknown>)
                    : {},
        })),
    );
    const coverage = coverageLedger.coverageSummary();

    // Usage = finder run + verify sub-step (the verify usage is NOT in
    // finderState — it is summed across the verifier runs). cacheWrite stays 0:
    // implicit-cache providers (Gemini/Moonshot) don't report write tokens.
    const fu = r.finderState.usage;
    const vu = r.verifyUsage;
    const ru = r.recallUsage; // extra finder runs (recovery/chances/synthesis)
    const inputTokens = (fu.inputTokens ?? 0) + vu.inputTokens + ru.inputTokens;
    const outputTokens =
        (fu.outputTokens ?? 0) + vu.outputTokens + ru.outputTokens;
    const reasoningTokens =
        (fu.reasoningTokens ?? 0) + vu.reasoningTokens + ru.reasoningTokens;
    const cacheReadTokens =
        (fu.cacheReadTokens ?? 0) + vu.cacheReadTokens + ru.cacheReadTokens;

    // Verify funnel made observable: before = kept + dropped, after = kept.
    const verifiedBefore = r.kept.length + r.droppedByVerify.length;
    const verification: VerificationTraceSummary | null =
        verifiedBefore === 0
            ? null
            : {
                  beforeCount: verifiedBefore,
                  afterCount: r.kept.length,
                  droppedByVerifier: r.droppedByVerify.length,
                  droppedByEvidenceFilter: 0,
                  decisions: [
                      ...r.kept.map((f, i) => ({
                          index: i,
                          relevantFile: f.relevantFile,
                          action: 'keep' as const,
                          parseMode: r.keptParseMode[i] ?? 'default-keep',
                          rationale: '',
                          verifierEvidence: r.keptEvidence[i] ?? {
                              strongFiles: [],
                              weakFiles: [],
                          },
                      })),
                      ...r.droppedByVerify.map((d, i) => ({
                          index: r.kept.length + i,
                          relevantFile: d.finding.relevantFile,
                          action: 'drop' as const,
                          parseMode: d.parseMode,
                          rationale: d.evidence ?? '',
                          verifierEvidence: d.verifierEvidence,
                      })),
                  ],
              };

    // When the finder run errored (a provider/model throw the harness caught
    // and turned into an error-status result), surface the underlying message
    // so the caller can classify it and fall back / fail loudly instead of
    // returning a silent empty review.
    const errorEvent =
        r.finderState.status === 'error'
            ? r.finderState.trace.find((e) => e.kind === 'error')
            : undefined;

    return {
        findings: { reasoning: r.reasoning, suggestions: r.kept as any },
        text: r.reasoning,
        steps: r.finderState.steps.length,
        toolCalls,
        finishReason: r.finderState.status,
        ...(errorEvent && {
            errorMessage: (errorEvent.detail?.message as string) || undefined,
            errorName: (errorEvent.detail?.name as string) || undefined,
            errorStatus: (errorEvent.detail?.status as number) ?? undefined,
            errorResponseBody:
                (errorEvent.detail?.responseBody as string) || undefined,
        }),
        source: r.kept.length || r.reasoning ? 'json-parse' : 'empty',
        usage: {
            inputTokens,
            cacheReadTokens,
            cacheWriteTokens: 0,
            outputTokens,
            reasoningTokens,
            totalTokens: inputTokens + outputTokens,
        },
        discardedBySeverity: [],
        droppedByVerify: r.droppedByVerify.map((d) => d.finding) as any,
        coverage,
        verification,
        recallPasses: r.passStats,
        shardPlan: r.shardPlan,
        scoutFlags: r.scoutFlags,
        verificationUsage: {
            inputTokens: vu.inputTokens,
            cacheReadTokens: vu.cacheReadTokens,
            cacheWriteTokens: 0,
            outputTokens: vu.outputTokens,
            reasoningTokens: vu.reasoningTokens,
        },
        anomalies: buildAgentAnomalies({
            steps: r.finderState.steps.length,
            toolCalls,
            coverage,
        }),
        warnings: [],
        debugTrace: r.finderState.trace as any,
    };
}
