import { resolveAgentModel } from '@libs/llm/agent-model';
import { runBusinessRulesVerifierEval } from './business-rules-eval';

/**
 * Stack-gated driver: this hits a REAL model, so it is skipped by default (CI
 * has no model). Run it on a stack with the LLM env configured:
 *
 *   RUN_BR_EVAL=1 API_NODE_ENV=test npx jest --config jest.config.ts \
 *     --no-coverage libs/agents/skills/business-rules-validation/evals
 *
 * It prints the benchmark (with_skill = post-verify, without_skill = raw). Use
 * the pass-rate delta to decide whether to flip SkillExecutionPolicy.verifyAnalyzerResult.
 */
const RUN = process.env.RUN_BR_EVAL === '1';

(RUN ? describe : describe.skip)(
    'business-rules Verifier eval (stack-gated)',
    () => {
        it('measures the verify delta (post-verify vs raw)', async () => {
            const report = await runBusinessRulesVerifierEval({
                resolveModel: () =>
                    resolveAgentModel(undefined, {
                        provider: undefined,
                    }) as never,
            });
            // Measurement, not pass/fail — surface the numbers for a human call.

            console.log(
                '[business-rules eval] benchmark:',
                JSON.stringify(report.benchmark, null, 2),
            );
            expect(report.cases.length).toBeGreaterThan(0);
        }, 180_000);
    },
);
