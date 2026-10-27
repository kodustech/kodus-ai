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
import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';

import { ContextWindowCompressor } from '@libs/agent-harness/infrastructure/compression/context-window-compressor';
import { CompressionPolicy } from '@libs/agent-harness/infrastructure/policies/compression.policy';
import { OverflowRecoveringRunner } from './overflow-recovering-runner';
import { estimateOverheadTokens } from '@libs/agent-harness/infrastructure/compression/token-estimator';
import { DiffCoverageLedger } from '@libs/code-review/infrastructure/agents/adapters/diff-coverage-ledger.adapter';
import { buildFinderToolRegistry } from '@libs/code-review/infrastructure/agents/adapters/finder-tools.adapter';
import { buildRepoInstructionTool } from '@libs/code-review/infrastructure/agents/adapters/repo-instruction-tool';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import {
    FINDER_DONE_TOOL,
    buildFinderAgentSpec,
    runFinderWithVerify,
    recoverFindingsFromProse,
    submitResultTool,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import {
    buildFindingsFromVerify,
    summarizeFunnel,
} from '@libs/code-review/infrastructure/agents/core/review-finding';
import { inspectFindingsResult } from '@libs/code-review/infrastructure/agents/core/findings-schema';
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
import {
    AstGrepOutputLog,
    makeTargetBranchGuideLister,
    makeTargetBranchGuideReader,
    recordAstGrepOutputs,
} from '@libs/code-review/infrastructure/agents/core/convention-check';

const funnelLogger = createLogger('review-funnel');

/**
 * What one review agent runs with, its finder and its verifier alike: the
 * runner (wrapped to recover from a context overflow when the window is
 * known), the investigation tools, the provider options and the model ids.
 * Called by runAgentLoopViaCore; the funnel's verify eval builds its verifier
 * from it too.
 */
export function finderRunEnvironment(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
) {
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
    });

    const { registry: baseTools, cache: toolCache } = buildFinderToolRegistry({
        remoteCommands: secrets.remoteCommands,
        gitHubToken: secrets.gitHubToken,
        repositoryFullName: input.repositoryFullName,
        documentationSearchService: secrets.documentationSearchService,
        documentationSearchOptions: secrets.documentationSearchOptions,
        callGraph: input.callGraph,
        outlineFirst: input.outlineFirst,
        linkedRepoAccess: secrets.linkedRepoAccess,
        extraTools: secrets.extraTools,
    });
    // Without a sandbox or tools of the agent's own there are no repository
    // tools; that decides the self-contained regime, before the instructions
    // tool is added.
    const isSelfContained = baseTools.list().length === 0;
    const reviewTools =
        input.listsRepoInstructions && input.repoInstructions?.files?.length
            ? new InMemoryToolRegistry([
                  ...baseTools.list(),
                  buildRepoInstructionTool(input.repoInstructions),
              ])
            : baseTools;

    // Second pass for convention findings (custom agents): needs the guides
    // as they are on the target branch, so only with a sandbox that can run
    // git. Without one, convention findings fall back to HV2 like any other.
    const readGuide =
        input.conventionGuides !== undefined
            ? makeTargetBranchGuideReader(
                  secrets.remoteCommands,
                  input.baseBranch,
              )
            : undefined;
    // What ast-grep matched in this review: a convention finding it backs
    // needs no model check.
    const astGrepLog = readGuide ? new AstGrepOutputLog() : undefined;
    const tools = astGrepLog
        ? recordAstGrepOutputs(reviewTools, astGrepLog)
        : reviewTools;

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
    // Overflow net (issue #1574): if a mis-sized window lets any finder sub-run
    // overflow mid-loop, re-run THAT pass once at a tighter window instead of
    // failing the review. Wrapping the shared runner covers every pass (base +
    // resamples + synthesis-rescue) at one seam. Only when a window is known —
    // otherwise `tighten` can't scale anything, so we skip the wrapper entirely.
    const tightenCompression = (spec: AgentSpec, scale: number) =>
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

    return {
        tools,
        toolCache,
        isSelfContained,
        providerOptions,
        contextWindowTokens,
        overheadTokens,
        specModelId,
        fallbackModelId,
        finderRunner,
        readGuide,
        astGrepLog,
        // What verify runs with (verifyFindings), as runFinderWithVerify gets it.
        verifyParams: {
            runner: finderRunner,
            modelId: specModelId,
            fallbackModelId,
            tools,
            providerOptions,
            previousDecisions: input.previousDecisions,
            repoInstructions: input.repoInstructions,
            checksInstructionCitations: input.conventionGuides === undefined,
            telemetryMetadata: input.telemetryMetadata,
            agentName: input.agentName,
            usageRunName: input.usageRunName,
        },
    };
}

/**
 * A submitResult payload that arrived whole: the findings schema accepts it
 * and recovery dropped none of its items. On a cut turn a dropped item means
 * the result was damaged; the valid items still ship, the run is partial.
 */
function isWholeResult(payload: unknown): boolean {
    // Silent: extractFindings already logged this artifact. Items salvaged
    // before a break mean a cut payload: only those items survived (escaping
    // or dropping text after a whole array loses none). A
    // provider text node is not a finding the cut damaged (findings-schema.ts).
    const { result, drops, recoveries } = inspectFindingsResult(
        payload,
        undefined,
        { silent: true },
    );
    return (
        !!result &&
        !recoveries.some((r) => r.includes('salvaged-items')) &&
        drops.every((d) => d.reason === 'provider-text-node')
    );
}

export async function runAgentLoopViaCore(
    input: AgentLoopInput,
    secrets: AgentLoopSecrets,
): Promise<AgentLoopOutput> {
    const {
        tools,
        toolCache,
        isSelfContained,
        providerOptions,
        contextWindowTokens,
        overheadTokens,
        specModelId,
        fallbackModelId,
        verifyParams,
        readGuide,
        astGrepLog,
    } = finderRunEnvironment(input, secrets);

    const coverageLedger = new DiffCoverageLedger({
        changedFiles: input.changedFiles,
        fileTiers: input.fileTiers,
    });

    // Recall-pass gating — ported from the legacy loop: skip the heavy passes in
    // fast mode, self-contained (no tools) trial flow, or when the caller asks.
    const skipHeavyPasses =
        input.reviewMode === 'fast' ||
        isSelfContained ||
        !!input.skipHeavyPasses;
    const skipSynthesisRescue = !!input.skipSynthesisRescue;

    // The ledger is read back below for the coverage summary.
    const finderSpec = buildFinderAgentSpec({
        systemPrompt: input.systemPrompt,
        modelId: specModelId,
        fallbackModelId,
        usageRunName: input.usageRunName,
        agentName: input.agentName,
        tools,
        labels: input.allowedLabels,
        coverageLedger,
        compressor: contextWindowTokens
            ? new ContextWindowCompressor(contextWindowTokens, {
                  overheadTokens,
              })
            : undefined,
        maxSteps: input.maxSteps ?? 20,
        providerOptions,
        acceptsRevisions: !!input.previousDecisions?.length,
        acceptsConventions: !!readGuide,
    });

    // Standard agent run context: runId + a signal that aborts on the parent job
    // signal OR after the hard per-agent timeout. Shared with conversation +
    // business so every agent has the same cancellation/timeout guarantee.
    const { ctx, cleanup } = createAgentRunContext({
        runId: `${input.prNumber ?? 'pr'}:${input.agentName ?? 'finder'}`,
        parentSignal: input.parentSignal,
    });

    // A custom agent checks its findings on its own model (#2172). Same slot
    // as the finder, or none given: verify stays on the finder's runner.
    const verifySlot = secrets.verifyByokConfig;
    const verifyOnOwnModel =
        !!verifySlot &&
        (verifySlot.provider !== secrets.byokConfig?.provider ||
            verifySlot.model !== secrets.byokConfig?.model);
    const ownVerify = verifyOnOwnModel
        ? {
              verifyRunner: new AiSdkAgentRunner(verifySlot, {
                  organizationId: input.telemetryMetadata?.organizationId,
                  provider:
                      typeof verifySlot.provider === 'string'
                          ? verifySlot.provider
                          : undefined,
                  queueTimeoutMs: secrets.byokQueueTimeoutMs,
                  reporter: secrets.byokErrorReporter,
              }),
              verifyModelId: verifySlot.model ?? 'resolved',
              verifyFallbackModelId: verifySlot.fallback?.model,
              verifyProviderOptions: buildProviderOptions(
                  `${input.agentName ?? 'finder'}/verify`,
                  input.telemetryMetadata,
                  {
                      reasoningEffort: verifySlot.reasoningEffort,
                      reasoningConfigOverride:
                          verifySlot.reasoningConfigOverride,
                      byokProvider: verifySlot.provider,
                      modelName: verifySlot.model,
                      openrouterProviderOrder:
                          verifySlot.openrouterProviderOrder,
                      openrouterAllowFallbacks:
                          verifySlot.openrouterAllowFallbacks,
                  },
              ),
          }
        : {};

    const r = await runFinderWithVerify(
        {
            ...verifyParams,
            ...ownVerify,
            finderSpec,
            skipHeavyPasses,
            skipSynthesisRescue,
            teamSystemTools: input.teamSystemTools,
            laneFocus: input.laneFocus,
            ...(readGuide && {
                conventionCheck: {
                    readGuide,
                    listGuideDir: makeTargetBranchGuideLister(
                        secrets.remoteCommands,
                        input.baseBranch,
                    ),
                    guideFiles: input.conventionGuides,
                    teamInstructions: input.teamInstructions,
                    astGrepLog,
                },
            }),
            // Wire the prose-findings recovery to the internal-model fallback.
            // The finder/recall passes stay decoupled from BYOK — they only see
            // the ProseRecoverer function.
            recoverProse: (reasoning: string) =>
                recoverFindingsFromProse(
                    reasoning,
                    secrets.byokConfig,
                    input.telemetryMetadata?.organizationId,
                    input.usageRunName,
                    input.previousDecisions,
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
    const verifiedBefore =
        r.kept.length +
        r.droppedByVerify.length +
        r.unverified.length +
        r.droppedByQuoteCheck.length;
    const verification: VerificationTraceSummary | null =
        verifiedBefore === 0
            ? null
            : {
                  beforeCount: verifiedBefore,
                  afterCount: r.kept.length,
                  droppedByVerifier: r.droppedByVerify.length,
                  unverified: r.unverified.length,
                  ...(r.droppedByQuoteCheck.length > 0 && {
                      droppedByQuoteCheck: r.droppedByQuoteCheck.length,
                  }),
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
                      ...r.unverified.map((u, i) => ({
                          index: r.kept.length + r.droppedByVerify.length + i,
                          relevantFile: u.finding.relevantFile,
                          action: 'drop' as const,
                          parseMode: 'verify-error' as const,
                          rationale: u.error,
                          verifierEvidence: { strongFiles: [], weakFiles: [] },
                      })),
                  ],
              };

    // A finder run that ended without submitting a result did not finish
    // looking: it ran out of steps, or the provider cut its turn so the tools
    // it asked for never ran (the runner records that as `tool.skipped`). A run
    // that answered in prose is not incomplete; prose recovery owns it (#2171).
    // The runner makes an artifact of every requested result call, executed or
    // not, so a turn cut while writing submitResult leaves one holding raw,
    // unparseable input, an object that is no findings result (`{}`), or items
    // recovery had to drop: only a result that arrived whole counts.
    // The submitResult the review publishes: extractFindings reads the last.
    const published = [...r.finderState.artifacts]
        .reverse()
        .find((a) => a.type === FINDER_DONE_TOOL);
    const submitted = !!published && isWholeResult(published.payload);
    const incompleteReason: AgentLoopOutput['incompleteReason'] =
        r.finderState.status === 'budget-exhausted'
            ? 'budget-exhausted'
            : !submitted &&
                r.finderState.status !== 'error' &&
                r.finderState.trace.some((e) => e.kind === 'tool.skipped')
              ? 'truncated'
              : undefined;

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
        ...(incompleteReason && { incompleteReason }),
        submittedResult: submitted,
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
        droppedByVerify: r.droppedByVerify.map((d) => ({
            ...d.finding,
            discardReason: d.evidence,
        })) as any,
        unverifiedByVerify: r.unverified.map((u) => u.finding) as any,
        ...(r.droppedByQuoteCheck.length > 0 && {
            droppedByQuoteCheck: r.droppedByQuoteCheck.map((q) => ({
                ...q.finding,
                discardReason: q.detail,
            })) as any,
        }),
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
