/**
 * code-review (domain) — Verifier agent assembled on agent-harness.
 *
 * Step 5b: the verify stage as a verifier AgentSpec run on the SAME runner
 * (via verifyFindings), reusing the existing HV2 verifier prompt
 * (buildVerifierPrompt) and the same investigation tool surface as the finder.
 * This kills the duplicated hand-rolled verify loop.
 */
import type {
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { JSONSchema } from '@libs/agent-harness/domain/contracts/json-schema.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type {
    ToolContext,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import type {
    Verdict,
    Verifier,
} from '@libs/agent-harness/domain/contracts/verifier.contract';
import { BudgetPolicy } from '@libs/agent-harness/infrastructure/policies/budget.policy';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import { buildVerifierPrompt } from '@libs/code-review/infrastructure/agents/prompts/verifier-prompt';
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { supportsStrictTools } from '@libs/code-review/infrastructure/agents/core/model-strictness';
import {
    buildLangfuseTelemetry,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';

export const VERIFY_DONE_TOOL = 'submitVerdict' as const;

const VERDICT_SCHEMA: JSONSchema = {
    type: 'object',
    // Required by provider strict tool use (see finder.agent SUBMIT_RESULT_SCHEMA).
    additionalProperties: false,
    properties: {
        keep: { type: 'boolean' },
        rationale: { type: 'string' },
        confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    },
    required: ['keep', 'rationale'],
};

const submitVerdictTool = {
    name: VERIFY_DONE_TOOL,
    description:
        'Submit your verdict for the candidate finding (keep=true unless you can REFUTE it).',
    inputSchema: VERDICT_SCHEMA,
    execute: async () => ({ output: 'verdict recorded' }),
};

export interface BuildVerifierSpecParams {
    modelId: string;
    /** Same investigation tools as the finder (grep/readFile/...). */
    tools: ToolRegistry;
    maxSteps?: number;
    /** Provider options (reasoning/thinking config) forwarded to the model. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** Provider options attached to the system message (e.g. Anthropic prompt
     *  caching) so the verifier's system prompt is cached across steps. */
    systemProviderOptions?: Readonly<Record<string, unknown>>;
}

export function buildVerifierAgentSpec(
    params: BuildVerifierSpecParams,
): AgentSpec {
    // The HV2 system prompt is static (the per-finding evidence goes in the
    // run prompt), so we build it once with a placeholder bundle.
    const { system } = buildVerifierPrompt('', 0);
    const tools = new InMemoryToolRegistry([
        ...params.tools.list(),
        // Strict/structured done-tool for strict-capable models (Gemini
        // VALIDATED mode) so the verdict can't be omitted or emitted as prose.
        { ...submitVerdictTool, strict: supportsStrictTools(params.modelId) },
    ]);
    return {
        id: 'verifier',
        systemPrompt: system,
        modelId: params.modelId,
        tools,
        policies: [new BudgetPolicy()],
        maxSteps: params.maxSteps ?? 6,
        // CAPTURE: the runner materializes submitVerdict's payload into
        // RunState.artifacts — extractVerdict reads that, never re-scans steps.
        resultToolName: VERIFY_DONE_TOOL,
        providerOptions: params.providerOptions,
        systemProviderOptions: params.systemProviderOptions,
    };
}

/** Format a finding into the verifier's per-run task prompt (HV2 evidence). */
export function verifierPromptFor(finding: FinderSuggestion): string {
    const bundle = [
        `File: ${finding.relevantFile}`,
        finding.relevantLinesStart != null
            ? `Lines: ${finding.relevantLinesStart}-${finding.relevantLinesEnd ?? finding.relevantLinesStart}`
            : '',
        `Severity: ${finding.severity ?? 'unknown'}`,
        `Claim: ${finding.suggestionContent}`,
        finding.existingCode ? `Code:\n${finding.existingCode}` : '',
    ]
        .filter(Boolean)
        .join('\n');
    return buildVerifierPrompt(bundle, 0).prompt;
}

/** Extract the verdict from a verifier run by reading the run's materialized
 *  artifacts (the "result tool" convention — same as the finder). Default KEEP
 *  (refute-to-drop): only an explicit keep:false drops the finding. */
export function extractVerdict(state: RunState): Verdict {
    // The verifier's investigation tools for THIS finding — carried on the
    // verdict so the domain can attribute per-finding verifier evidence (which
    // files it read/grepped) to the observability trace. submitVerdict itself
    // is excluded (it's the result tool, not investigation).
    const toolCalls = collectVerifierToolCalls(state);
    for (let i = state.artifacts.length - 1; i >= 0; i--) {
        const artifact = state.artifacts[i];
        if (artifact.type !== VERIFY_DONE_TOOL) continue;
        const parsed = artifact.payload;
        if (
            parsed &&
            typeof parsed === 'object' &&
            typeof (parsed as Record<string, any>).keep === 'boolean'
        ) {
            const obj = parsed as Record<string, any>;
            return {
                keep: obj.keep,
                rationale: obj.rationale,
                confidence: obj.confidence,
                toolCalls,
            };
        }
    }
    return {
        keep: true,
        rationale: 'no parseable verdict — kept by default',
        toolCalls,
    };
}

/** Flatten the verifier run's investigation tool calls into the generic
 *  Verdict.toolCalls shape (name/args/result). */
function collectVerifierToolCalls(state: RunState): Verdict['toolCalls'] {
    const out: Array<{
        name: string;
        args?: Record<string, unknown>;
        result?: string;
    }> = [];
    for (const step of state.steps) {
        for (const tc of step.message.toolCalls ?? []) {
            if (tc.name === VERIFY_DONE_TOOL) continue;
            out.push({
                name: tc.name,
                args:
                    tc.input && typeof tc.input === 'object'
                        ? (tc.input as Record<string, unknown>)
                        : undefined,
                result: tc.output,
            });
        }
    }
    return out;
}

export interface LlmVerifierParams {
    modelId: string;
    tools: ToolRegistry;
    /** Depth for high-confidence findings (light verify). Default 5. */
    lightMaxSteps?: number;
    /** Depth for low-confidence findings (full verify). Default 10. */
    fullMaxSteps?: number;
    /** When true, ALWAYS use full depth regardless of confidence. Used by the
     *  evidence-gate re-verify, which forces a thorough second look. */
    forceFull?: boolean;
    /** Provider options (reasoning/thinking config) forwarded to the model. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** System-message provider options (e.g. Anthropic prompt caching). */
    systemProviderOptions?: Readonly<Record<string, unknown>>;
    /** Langfuse telemetry context (org/team/PR/repo) — each per-finding verify
     *  run is named so the trace shows WHICH finding each verdict judged. */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** Agent name (finder/security/...) — prefixes the verify observation name. */
    agentName?: string;
}

/** The LLM-judge Verifier (HV2): runs a verifier AgentSpec once per finding on
 *  the shared runner. ONE implementation of the Verifier port.
 *
 *  CONFIDENCE SPLIT (ported from the legacy loop): confidence decides DEPTH, not
 *  whether to run — high-confidence (>= 5) findings get a LIGHT verify (fewer
 *  steps), low-confidence get a FULL verify (more steps). `forceFull` overrides
 *  to full (the evidence-gate uses it).
 *
 *  It accumulates token usage across every verify() call so the caller can
 *  report the verify sub-step's cost. */
export class LlmVerifier implements Verifier<FinderSuggestion> {
    private readonly accUsage: {
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        cacheReadTokens: number;
    } = { inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0 };

    private readonly lightSpec: AgentSpec;
    private readonly fullSpec: AgentSpec;

    constructor(
        private readonly runner: AgentRunner,
        private readonly params: LlmVerifierParams,
    ) {
        this.lightSpec = buildVerifierAgentSpec({
            modelId: params.modelId,
            tools: params.tools,
            maxSteps: params.lightMaxSteps ?? 5,
            providerOptions: params.providerOptions,
            systemProviderOptions: params.systemProviderOptions,
        });
        this.fullSpec = buildVerifierAgentSpec({
            modelId: params.modelId,
            tools: params.tools,
            maxSteps: params.fullMaxSteps ?? 10,
            providerOptions: params.providerOptions,
            systemProviderOptions: params.systemProviderOptions,
        });
    }

    /** Total token usage across all verify() calls made so far. */
    get usage(): Readonly<typeof this.accUsage> {
        return this.accUsage;
    }

    async verify(
        candidate: FinderSuggestion,
        ctx: ToolContext,
    ): Promise<Verdict> {
        // Confidence decides DEPTH (legacy rule): >= 5 → light, < 5 → full.
        const useFull =
            this.params.forceFull || (candidate.confidence ?? 5) < 5;
        const spec = useFull ? this.fullSpec : this.lightSpec;

        // Per-finding observation name so the trace shows which finding each
        // verdict judged (e.g. "finder/verify:src/x.ts#42").
        const loc = candidate.relevantLinesStart
            ? `#${candidate.relevantLinesStart}`
            : '';
        const fnId = `${this.params.agentName ?? 'agent'}/verify:${candidate.relevantFile}${loc}`;
        const state = await this.runner.run(
            spec,
            {
                prompt: verifierPromptFor(candidate),
                telemetry: buildLangfuseTelemetry(
                    fnId,
                    this.params.telemetryMetadata,
                ),
            },
            ctx,
        );
        const u = state.usage;
        this.accUsage.inputTokens += u.inputTokens ?? 0;
        this.accUsage.outputTokens += u.outputTokens ?? 0;
        this.accUsage.reasoningTokens += u.reasoningTokens ?? 0;
        this.accUsage.cacheReadTokens += u.cacheReadTokens ?? 0;
        return extractVerdict(state);
    }
}
