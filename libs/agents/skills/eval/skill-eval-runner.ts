/**
 * Skill eval seam — the measurement net for the skills refactor.
 *
 * This is the "rede de eval" that makes a skill MEASURABLE before we change how
 * it runs: it runs each eval case in two configurations — `with_skill` and
 * `without_skill` (baseline) — grades the output against per-case assertions,
 * and reports the pass-rate delta plus token cost. That delta is what tells us a
 * refactor (policies, Verifier) helped, hurt, or was neutral — instead of
 * shipping on faith.
 *
 * Design: this lib is PURE w.r.t. how a skill actually runs. The caller injects
 *   - `analyze`: produce the skill output for a case in a given configuration
 *     (wire a real BYOK model + skill instructions, or the no-skill baseline),
 *   - `grade`: turn (output, assertions) into pass/fail with evidence (an LLM
 *     judge or a code checker).
 * So it stays out of the production path and runs equally from a unit test (with
 * stub analyze/grade) or a real benchmark script (with a live model). Token/
 * timing come straight from the harness `RunState.usage` — no new plumbing.
 *
 * Shapes mirror the Agent Skills eval convention (evals.json / grading.json /
 * benchmark.json) so authored cases are portable.
 */
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';

export type SkillEvalConfig = 'with_skill' | 'without_skill';

/** One authored test case (the part a human writes, in evals.json). */
export interface SkillEvalCase {
    readonly id: string | number;
    /** A realistic user prompt — the kind of thing someone would actually type. */
    readonly prompt: string;
    /** Human-readable description of what success looks like. */
    readonly expected_output?: string;
    /** Verifiable statements about the output (graded individually). */
    readonly assertions: string[];
    /** Optional fixture file paths the case needs. */
    readonly files?: string[];
}

export interface SkillEvalSuite {
    readonly skill_name: string;
    readonly evals: SkillEvalCase[];
}

export interface AssertionResult {
    readonly text: string;
    readonly passed: boolean;
    /** Quote/reference the output — not a bare opinion. */
    readonly evidence: string;
}

export interface CaseGrading {
    readonly assertion_results: AssertionResult[];
    readonly summary: {
        readonly passed: number;
        readonly failed: number;
        readonly total: number;
        readonly pass_rate: number;
    };
}

/** Result of running ONE case in ONE configuration. */
export interface CaseRun {
    readonly output: unknown;
    readonly state?: RunState;
    readonly grading: CaseGrading;
    readonly timing: { readonly total_tokens: number; readonly duration_ms: number };
}

/** Produces a skill's output for a case in one configuration. The caller wires a
 *  real model + skill instructions (`with_skill`) or the no-skill baseline
 *  (`without_skill`). Return the harness `RunState` when available so token/
 *  timing come for free. */
export type AnalyzeFn = (
    evalCase: SkillEvalCase,
    config: SkillEvalConfig,
) => Promise<{ output: unknown; state?: RunState; duration_ms?: number }>;

/** Grades one output against its assertions. Inject an LLM judge or a code
 *  checker; code is more reliable for mechanical checks. Must require concrete
 *  evidence for a PASS (don't give the benefit of the doubt). */
export type GradeFn = (
    output: unknown,
    assertions: string[],
) => Promise<AssertionResult[]>;

export interface ConfigBenchmark {
    readonly pass_rate: { readonly mean: number };
    readonly tokens: { readonly mean: number };
}

export interface SuiteBenchmark {
    readonly with_skill: ConfigBenchmark;
    readonly without_skill: ConfigBenchmark;
    /** What the skill costs (tokens) and what it buys (pass_rate). */
    readonly delta: { readonly pass_rate: number; readonly tokens: number };
}

export interface SkillEvalReport {
    readonly skill_name: string;
    readonly cases: ReadonlyArray<{
        readonly id: SkillEvalCase['id'];
        readonly with_skill: CaseRun;
        readonly without_skill: CaseRun;
    }>;
    readonly benchmark: SuiteBenchmark;
}

function summarize(results: AssertionResult[]): CaseGrading['summary'] {
    const passed = results.filter((r) => r.passed).length;
    const total = results.length;
    return {
        passed,
        failed: total - passed,
        total,
        pass_rate: total ? passed / total : 0,
    };
}

function tokensOf(state?: RunState): number {
    const u = state?.usage;
    if (!u) return 0;
    return (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
}

function mean(xs: number[]): number {
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

/**
 * Run a suite with/without the skill and report the pass-rate delta. The whole
 * point of Etapa 1: a refactor that doesn't lower `benchmark.delta.pass_rate`
 * vs the baseline is safe; one that raises it is a win.
 */
export async function runSkillEval(params: {
    suite: SkillEvalSuite;
    analyze: AnalyzeFn;
    grade: GradeFn;
}): Promise<SkillEvalReport> {
    const { suite, analyze, grade } = params;
    const cases: Array<{
        id: SkillEvalCase['id'];
        with_skill: CaseRun;
        without_skill: CaseRun;
    }> = [];

    const runOne = async (
        evalCase: SkillEvalCase,
        config: SkillEvalConfig,
    ): Promise<CaseRun> => {
        const { output, state, duration_ms } = await analyze(evalCase, config);
        const results = await grade(output, evalCase.assertions);
        return {
            output,
            state,
            grading: {
                assertion_results: results,
                summary: summarize(results),
            },
            timing: {
                total_tokens: tokensOf(state),
                duration_ms: duration_ms ?? 0,
            },
        };
    };

    for (const evalCase of suite.evals) {
        // Sequential per case so a flaky/shared model isn't hammered; cases are
        // small in early iterations (literature recommends starting with 2-3).
        const with_skill = await runOne(evalCase, 'with_skill');
        const without_skill = await runOne(evalCase, 'without_skill');
        cases.push({ id: evalCase.id, with_skill, without_skill });
    }

    const withPR = mean(cases.map((c) => c.with_skill.grading.summary.pass_rate));
    const withoutPR = mean(
        cases.map((c) => c.without_skill.grading.summary.pass_rate),
    );
    const withTok = mean(cases.map((c) => c.with_skill.timing.total_tokens));
    const withoutTok = mean(
        cases.map((c) => c.without_skill.timing.total_tokens),
    );

    return {
        skill_name: suite.skill_name,
        cases,
        benchmark: {
            with_skill: { pass_rate: { mean: withPR }, tokens: { mean: withTok } },
            without_skill: {
                pass_rate: { mean: withoutPR },
                tokens: { mean: withoutTok },
            },
            delta: {
                pass_rate: withPR - withoutPR,
                tokens: withTok - withoutTok,
            },
        },
    };
}
