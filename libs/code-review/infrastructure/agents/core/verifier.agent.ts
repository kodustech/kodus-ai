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

import {
    buildVerifierPrompt,
    buildFeasibilityVerifierPrompt,
} from '@libs/code-review/infrastructure/agents/prompts/verifier-prompt';
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import { supportsStrictToolsForRun } from '@libs/code-review/infrastructure/agents/core/model-strictness';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
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
    /** Failover target model id (when the slot has one). Strict tool use is only
     *  enabled when BOTH it and `modelId` support it — see supportsStrictToolsForRun. */
    fallbackModelId?: string;
    /** Cost-span run name (e.g. `code-review-bug-verify`) + agentName for the
     *  verify leaf usage span (bucketed to `review` by deriveArea). */
    runName?: string;
    agentName?: string;
    /** Same investigation tools as the finder (grep/readFile/...). */
    tools: ToolRegistry;
    maxSteps?: number;
    /** Provider options (reasoning/thinking config) forwarded to the model. */
    providerOptions?: Readonly<Record<string, unknown>>;
    /** Path-feasibility mode (A/B knob): inverted burden of proof — see
     *  buildFeasibilityVerifierPrompt. Default off = HV2 refute-to-drop. */
    feasibilityMode?: boolean;
}

export function buildVerifierAgentSpec(
    params: BuildVerifierSpecParams,
): AgentSpec {
    // The system prompt is static (the per-finding evidence goes in the
    // run prompt), so we build it once with a placeholder bundle.
    const { system } = params.feasibilityMode
        ? buildFeasibilityVerifierPrompt('', 0)
        : buildVerifierPrompt('', 0);
    const tools = new InMemoryToolRegistry([
        ...params.tools.list(),
        // Strict/structured done-tool for strict-capable models (Gemini
        // VALIDATED mode) so the verdict can't be omitted or emitted as prose.
        {
            ...submitVerdictTool,
            strict: supportsStrictToolsForRun(
                params.modelId,
                params.fallbackModelId,
            ),
        },
    ]);
    return {
        id: 'verifier',
        // Cost-span identity: LLM.run records the ONE verify usage span with this
        // runName; deriveArea buckets `code-review*` under `review`.
        runName: params.runName ?? 'code-review-verify',
        agentName: params.agentName,
        phase: 'verify',
        systemPrompt: system,
        tools,
        policies: [new BudgetPolicy()],
        maxSteps: params.maxSteps ?? 6,
        // CAPTURE: the runner materializes submitVerdict's payload into
        // RunState.artifacts — extractVerdict reads that, never re-scans steps.
        resultToolName: VERIFY_DONE_TOOL,
        providerOptions: params.providerOptions,
    };
}

/** Format a finding into the verifier's per-run task prompt. */
export function verifierPromptFor(
    finding: FinderSuggestion,
    feasibilityMode = false,
    /** Inclui no bundle o percurso que PRODUZIU o achado (`reason`). Opt-in.
     *
     *  Sem ele o verificador recebe cinco campos — arquivo, linhas, severidade,
     *  alegacao e trecho — e quatro passos de ferramenta para refutar. O
     *  percurso, que ja cita as linhas de escrita e de leitura que o finder
     *  seguiu, fica de fora, e o verificador gasta os quatro passos
     *  redescobrindo o que ja estava escrito. Medido no DeepSeek sem ele: 120
     *  de 125 grupos mantidos (96%).
     *
     *  Desligado por padrao — isto muda o prompt de producao, e o efeito em
     *  recall e precisao nao esta medido. */
    includeReason = false,
    /** Os OUTROS achados que o atribuidor juntou neste grupo, quando ha. Opt-in.
     *
     *  Hoje o grupo chega ao verificador como o representante mais uma lista de
     *  `file:line` — ele ve que o defeito aparece em tres lugares mas so le uma
     *  redacao. As outras podem descrever melhor, ou citar a linha que refuta.
     *  O bloco vai DEPOIS do achado principal e rotulado como evidencia extra,
     *  nao como alegacoes a julgar: o veredito continua sendo sobre um defeito
     *  so, senao o verificador passa a responder duas perguntas ao mesmo tempo. */
    outrosDoGrupo?: Array<{
        relevantFile?: string;
        relevantLinesStart?: number;
        relevantLinesEnd?: number;
        suggestionContent?: string;
        reason?: string;
    }>,
): string {
    const walk = includeReason
        ? (finding as { reason?: string }).reason
        : undefined;
    const bundle = [
        `File: ${finding.relevantFile}`,
        finding.relevantLinesStart != null
            ? `Lines: ${finding.relevantLinesStart}-${finding.relevantLinesEnd ?? finding.relevantLinesStart}`
            : '',
        `Severity: ${finding.severity ?? 'unknown'}`,
        `Claim: ${finding.suggestionContent}`,
        walk ? `Walk that produced it (the finder's own trace — verify it, do not assume it is right):\n${walk}` : '',
        finding.existingCode ? `Code:\n${finding.existingCode}` : '',
        outrosDoGrupo?.length
            ? [
                  `<OtherReportsOfTheSameDefect count="${outrosDoGrupo.length}">`,
                  '  Other reviewers reported what looks like the SAME defect as the claim above.',
                  '  These are NOT separate claims for you to judge — your verdict is about the one',
                  '  claim above, and nothing else. Use them only as extra evidence: one of them may',
                  '  name the line that settles it, or may be wrong in a way that exposes the claim.',
                  ...outrosDoGrupo.map((o, i) => {
                      const loc = `${o.relevantFile ?? '?'}${o.relevantLinesStart != null ? `:${o.relevantLinesStart}-${o.relevantLinesEnd ?? o.relevantLinesStart}` : ''}`;
                      return [
                          `  [${i + 1}] ${loc}`,
                          `      claim: ${String(o.suggestionContent ?? '').slice(0, 600)}`,
                          o.reason ? `      walk:  ${String(o.reason).slice(0, 600)}` : '',
                      ]
                          .filter(Boolean)
                          .join('\n');
                  }),
                  '</OtherReportsOfTheSameDefect>',
              ].join('\n')
            : '',
    ]
        .filter(Boolean)
        .join('\n');
    return feasibilityMode
        ? buildFeasibilityVerifierPrompt(bundle, 0).prompt
        : buildVerifierPrompt(bundle, 0).prompt;
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
    /** Failover target model id — threaded to the verifier spec so strict tool
     *  use accounts for it (a Gemini→OpenAI failover must not send strict). */
    fallbackModelId?: string;
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
    /** Langfuse telemetry context (org/team/PR/repo) — each per-finding verify
     *  run is named so the trace shows WHICH finding each verdict judged. */
    telemetryMetadata?: LangfuseTelemetryMetadata;
    /** Agent name (finder/security/...) — prefixes the verify observation name. */
    agentName?: string;
    /** Cost-span run name base (e.g. `code-review-bug`). The verify runs record
     *  their leaf usage span under `${usageRunName}-verify` so `deriveArea`
     *  buckets them to `review` (verify is part of the review cost). */
    usageRunName?: string;
    /** Path-feasibility mode (A/B knob) — see buildFeasibilityVerifierPrompt. */
    feasibilityMode?: boolean;
    /** A/B: manda o `reason` do achado junto no bundle. Ver verifierPromptFor. */
    includeReason?: boolean;
    /** A/B: resolve os outros membros do grupo para o bundle. Recebe o candidato
     *  e devolve as outras redacoes do MESMO defeito. Ver verifierPromptFor. */
    resolveGroupMembers?: (
        candidate: FinderSuggestion,
    ) => Parameters<typeof verifierPromptFor>[3];
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
        const verifyRunName = params.usageRunName
            ? `${params.usageRunName}-verify`
            : 'code-review-verify';
        this.lightSpec = buildVerifierAgentSpec({
            modelId: params.modelId,
            fallbackModelId: params.fallbackModelId,
            runName: verifyRunName,
            agentName: params.agentName,
            tools: params.tools,
            maxSteps: params.lightMaxSteps ?? 5,
            providerOptions: params.providerOptions,
            feasibilityMode: params.feasibilityMode,
        });
        this.fullSpec = buildVerifierAgentSpec({
            modelId: params.modelId,
            fallbackModelId: params.fallbackModelId,
            runName: verifyRunName,
            agentName: params.agentName,
            tools: params.tools,
            maxSteps: params.fullMaxSteps ?? 10,
            providerOptions: params.providerOptions,
            feasibilityMode: params.feasibilityMode,
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
                prompt: verifierPromptFor(
                    candidate,
                    this.params.feasibilityMode,
                    this.params.includeReason,
                    this.params.resolveGroupMembers?.(candidate),
                ),
                ...toAiSdkTelemetryArgs(
                    buildLangfuseTelemetry(
                        fnId,
                        this.params.telemetryMetadata,
                    ),
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
