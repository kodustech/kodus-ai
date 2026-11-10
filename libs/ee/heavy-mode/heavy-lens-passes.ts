/**
 * Enterprise Code — see `license_ee.md`. Heavy mode's lenses, built and run
 * next to the generalist. Teams / Enterprise plan gated at runtime via
 * `isHeavyModePlanAllowed` (heavy-mode-plan.ts).
 */
import type { AgentRunner, AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
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
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    FUZZER_FAILURE,
    GAP_AGENTS,
    GAP_AGENT_MAX_FINDINGS,
    GAP_AGENT_SYSTEM_PROMPT,
    buildFindReadersTool,
    buildFindSiblingsTool,
    buildRunSnippetTool,
    gapAgentMaxSteps,
} from './gap-agents';
import { bugHistoryLens, pastBugsFor, selectPastBugs } from './bug-history';
import { DEBATE_SYSTEM_PROMPT, type DebateVariant, debateProfiles, runDebate } from './debate';
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
    /** Whether the pass's findings stand, asked once the pass ends (the fuzz
     *  agent's stand only when a fuzzer run failed). */
    keepsFindings?: () => boolean;
    /** A pass that is more than one run (the debate, debate.ts): it runs
     *  itself and returns its findings and every run it made. */
    run?: (
        params: Parameters<HeavyLensRun>[0],
        ctx: ToolContext,
    ) => Promise<{ suggestions: FinderSuggestion[]; states: RunState[] }>;
}

/** The debate's second reviewer on another model (debate.ts). */
export interface DebatePartner {
    runner: AgentRunner;
    modelId: string;
    fallbackModelId?: string;
    providerOptions?: Readonly<Record<string, unknown>>;
    contextWindowTokens?: number;
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
    /** The sandbox's commands, for the experiment's agents' tools
     *  (gap-agents.ts). Without them those agents do not run. */
    remoteCommands?: RemoteCommands;
    /** The sandbox can run a program (E2B): the code-execution agent runs. */
    sandboxCanRun?: boolean;
    /** The debate's second reviewer runs on this model; absent → the same. */
    debatePartner?: DebatePartner;
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
    return [...heavyLensesFor(input.allowedLabels).map((lens) => ({
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
    })), ...buildGapAgentPasses(env, lensDiff), ...buildBugHistoryPasses(env, lensDiff), ...buildDebatePasses(env, lensDiff)];
}

/**
 * The debate experiment (debate.ts): one pass per variant, each two
 * reviewers with the finder's tools. The second runs on the partner's model
 * when there is one. Needs the repository, so not self-contained.
 */
function buildDebatePasses(env: HeavyLensEnvironment, lensDiff: string): HeavyLensPass[] {
    const { input } = env;
    if (env.isSelfContained) return [];
    const allowed = input.allowedLabels;
    const maxSteps = gapAgentMaxSteps((input.changedFiles ?? []).length);
    const partner = env.debatePartner;
    const specFor = (labels: FinderLabel[], onPartner: boolean) => {
        const window = onPartner ? (partner!.contextWindowTokens ?? env.contextWindowTokens) : env.contextWindowTokens;
        return buildFinderAgentSpec({
            systemPrompt: DEBATE_SYSTEM_PROMPT,
            modelId: onPartner ? partner!.modelId : env.modelId,
            fallbackModelId: onPartner ? partner!.fallbackModelId : env.fallbackModelId,
            usageRunName: input.usageRunName,
            agentName: input.agentName,
            tools: env.tools,
            labels,
            compressor: window ? new ContextWindowCompressor(window, { overheadTokens: env.overheadTokens }) : undefined,
            maxSteps,
            providerOptions: onPartner ? partner!.providerOptions : env.providerOptions,
            acceptsRevisions: !!input.previousDecisions?.length,
        });
    };
    return (['attack', 'focus'] as DebateVariant[]).flatMap((variant) => {
        const profiles = debateProfiles(variant).map((p) => ({ ...p, labels: p.labels.filter((l) => !allowed || allowed.includes(l)) }));
        if (profiles.some((p) => !p.labels.length)) return [];
        const [a, b] = profiles;
        const specA = specFor(a.labels, false);
        const specB = specFor(b.labels, !!partner);
        const label = `lens-debate-${variant}`;
        return [
            {
                label,
                findingLabel: a.labels[0],
                prompt: '',
                spec: specA,
                run: async (params, ctx) => {
                    const out = await runDebate({
                        variant,
                        label,
                        sides: [
                            { profile: a, runner: params.runner, spec: specA, modelId: env.modelId },
                            { profile: b, runner: partner?.runner ?? params.runner, spec: specB, modelId: partner?.modelId ?? env.modelId },
                        ],
                        diffText: lensDiff,
                        claudeWording: env.claudeWording,
                        lensBatch: input.lensBatch,
                        params,
                        ctx,
                    });
                    return { suggestions: out.suggestions, states: out.states };
                },
            },
        ];
    });
}

/**
 * The bug-history experiment (bug-history.ts): the past bugs closest to this
 * diff, once with their full text and once with the one-sentence summary, as
 * two passes so one run measures both. None when the repository has no
 * history.
 */
function buildBugHistoryPasses(env: HeavyLensEnvironment, lensDiff: string): HeavyLensPass[] {
    const { input } = env;
    if (input.allowedLabels && !input.allowedLabels.includes('bug')) return [];
    const bugs = selectPastBugs(pastBugsFor(input), lensDiff);
    if (!bugs.length) return [];
    const maxSteps = gapAgentMaxSteps((input.changedFiles ?? []).length);
    return (['full', 'summary'] as const).map((format) => {
        const lens = bugHistoryLens(bugs, format);
        return {
            label: `lens-${lens.id}`,
            findingLabel: lens.label,
            maxFindings: GAP_AGENT_MAX_FINDINGS,
            prompt: buildHeavyLensPrompt(lens, lensDiff, env.claudeWording, env.isSelfContained, input.lensBatch),
            spec: buildFinderAgentSpec({
                systemPrompt: env.isSelfContained ? HEAVY_LENS_SELF_CONTAINED_SYSTEM_PROMPT : HEAVY_LENS_SYSTEM_PROMPT,
                modelId: env.modelId,
                fallbackModelId: env.fallbackModelId,
                usageRunName: input.usageRunName,
                agentName: input.agentName,
                tools: env.tools,
                labels: [lens.label],
                compressor: env.contextWindowTokens
                    ? new ContextWindowCompressor(env.contextWindowTokens, { overheadTokens: env.overheadTokens })
                    : undefined,
                maxSteps,
                providerOptions: env.providerOptions,
                acceptsRevisions: !!input.previousDecisions?.length,
            }),
        };
    });
}

/**
 * The experiment's agents (gap-agents.ts), with the lens prompt, their own
 * tools on top of the finder's, and the larger step budget. They need the
 * repository, so none runs self-contained; the code-execution and fuzz agents
 * run only where the sandbox can run a program.
 */
function buildGapAgentPasses(env: HeavyLensEnvironment, lensDiff: string): HeavyLensPass[] {
    const { input } = env;
    const remote = env.remoteCommands;
    if (env.isSelfContained || !remote) return [];
    const changed = new Set((input.changedFiles ?? []).map((f) => String(f?.filename ?? '')));
    const maxSteps = gapAgentMaxSteps(changed.size);
    const allowed = input.allowedLabels;
    return GAP_AGENTS.filter((a) => !allowed || allowed.includes(a.label))
        .filter((a) => (a.tools !== 'exec' && a.tools !== 'fuzz') || env.sandboxCanRun)
        .map((agent) => {
            let fuzzerFailed = false;
            const own =
                agent.tools === 'readers'
                    ? buildFindReadersTool(remote, changed)
                    : agent.tools === 'siblings'
                      ? buildFindSiblingsTool(remote)
                      : agent.tools === 'fuzz'
                        ? buildRunSnippetTool(remote, (out) => {
                              if (FUZZER_FAILURE.test(out)) fuzzerFailed = true;
                          })
                        : buildRunSnippetTool(remote);
            return {
                label: `lens-${agent.id}`,
                ...(agent.tools === 'fuzz' && { keepsFindings: () => fuzzerFailed }),
                findingLabel: agent.label,
                maxFindings: GAP_AGENT_MAX_FINDINGS,
                prompt: buildHeavyLensPrompt(agent, lensDiff, env.claudeWording, false, input.lensBatch),
                spec: buildFinderAgentSpec({
                    systemPrompt: GAP_AGENT_SYSTEM_PROMPT,
                    modelId: env.modelId,
                    fallbackModelId: env.fallbackModelId,
                    usageRunName: input.usageRunName,
                    agentName: input.agentName,
                    tools: new InMemoryToolRegistry([...env.tools.list(), own]),
                    labels: [agent.label],
                    compressor: env.contextWindowTokens
                        ? new ContextWindowCompressor(env.contextWindowTokens, {
                              overheadTokens: env.overheadTokens,
                          })
                        : undefined,
                    maxSteps,
                    providerOptions: env.providerOptions,
                    acceptsRevisions: !!input.previousDecisions?.length,
                }),
            };
        });
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
            if (pass.run) {
                const out = await pass.run(params, ctx);
                return {
                    pass,
                    state: out.states[0],
                    extraStates: out.states.slice(1),
                    suggestions: out.suggestions.map((s) => ({ ...s, producedBy: pass.label })),
                    ms: Date.now() - passT0,
                    passT0,
                };
            }
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
            if (pass.keepsFindings && returned.length && !pass.keepsFindings()) {
                finderLogger.warn({
                    message: `Heavy lens ${pass.label} returned ${returned.length} findings without the run its findings need; discarded`,
                    context: 'finder',
                    metadata: {
                        organizationId: params.telemetryMetadata?.organizationId,
                        teamId: params.telemetryMetadata?.teamId,
                        pullRequestId: params.telemetryMetadata?.pullRequestId,
                        lens: pass.label,
                        returned: returned.length,
                    },
                });
                returned.length = 0;
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
                extraStates: [] as RunState[],
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
        for (const s of [state, ...r.value.extraStates].filter(Boolean)) {
            usage = sumVerifyUsage(usage, usageOf(s.usage));
            for (const f of strongFilesFromRun(s)) investigatedFiles.add(f);
        }
        if (!state) return;
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
