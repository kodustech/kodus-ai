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
import { estimateOverheadTokens } from '@libs/agent-harness/infrastructure/compression/token-estimator';
import { DiffCoverageLedger } from '@libs/code-review/infrastructure/agents/adapters/diff-coverage-ledger.adapter';
import { buildFinderToolRegistry } from '@libs/code-review/infrastructure/agents/adapters/finder-tools.adapter';
import { wrapByokModel } from '@libs/llm/byok-model-wrapper';
import { anthropicSystemCacheControl } from '@libs/llm/system-cache';
import {
    buildFinderAgentSpec,
    runFinderWithVerify,
    recoverFindingsFromProse,
    submitResultTool,
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
// buildAgentAnomalies is review-specific (anomaly summary shapes) — lives in its
// own module (relocated out of the legacy llm/agent-loop.ts).
import { buildAgentAnomalies } from '@libs/code-review/infrastructure/agents/core/agent-anomalies';

const funnelLogger = createLogger('review-funnel');

export async function runAgentLoopViaCore(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
): Promise<AgentLoopOutput> {
    const model = wrapByokModel(input.model, {
        byokConfig: secrets.byokConfig,
        organizationId: input.telemetryMetadata?.organizationId,
        provider:
            typeof input.byokProvider === 'string'
                ? input.byokProvider
                : undefined,
        role: input.byokRole ?? 'main',
        queueTimeoutMs: secrets.byokQueueTimeoutMs,
        reporter: secrets.byokErrorReporter,
    });

    const runner = new AiSdkAgentRunner({ resolve: () => model });

    const { registry: tools, cache: toolCache } = buildFinderToolRegistry({
        remoteCommands: secrets.remoteCommands,
        repositoryFullName: input.repositoryFullName,
        callGraph: input.callGraph,
        outlineFirst: input.outlineFirst,
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
            openrouterProviderOrder: input.openrouterProviderOrder,
            openrouterAllowFallbacks: input.openrouterAllowFallbacks,
        },
    );

    // Anthropic prompt caching for the (large, static) system prompt — ported
    // from the legacy `withAnthropicCacheControl`. Cached across the loop's many
    // steps + every verifier run, so Claude models don't re-pay the system
    // prompt's input tokens each step. No-op for non-Anthropic models.
    const systemProviderOptions = anthropicSystemCacheControl(
        input.model,
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
    // The AgentSpec.modelId is NOT used to resolve the model (the runner's
    // resolver above ignores it and always returns `model`). It IS used to
    // decide provider-native strict tool use (supportsStrictTools), so pass the
    // REAL model id — a placeholder like 'resolved' would disable strict for
    // every model (it matches neither the Gemini nor the Claude pattern).
    const specModelId = (input.model as any)?.modelId ?? 'resolved';
    const buildSpecWithLedger = (ledger: DiffCoverageLedger) =>
        buildFinderAgentSpec({
            systemPrompt: input.systemPrompt,
            modelId: specModelId,
            tools,
            coverageLedger: ledger,
            compressor: contextWindowTokens
                ? new ContextWindowCompressor(contextWindowTokens, {
                      overheadTokens,
                  })
                : undefined,
            maxSteps: input.maxSteps ?? 20,
            providerOptions,
            systemProviderOptions,
        });

    // Base pass uses the reported `coverageLedger` (read back below for the
    // coverage summary). Heavy resample passes run CONCURRENTLY, so each gets a
    // FRESH ledger via makeResampleSpec — the CompletionGatePolicy mutates the
    // ledger per tool call, and a shared one would race across parallel passes.
    const finderSpec = buildSpecWithLedger(coverageLedger);
    const makeResampleSpec = () =>
        buildSpecWithLedger(
            new DiffCoverageLedger({
                changedFiles: input.changedFiles,
                fileTiers: input.fileTiers,
            }),
        );

    // Standard agent run context: runId + a signal that aborts on the parent job
    // signal OR after the hard per-agent timeout. Shared with conversation +
    // business so every agent has the same cancellation/timeout guarantee.
    const { ctx, cleanup } = createAgentRunContext({
        runId: `${input.prNumber ?? 'pr'}:${input.agentName ?? 'finder'}`,
        parentSignal: input.parentSignal,
    });

    const r = await runFinderWithVerify(
        {
            runner,
            finderSpec,
            makeResampleSpec,
            modelId: specModelId,
            tools,
            providerOptions,
            systemProviderOptions,
            skipHeavyPasses,
            skipSynthesisRescue,
            // HEAVY mode — extra critic pass. Only meaningful when heavy passes
            // run at all (not fast/self-contained); harmless otherwise.
            heavy: !!input.heavy && !skipHeavyPasses,
            telemetryMetadata: input.telemetryMetadata,
            agentName: input.agentName,
            // Wire the prose-findings recovery to the internal-model fallback.
            // The finder/recall passes stay decoupled from BYOK — they only see
            // the ProseRecoverer function.
            recoverProse: (reasoning: string) =>
                recoverFindingsFromProse(
                    reasoning,
                    secrets.byokConfig,
                    input.telemetryMetadata?.organizationId,
                ),
        },
        { prompt: input.userPrompt },
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
                          parseMode: 'direct' as const,
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
                          parseMode: 'direct' as const,
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
