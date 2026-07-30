import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import {
    runSkillEval,
    type AnalyzeFn,
    type GradeFn,
    type SkillEvalSuite,
} from './skill-eval-runner';

/**
 * Tests the eval seam itself (Etapa 1). The seam is pure — analyze/grade are
 * injected — so these run fully deterministically with stubs, no model/network.
 * They lock the math that the refactor will be judged against: per-case
 * pass-rate, with/without aggregation, the delta, and token accounting from
 * RunState.usage.
 */
function stateWith(inputTokens: number, outputTokens: number): RunState {
    return {
        runId: 'r',
        agentId: 'a',
        steps: [],
        artifacts: [],
        messages: [],
        usage: { inputTokens, outputTokens },
    } as unknown as RunState;
}

const suite: SkillEvalSuite = {
    skill_name: 'demo',
    evals: [
        {
            id: 1,
            prompt: 'validate this diff against the task',
            assertions: ['flags the missing check', 'cites the task requirement'],
        },
        {
            id: 2,
            prompt: 'another case',
            assertions: ['is valid JSON'],
        },
    ],
};

describe('runSkillEval', () => {
    it('computes per-case pass-rate, the with/without delta, and token cost', async () => {
        // with_skill passes everything; without_skill fails the semantic
        // assertions — the shape we expect a real skill to show.
        const grade: GradeFn = async (output, assertions) =>
            assertions.map((text) => ({
                text,
                passed: (output as { config: string }).config === 'with_skill',
                evidence: `output=${JSON.stringify(output)}`,
            }));

        const analyze: AnalyzeFn = async (evalCase, config) => ({
            output: { config, id: evalCase.id },
            state: stateWith(config === 'with_skill' ? 100 : 40, 50),
        });

        const report = await runSkillEval({ suite, analyze, grade });

        // Two cases, all assertions pass with the skill → mean pass_rate 1.
        expect(report.benchmark.with_skill.pass_rate.mean).toBe(1);
        // Baseline fails every assertion → 0.
        expect(report.benchmark.without_skill.pass_rate.mean).toBe(0);
        // Delta is what the refactor is judged on.
        expect(report.benchmark.delta.pass_rate).toBe(1);
        // Token cost comes from RunState.usage (input+output).
        expect(report.benchmark.with_skill.tokens.mean).toBe(150);
        expect(report.benchmark.without_skill.tokens.mean).toBe(90);
        expect(report.benchmark.delta.tokens).toBe(60);
    });

    it('grades each assertion independently (partial pass-rate)', async () => {
        // First assertion passes, second fails → pass_rate 0.5 on case 1.
        const grade: GradeFn = async (_output, assertions) =>
            assertions.map((text, i) => ({
                text,
                passed: i === 0,
                evidence: 'stub',
            }));
        const analyze: AnalyzeFn = async () => ({ output: {} });

        const report = await runSkillEval({ suite, analyze, grade });
        const case1 = report.cases.find((c) => c.id === 1)!;
        expect(case1.with_skill.grading.summary.pass_rate).toBe(0.5);
        expect(case1.with_skill.grading.summary.passed).toBe(1);
        expect(case1.with_skill.grading.summary.failed).toBe(1);
        // case 2 has a single assertion that passes → 1.0
        const case2 = report.cases.find((c) => c.id === 2)!;
        expect(case2.with_skill.grading.summary.pass_rate).toBe(1);
    });

    it('reports zero tokens when analyze returns no RunState (e.g. a code-only grader)', async () => {
        const grade: GradeFn = async (_o, assertions) =>
            assertions.map((text) => ({ text, passed: true, evidence: '-' }));
        const analyze: AnalyzeFn = async () => ({ output: {} }); // no state

        const report = await runSkillEval({ suite, analyze, grade });
        expect(report.benchmark.with_skill.tokens.mean).toBe(0);
        expect(report.benchmark.delta.tokens).toBe(0);
    });
});
