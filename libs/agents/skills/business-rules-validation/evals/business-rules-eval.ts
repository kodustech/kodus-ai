/**
 * Runnable eval for the business-logic stage's analyzer and its verify pass.
 *
 * It runs the production agent (BusinessRulesValidationAgentProvider's analyzer
 * step, with the real SKILL.md, prompt, retries, parser and defaults) over each
 * case's task and diff, with a real model. The two configurations compared are:
 *   - without_skill = production's default (the verify pass is off)
 *   - with_skill    = the same agent with the policy's verifyAnalyzerResult on
 * Graded against each case's assertions, so the delta tells you whether verify
 * drops false-positive violations WITHOUT dropping the real ones.
 *
 * Runs on the stack, not in CI — see business-rules-eval.spec.ts (gated by env).
 */
import * as fs from 'fs';
import * as path from 'path';

import type { NormalizedModel } from '@libs/llm/byok-config';

import type { AgentSpec } from '@libs/agent-harness/domain/contracts/agent.contract';
import { finalText } from '@libs/agent-harness/domain/run-state.util';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';
import { createAgentRunContext } from '@libs/llm/agent-run-context';

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

/**
 * The agent production runs for the business-logic stage, built from its own
 * services: the permission service over an org with no BYOK config (the
 * env/managed model route), the parameters service over an in-memory
 * repository holding the team's language, and the skill runner that loads the
 * real SKILL.md. The eval supplies data only: the case's task and diff.
 */
function productionAgent(verifyAnalyzerResult: boolean) {
    const { PermissionValidationService } = require('@libs/ee/shared/services/permissionValidation.service');
    const { ParametersService } = require('@libs/organization/infrastructure/adapters/services/parameters.service');
    const { ObservabilityService } = require('@libs/core/log/observability.service');
    const { GenericSkillRunnerService } = require('@libs/agents/skills/generic-skill-runner.service');
    const { SkillLoaderService } = require('@libs/agents/skills/skill-loader.service');
    const {
        BusinessRulesValidationAgentProvider,
    } = require('@libs/agents/infrastructure/services/agents/business-rules-validation/businessRulesValidationAgent');

    const observability = new ObservabilityService({ get: () => undefined });
    const skillRunner = new GenericSkillRunnerService(new SkillLoaderService(), observability);
    if (verifyAnalyzerResult) {
        // The one setting a team's skill config changes: production's verify
        // pass is off by default (SkillExecutionPolicy.verifyAnalyzerResult);
        // `with_skill` runs the same agent with it on.
        const getExecutionPolicy = skillRunner.getExecutionPolicy.bind(skillRunner);
        skillRunner.getExecutionPolicy = (name: string) => ({ ...getExecutionPolicy(name), verifyAnalyzerResult: true });
    }
    const parameters = new ParametersService({ findByKey: async () => ({ configValue: 'en-US' }) });
    return new BusinessRulesValidationAgentProvider(
        new PermissionValidationService(undefined, { findByKey: async () => null }),
        parameters,
        observability,
        skillRunner,
    );
}

/**
 * Runs the production analyzer step (analysis prompt, retries, parse, the
 * verify pass when the policy has it, defaults) over a case whose task and diff
 * production has already judged usable.
 */
async function runAnalyzer(
    agent: ReturnType<typeof productionAgent>,
    diff: string,
    task: string,
): Promise<{ result: ValidationResult }> {
    const ctx = {
        organizationAndTeamData: {
            organizationId: '00000000-0000-4000-8000-0000000b1001',
            teamId: '00000000-0000-4000-8000-0000000b1002',
        },
        prDiff: diff,
        taskContext: task,
        taskQuality: 'COMPLETE',
        userLanguage: 'en-US',
        analysisEligibility: {
            mode: 'full_analysis',
            taskContextStatus: 'usable',
            prDiffStatus: 'usable',
            reason: 'analysis_ready',
        },
        prepareContext: {},
    };
    const out = await (agent as any).runAnalyzer({ type: 'llm' }, ctx);
    return { result: out.validationResult as ValidationResult };
}

/** Build the analyze fn: without_skill = production's default; with_skill = its verify pass on. */
export function buildBusinessRulesAnalyze(params: {
    slot?: NormalizedModel;
    fixtures: Map<string | number, { diff: string; task: string }>;
}): AnalyzeFn {
    const raw = productionAgent(false);
    const verified = productionAgent(true);
    return async (evalCase, config) => {
        const fx = params.fixtures.get(evalCase.id) ?? { diff: '', task: '' };
        const { result } = await runAnalyzer(config === 'without_skill' ? raw : verified, fx.diff, fx.task);
        return { output: result, state: undefined as never };
    };
}

/** Build an LLM grader: asks the model PASS/FAIL per assertion, with evidence. */
export function buildLlmGrader(params: {
    slot?: NormalizedModel;
}): GradeFn {
    const runner = new AiSdkAgentRunner(params.slot);
    return async (output, assertions) => {
        const results: AssertionResult[] = [];
        for (const text of assertions) {
            const spec: AgentSpec = {
                id: 'br-eval-grader',
                systemPrompt:
                    'You grade an output against ONE assertion. Reply ONLY JSON: {"passed": boolean, "evidence": string}. Require concrete evidence for passed=true.',
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
    slot?: NormalizedModel;
}): Promise<SkillEvalReport> {
    const { suite, fixtures } = loadBusinessRulesEvalSuite();
    return runSkillEval({
        suite,
        analyze: buildBusinessRulesAnalyze({
            slot: params.slot,
            fixtures,
        }),
        grade: buildLlmGrader({ slot: params.slot }),
    });
}
