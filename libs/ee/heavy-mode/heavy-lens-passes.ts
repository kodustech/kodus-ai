/**
 * Enterprise Code — see `license_ee.md`. Heavy mode's lenses, built and run
 * next to the generalist. Teams / Enterprise plan gated at runtime via
 * `isHeavyModePlanAllowed` (heavy-mode-plan.ts).
 */
import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type {
    ToolContext,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import { ContextWindowCompressor } from '@libs/agent-harness/infrastructure/compression/context-window-compressor';
import {
    type FinderSuggestion,
    type HeavyLensRun,
    type HeavyLensRunResult,
    type RecallPassStat,
    type VerifyUsage,
    ZERO_VERIFY_USAGE,
    buildFinderAgentSpec,
    extractFindingsWithRecovery,
    finderLogger,
    passStatOf,
    strongFilesFromRun,
    sumVerifyUsage,
    usageOf,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import type { FinderLabel } from '@libs/code-review/infrastructure/agents/engine/finding-labels';
import type { AgentLoopInput } from '@libs/code-review/infrastructure/agents/review-agent.contract';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import {
    HEAVY_LENS_MAX_FINDINGS,
    HEAVY_LENS_MAX_STEPS,
    HEAVY_LENS_SELF_CONTAINED_SYSTEM_PROMPT,
    HEAVY_LENS_SYSTEM_PROMPT,
    buildHeavyLensPrompt,
    heavyLensDiff,
    heavyLensesFor,
} from './heavy-lenses';

/** One heavy-mode lens, ready to run on the finder's runner. */
export interface HeavyLensPass {
    /** Names the pass in the trace and in `producedBy`. */
    label: string;
    /** The label every finding of the lens takes, whatever the model wrote. */
    findingLabel: FinderLabel;
    prompt: string;
    spec: AgentSpec;
    /** Findings kept from the lens, strongest first as its prompt asks. */
    maxFindings?: number;
}

/** What the lenses need from the finder's run environment. */
export interface HeavyLensEnvironment {
    input: Pick<
        AgentLoopInput,
        | 'changedFiles'
        | 'fileTiers'
        | 'allowedLabels'
        | 'lensBatch'
        | 'previousDecisions'
        | 'usageRunName'
        | 'agentName'
    >;
    claudeWording: boolean;
    isSelfContained: boolean;
    modelId: string;
    fallbackModelId?: string;
    tools: ToolRegistry;
    contextWindowTokens?: number;
    overheadTokens?: number;
    providerOptions?: Readonly<Record<string, unknown>>;
}

/**
 * The M3 lenses of the categories the team has on, or none when the diff
 * leaves them nothing to read. No completion gate: a lens's assignment is one
 * class of defect, not the diff's coverage, and with 3 steps the gate's
 * pending-file notes and vetoed submits only cost it steps.
 */
export function buildHeavyLensPasses(
    env: HeavyLensEnvironment,
): HeavyLensPass[] {
    const { input } = env;
    const lensDiff = heavyLensDiff(input.changedFiles, input.fileTiers);
    if (!lensDiff) return [];
    return heavyLensesFor(input.allowedLabels).map((lens) => ({
        label: `lens-${lens.id}`,
        findingLabel: lens.label,
        maxFindings: HEAVY_LENS_MAX_FINDINGS,
        prompt: buildHeavyLensPrompt(
            lens,
            lensDiff,
            env.claudeWording,
            env.isSelfContained,
            input.lensBatch,
        ),
        spec: buildFinderAgentSpec({
            systemPrompt: env.isSelfContained
                ? HEAVY_LENS_SELF_CONTAINED_SYSTEM_PROMPT
                : HEAVY_LENS_SYSTEM_PROMPT,
            modelId: env.modelId,
            fallbackModelId: env.fallbackModelId,
            usageRunName: input.usageRunName,
            agentName: input.agentName,
            tools: env.tools,
            labels: [lens.label],
            compressor: env.contextWindowTokens
                ? new ContextWindowCompressor(env.contextWindowTokens, {
                      overheadTokens: env.overheadTokens,
                  })
                : undefined,
            maxSteps: HEAVY_LENS_MAX_STEPS,
            providerOptions: env.providerOptions,
            acceptsRevisions: !!input.previousDecisions?.length,
        }),
    }));
}

/** The lenses as the finder's `heavyLenses` hook, or none to run. */
export function buildHeavyLensRun(
    env: HeavyLensEnvironment,
): HeavyLensRun | undefined {
    const passes = buildHeavyLensPasses(env);
    if (!passes.length) return undefined;
    return (params, ctx) => runHeavyLensPasses(passes, params, ctx);
}

/**
 * Heavy mode's lenses, all at once. A lens that fails costs only its own
 * findings: the review goes on with the generalist's and the other lenses'.
 * Every finding takes its lens's label (the lens looks for one class only, and
 * some models write a label of their own) and names the lens in `producedBy`.
 */
export async function runHeavyLensPasses(
    passes: HeavyLensPass[],
    params: Parameters<HeavyLensRun>[0],
    ctx: ToolContext,
): Promise<HeavyLensRunResult> {
    const t0 = Date.now();
    const settled = await Promise.allSettled(
        passes.map(async (pass) => {
            const passT0 = Date.now();
            const state = await params.runner.run(
                pass.spec,
                {
                    prompt: pass.prompt,
                    ...toAiSdkTelemetryArgs(
                        buildLangfuseTelemetry(
                            `${params.agentName ?? 'finder'}-${pass.label}`,
                            params.telemetryMetadata,
                        ),
                    ),
                },
                ctx,
            );
            const extracted = await extractFindingsWithRecovery(
                state,
                params.recoverProse,
                { ...params.telemetryMetadata, modelId: params.modelId },
            );
            const returned = (extracted.suggestions ?? []).filter(Boolean);
            if (
                pass.maxFindings !== undefined &&
                returned.length > pass.maxFindings
            ) {
                finderLogger.warn({
                    message: `Heavy lens ${pass.label} returned ${returned.length} findings; kept its first ${pass.maxFindings}`,
                    context: 'finder',
                    metadata: {
                        organizationId:
                            params.telemetryMetadata?.organizationId,
                        teamId: params.telemetryMetadata?.teamId,
                        pullRequestId: params.telemetryMetadata?.pullRequestId,
                        lens: pass.label,
                        returned: returned.length,
                        kept: pass.maxFindings,
                    },
                });
            }
            const suggestions = returned
                .slice(0, pass.maxFindings)
                .map((s) => ({
                    ...s,
                    label: pass.findingLabel,
                    producedBy: pass.label,
                }));
            return {
                pass,
                state,
                suggestions,
                ms: Date.now() - passT0,
                passT0,
            };
        }),
    );

    const suggestions: FinderSuggestion[] = [];
    const passStats: RecallPassStat[] = [];
    const investigatedFiles = new Set<string>();
    let usage = ZERO_VERIFY_USAGE;
    settled.forEach((r, i) => {
        if (r.status === 'rejected') {
            finderLogger.warn({
                message: `Heavy lens ${passes[i].label} failed; the review goes on without its findings`,
                context: 'finder',
                error: r.reason,
                metadata: {
                    organizationId: params.telemetryMetadata?.organizationId,
                    teamId: params.telemetryMetadata?.teamId,
                    pullRequestId: params.telemetryMetadata?.pullRequestId,
                    repositoryId: params.telemetryMetadata?.repositoryId,
                    lens: passes[i].label,
                },
            });
            return;
        }
        const { pass, state, ms, passT0 } = r.value;
        suggestions.push(...r.value.suggestions);
        usage = sumVerifyUsage(usage, usageOf(state.usage));
        for (const f of strongFilesFromRun(state)) investigatedFiles.add(f);
        passStats.push(
            passStatOf(state, {
                label: pass.label,
                added: r.value.suggestions.length,
                ms,
                startMs: passT0 - t0,
                startEpochMs: passT0,
            }),
        );
    });
    return { suggestions, usage, passStats, investigatedFiles };
}
