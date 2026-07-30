/**
 * Business-rules verify gate (doer≠checker) — built on the harness verify
 * primitive. The analyzer (doer) can over-flag: claim the PR misses a task
 * requirement when the diff actually covers it. This Verifier (checker) is a
 * second, independent pass that REFUTES the claim — the same refute-to-drop
 * discipline (HV2) the code-review verifier uses, here for ValidationResult.
 *
 * Fail-open: only an explicit keep=false drops the claimed violation. The schema
 * parser (validation-result.parser) is untouched — this is a SEMANTIC gate on
 * top of it, not a replacement.
 *
 * Pure of code-review: reuses `@libs/agent-harness` verify scaffolding, so the
 * skills layer never depends on the review domain.
 */
import type { AgentRunner } from '@libs/agent-harness/domain/contracts/agent.contract';
import type { TokenUsage } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type {
    ToolContext,
    ToolRegistry,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import type {
    Verdict,
    Verifier,
} from '@libs/agent-harness/domain/contracts/verifier.contract';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import {
    buildVerifierAgentSpec,
    extractVerdict,
} from '@libs/agent-harness/infrastructure/verify/llm-verdict';
import {
    buildLangfuseTelemetry,
    type LangfuseTelemetryMetadata,
} from '@libs/core/log/langfuse';

import type { ValidationResult } from './types';

const SYSTEM_PROMPT = [
    'You audit a business-rules validation verdict produced by another agent.',
    'The analyzer claims the PR does NOT correctly implement the task requirements.',
    'Your ONLY job: decide whether that claimed violation genuinely holds.',
    '',
    'Default to keep=true (trust the analyzer). Set keep=false ONLY when you can',
    'concretely REFUTE the claim — i.e. the diff actually satisfies the task, or',
    'the claimed gap is unsupported by the diff/task you were given. When unsure,',
    'keep=true. Submit your decision via the submitVerdict tool.',
].join('\n');

export interface BusinessRulesVerifierParams {
    modelId: string;
    /** The PR diff the analyzer judged. */
    diff: string;
    /** The task requirements / acceptance criteria the analyzer judged against. */
    taskContext: string;
    /** System-configured language (LANGUAGE_CONFIG) — the rationale, which becomes
     *  user-facing on a refuted result, must be written in it (same standard as
     *  the analyzer and the review suggestions). */
    userLanguage?: string;
    /** Investigation tools (optional) — usually none; the evidence is provided. */
    tools?: ToolRegistry;
    maxSteps?: number;
    providerOptions?: Readonly<Record<string, unknown>>;
    telemetryMetadata?: LangfuseTelemetryMetadata;
}

export class BusinessRulesVerifier implements Verifier<ValidationResult> {
    private _usage: TokenUsage = {};

    /** Token usage of the last verify() run — the caller records it to the cost
     *  dataset (recordAgentRunUsage), same as the analyzer. */
    get usage(): TokenUsage {
        return this._usage;
    }

    constructor(
        private readonly runner: AgentRunner,
        private readonly params: BusinessRulesVerifierParams,
    ) {}

    async verify(
        candidate: ValidationResult,
        ctx: ToolContext,
    ): Promise<Verdict> {
        const lang = this.params.userLanguage?.trim();
        const systemPrompt = lang
            ? `${SYSTEM_PROMPT}\n\nWrite "rationale" as a complete, user-facing sentence in ${lang} (it is shown to the user when the violation is dropped). Do not mix languages.`
            : SYSTEM_PROMPT;
        const spec = buildVerifierAgentSpec({
            id: 'business-rules-verifier',
            systemPrompt,
            modelId: this.params.modelId,
            tools: this.params.tools ?? new InMemoryToolRegistry([]),
            maxSteps: this.params.maxSteps ?? 4,
            providerOptions: this.params.providerOptions,
        });
        const state = await this.runner.run(
            spec,
            {
                prompt: this.buildPrompt(candidate),
                ...(this.params.telemetryMetadata
                    ? {
                          telemetry: buildLangfuseTelemetry(
                              'business-rules/verify',
                              this.params.telemetryMetadata,
                          ),
                      }
                    : {}),
            },
            ctx,
        );
        this._usage = state.usage;
        return extractVerdict(state);
    }

    private buildPrompt(result: ValidationResult): string {
        return [
            'Refute the analyzer claim below if the diff actually satisfies the task.',
            '',
            '## Task requirements',
            this.params.taskContext || '(none provided)',
            '',
            '## PR diff',
            this.params.diff || '(none provided)',
            '',
            "## Analyzer's claim (the alleged violation)",
            result.summary || '(no summary)',
            result.reason ? `Reason: ${result.reason}` : '',
            '',
            'Submit submitVerdict: keep=true if the violation genuinely holds; keep=false if the diff satisfies the task or the claim is unsupported.',
        ]
            .filter(Boolean)
            .join('\n');
    }
}

/**
 * Apply a verdict to a claimed-violation result (refute-to-drop). When the
 * verifier refutes (keep=false), the violation is dropped: the result is marked
 * verified-clean, carrying the verifier's rationale. keep=true leaves the
 * analyzer's result untouched. Pure — no LLM, trivially testable; the wiring
 * decides WHEN to call it (only on results that claim a violation).
 */
export function applyBusinessRulesVerdict(
    result: ValidationResult,
    verdict: Verdict,
): ValidationResult {
    if (verdict.keep) return result;
    return {
        ...result,
        needsMoreInfo: false,
        reason: undefined,
        confidence: verdict.confidence ?? 'low',
        // Use the verifier's rationale verbatim — it's written in the configured
        // language — instead of an English prefix that would mix languages.
        summary: verdict.rationale?.trim() || result.summary,
    };
}

/**
 * Gate for the verify pass: only an OPTED-IN, completed analysis is worth
 * auditing. `needsMoreInfo` and non-`analysis_ready` reasons are gating/failure
 * states (missing context, parser fallback) — there's no concluded verdict to
 * refute, so skip them. Clean (no-violation) analyses still pass through, and
 * the verifier fail-opens on them (nothing to refute → keep), so running on all
 * completed analyses is safe; the eval measures the cost of the extra calls.
 */
export function shouldVerifyValidationResult(
    result: ValidationResult,
    policy: { verifyAnalyzerResult?: boolean },
): boolean {
    return (
        !!policy.verifyAnalyzerResult &&
        !result.needsMoreInfo &&
        result.reason === 'analysis_ready'
    );
}
