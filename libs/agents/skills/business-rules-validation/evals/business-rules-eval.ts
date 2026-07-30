/**
 * Runnable eval harness for the business-rules Verifier (Etapa 3 measurement).
 *
 * Closes the "eval is just a seam" gap: wires the real BusinessRulesVerifier +
 * the analyzer into the generic `runSkillEval` so you can MEASURE the verify
 * gate before turning it on. The two configurations compared are:
 *   - without_skill = the analyzer's raw ValidationResult (no verify)
 *   - with_skill    = the same result AFTER the Verifier + applyBusinessRulesVerdict
 * Graded against each case's assertions, so the delta tells you whether verify
 * drops false-positive violations WITHOUT dropping the real ones.
 *
 * Pure of any model: the caller injects `resolveModel` (their BYOK/stack model).
 * Runs on the stack, not in CI — see business-rules-eval.spec.ts (gated by env).
 */
import * as fs from 'fs';
import * as path from 'path';

import type { LanguageModel } from 'ai';

import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import { finalText } from '@libs/agent-harness/domain/run-state.util';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { createAgentRunContext } from '@libs/llm/agent-run-context';

import {
    applyBusinessRulesVerdict,
    BusinessRulesVerifier,
} from '@libs/agents/infrastructure/services/agents/business-rules-validation/business-rules-verifier';
import { parseBusinessRulesValidationResult } from '@libs/agents/infrastructure/services/agents/business-rules-validation/validation-result.parser';
import type { ValidationResult } from '@libs/agents/infrastructure/services/agents/business-rules-validation/types';

import {
    runSkillEval,
    type AnalyzeFn,
    type AssertionResult,
    type GradeFn,
    type SkillEvalSuite,
    type SkillEvalReport,
} from '@libs/agents/skills/eval/skill-eval-runner';

const EVAL_DIR = __dirname;
const SKILL_DIR = path.join(EVAL_DIR, '..');

/** Load evals.json and inline each case's fixture files (diff + task). */
export function loadBusinessRulesEvalSuite(): {
    suite: SkillEvalSuite;
    fixtures: Map<string | number, { diff: string; task: string }>;
} {
    const raw = JSON.parse(
        fs.readFileSync(path.join(EVAL_DIR, 'evals.json'), 'utf-8'),
    ) as SkillEvalSuite & { evals: Array<{ files?: string[] }> };

    const fixtures = new Map<string | number, { diff: string; task: string }>();
    for (const c of raw.evals) {
        const files = (c.files ?? []).map((f) =>
            fs.existsSync(path.join(SKILL_DIR, f))
                ? fs.readFileSync(path.join(SKILL_DIR, f), 'utf-8')
                : '',
        );
        const diff = files.find((_, i) => c.files?.[i]?.endsWith('.diff')) ?? '';
        const task = files.find((_, i) => c.files?.[i]?.endsWith('.md')) ?? '';
        fixtures.set((c as { id: string | number }).id, { diff, task });
    }
    return { suite: raw, fixtures };
}

/** Run the analyzer once (single-shot) over a fixture → ValidationResult + state. */
async function runAnalyzer(
    runner: AiSdkAgentRunner,
    system: string,
    diff: string,
    task: string,
): Promise<{ result: ValidationResult; state: unknown }> {
    const spec: AgentSpec = {
        id: 'br-eval-analyzer',
        systemPrompt: system,
        modelId: 'resolved',
        tools: new InMemoryToolRegistry([]),
        policies: [],
        maxSteps: 1,
    };
    const prompt = [
        '## Task requirements',
        task || '(none provided)',
        '',
        '## PR diff',
        diff || '(none provided)',
        '',
        'Return ONLY the JSON verdict object.',
    ].join('\n');
    const { ctx, cleanup } = createAgentRunContext({ runId: 'br-eval:analyze' });
    try {
        const state = await runner.run(spec, { prompt }, ctx);
        const result = parseBusinessRulesValidationResult(finalText(state));
        return { result, state };
    } finally {
        cleanup();
    }
}

const ANALYZER_SYSTEM = [
    'You validate whether a PR diff implements the task requirements, to find',
    'missing/forgotten business logic. Output a single JSON object:',
    '{ "needsMoreInfo": boolean, "reason": "analysis_ready" | "task_context_missing" | "task_context_weak" | "pr_diff_missing", "summary": string, "confidence": "low"|"medium"|"high" }.',
    'If a required behavior from the task is NOT implemented in the diff, say so in summary with confidence high.',
].join('\n');

/** Build the analyze fn: without_skill = raw analyzer; with_skill = + verify. */
export function buildBusinessRulesAnalyze(params: {
    resolveModel: () => LanguageModel;
    fixtures: Map<string | number, { diff: string; task: string }>;
}): AnalyzeFn {
    const runner = new AiSdkAgentRunner({ resolve: () => params.resolveModel() });
    return async (evalCase, config) => {
        const fx = params.fixtures.get(evalCase.id) ?? { diff: '', task: '' };
        const { result, state } = await runAnalyzer(
            runner,
            ANALYZER_SYSTEM,
            fx.diff,
            fx.task,
        );
        if (config === 'without_skill') {
            return { output: result, state: state as never };
        }
        // with_skill = run the Verifier and apply its verdict (refute-to-drop).
        const verifier = new BusinessRulesVerifier(runner, {
            modelId: 'resolved',
            diff: fx.diff,
            taskContext: fx.task,
        });
        const { ctx, cleanup } = createAgentRunContext({ runId: 'br-eval:verify' });
        try {
            const verdict = await verifier.verify(result, ctx);
            return {
                output: applyBusinessRulesVerdict(result, verdict),
                state: state as never,
            };
        } finally {
            cleanup();
        }
    };
}

/** Build an LLM grader: asks the model PASS/FAIL per assertion, with evidence. */
export function buildLlmGrader(params: {
    resolveModel: () => LanguageModel;
}): GradeFn {
    const runner = new AiSdkAgentRunner({ resolve: () => params.resolveModel() });
    return async (output, assertions) => {
        const results: AssertionResult[] = [];
        for (const text of assertions) {
            const spec: AgentSpec = {
                id: 'br-eval-grader',
                systemPrompt:
                    'You grade an output against ONE assertion. Reply ONLY JSON: {"passed": boolean, "evidence": string}. Require concrete evidence for passed=true.',
                modelId: 'resolved',
                tools: new InMemoryToolRegistry([]),
                policies: [],
                maxSteps: 1,
            };
            const prompt = `Output:\n${JSON.stringify(output)}\n\nAssertion:\n${text}`;
            const { ctx, cleanup } = createAgentRunContext({
                runId: 'br-eval:grade',
            });
            try {
                const state = await runner.run(spec, { prompt }, ctx);
                let passed = false;
                let evidence = '';
                try {
                    const parsed = JSON.parse(
                        finalText(state).replace(/```json|```/g, '').trim(),
                    );
                    passed = parsed.passed === true;
                    evidence = String(parsed.evidence ?? '');
                } catch {
                    evidence = 'ungradeable model output';
                }
                results.push({ text, passed, evidence });
            } finally {
                cleanup();
            }
        }
        return results;
    };
}

/** End-to-end: load the suite, run with/without verify, grade, return the report. */
export async function runBusinessRulesVerifierEval(params: {
    resolveModel: () => LanguageModel;
}): Promise<SkillEvalReport> {
    const { suite, fixtures } = loadBusinessRulesEvalSuite();
    return runSkillEval({
        suite,
        analyze: buildBusinessRulesAnalyze({
            resolveModel: params.resolveModel,
            fixtures,
        }),
        grade: buildLlmGrader({ resolveModel: params.resolveModel }),
    });
}
