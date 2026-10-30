/**
 * code-review (domain) — the convention verifier: the Verifier port for
 * findings that apply a team guide (`kind: 'convention'`).
 *
 * Same runner, tools, verdict extraction and fail-open contract as the HV2
 * LlmVerifier; only the judge differs. It sees the quoted rule and the guide
 * section the quote check located, and drops only when the code follows the
 * rule, the rule does not apply, or the rule does not say what the finding
 * claims (convention-verifier-prompt.ts).
 */
import type {
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type {
    ToolContext,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import type {
    Verdict,
    Verifier,
} from '@libs/agent-harness/domain/contracts/verifier.contract';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';
import type { PrDecisionRecord } from '@libs/code-review/domain/contracts/pr-decision-store.contract';
import type { FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';
import {
    buildVerifierAgentSpec,
    extractVerdict,
} from '@libs/code-review/infrastructure/agents/core/verifier.agent';
import { buildConventionVerifierPrompt } from '@libs/code-review/infrastructure/agents/prompts/convention-verifier-prompt';
import { formatPreviousDecisions } from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import { VERIFIER_REPEAT_RULE } from '@libs/code-review/infrastructure/agents/prompts/verifier-prompt';

/** The per-finding task prompt: the claim, the code, the quoted rule and the
 *  guide section that holds it. */
export function conventionVerifierPromptFor(
    finding: FinderSuggestion,
    sectionText: string,
    previousDecisions?: readonly PrDecisionRecord[],
): string {
    const source = finding.source;
    const bundle = [
        `File: ${finding.relevantFile}`,
        finding.relevantLinesStart != null
            ? `Lines: ${finding.relevantLinesStart}-${finding.relevantLinesEnd ?? finding.relevantLinesStart}`
            : '',
        `Severity: ${finding.severity ?? 'unknown'}`,
        `Claim: ${finding.suggestionContent}`,
        finding.existingCode ? `Code:\n${finding.existingCode}` : '',
        `Guide: ${source?.file ?? 'unknown'}${source?.section ? ` — ${source.section}` : ''}`,
        `Quoted rule: "${source?.quote ?? ''}"`,
        `Guide section:\n<GuideSection>\n${sectionText}\n</GuideSection>`,
        formatPreviousDecisions(previousDecisions),
        previousDecisions?.length ? VERIFIER_REPEAT_RULE : '',
    ]
        .filter(Boolean)
        .join('\n');
    return buildConventionVerifierPrompt(bundle, 0).prompt;
}

export interface ConventionVerifierParams {
    modelId: string;
    fallbackModelId?: string;
    tools: ToolRegistry;
    /** The guide section located by the quote check, per candidate. */
    sectionOf: (finding: FinderSuggestion) => string | undefined;
    maxSteps?: number;
    providerOptions?: Readonly<Record<string, unknown>>;
    telemetryMetadata?: LangfuseTelemetryMetadata;
    agentName?: string;
    usageRunName?: string;
    previousDecisions?: PrDecisionRecord[];
}

export class ConventionVerifier implements Verifier<FinderSuggestion> {
    private readonly accUsage = {
        inputTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        cacheReadTokens: 0,
    };

    private readonly spec: AgentSpec;

    constructor(
        private readonly runner: AgentRunner,
        private readonly params: ConventionVerifierParams,
    ) {
        this.spec = buildVerifierAgentSpec({
            modelId: params.modelId,
            fallbackModelId: params.fallbackModelId,
            runName: params.usageRunName
                ? `${params.usageRunName}-convention-verify`
                : 'code-review-convention-verify',
            agentName: params.agentName,
            tools: params.tools,
            maxSteps: params.maxSteps ?? 6,
            providerOptions: params.providerOptions,
            systemPrompt: buildConventionVerifierPrompt('', 0).system,
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
        const loc = candidate.relevantLinesStart
            ? `#${candidate.relevantLinesStart}`
            : '';
        const fnId = `${this.params.agentName ?? 'agent'}/convention-verify:${candidate.relevantFile}${loc}`;
        const state = await this.runner.run(
            this.spec,
            {
                prompt: conventionVerifierPromptFor(
                    candidate,
                    this.params.sectionOf(candidate) ?? '',
                    this.params.previousDecisions,
                ),
                ...toAiSdkTelemetryArgs(
                    buildLangfuseTelemetry(fnId, this.params.telemetryMetadata),
                ),
            },
            ctx,
        );
        const u = state.usage;
        this.accUsage.inputTokens += u.inputTokens ?? 0;
        this.accUsage.outputTokens += u.outputTokens ?? 0;
        this.accUsage.reasoningTokens += u.reasoningTokens ?? 0;
        this.accUsage.cacheReadTokens += u.cacheReadTokens ?? 0;
        return extractVerdict(state, this.params.telemetryMetadata);
    }
}
