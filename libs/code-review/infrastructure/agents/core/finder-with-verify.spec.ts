/**
 * runFinderWithVerify e2e — mocked model, zero LLM.
 * Proves parity path: finder produces 2 findings, verifier keeps the real one
 * and refutes the false positive — all on the SAME runner (no second loop).
 */
import { MockLanguageModelV3 } from 'ai/test';

import type { ProgressLedger } from '@libs/agent-harness/domain/contracts/progress.contract';
import type { ModelResolver } from '@libs/agent-harness/domain/contracts/model.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import { buildFinderAgentSpec, runFinderWithVerify } from '@libs/code-review/infrastructure/agents/core/finder.agent';

const findings = {
    reasoning: 'two candidates',
    suggestions: [
        { relevantFile: 'a.ts', suggestionContent: 'real bug', existingCode: 'x', improvedCode: 'y', severity: 'high' },
        { relevantFile: 'b.ts', suggestionContent: 'false positive', existingCode: 'p', improvedCode: 'q', severity: 'low' },
    ],
};

/** One model drives BOTH the finder run and the verifier runs (same runner).
 *  - finder: step1 submitResult(findings)
 *  - verifier: submitVerdict(keep) unless the prompt mentions "false positive"
 */
function model() {
    let finderDone = false;
    const doGenerate = (async (opts: any) => {
        const sys = JSON.stringify(opts?.prompt ?? opts ?? '');
        const isVerifier = sys.includes('verifier') || sys.includes('REFUTE') || sys.includes('verdict');
        let tc: any;
        if (isVerifier) {
            const refute = sys.includes('false positive');
            tc = { id: 'v', name: 'submitVerdict', input: { keep: !refute, rationale: refute ? 'refuted' : 'confirmed' } };
        } else if (!finderDone) {
            finderDone = true;
            tc = { id: 'f', name: 'submitResult', input: findings };
        } else {
            tc = { id: 'f2', name: 'submitResult', input: findings };
        }
        return {
            content: [{ type: 'tool-call', toolCallId: tc.id, toolName: tc.name, input: JSON.stringify(tc.input) }],
            finishReason: 'tool-calls',
            usage: { inputTokens: 5, outputTokens: 5 },
            warnings: [],
        };
    }) as any;
    return new MockLanguageModelV3({ doGenerate });
}

const resolver: ModelResolver<any> = { resolve: () => model() as any };

const noCriticalLedger: ProgressLedger = {
    markFromToolCall: () => undefined,
    summary: () => ({ totalTargets: 0, pendingTargets: 0, criticalTotal: 0, criticalPending: 0 }),
    debtNote: () => null,
};

const ctx: ToolContext = { runId: 'fwv' };

describe('runFinderWithVerify (parity: finder + verify, same runner)', () => {
    it('keeps the real finding and drops the refuted false positive', async () => {
        const tools = new InMemoryToolRegistry([]);
        const finderSpec = buildFinderAgentSpec({
            systemPrompt: 'find bugs',
            modelId: 'mock',
            tools,
            coverageLedger: noCriticalLedger,
        });
        const runner = new AiSdkAgentRunner(resolver);

        const r = await runFinderWithVerify(
            { runner, finderSpec, modelId: 'mock', tools },
            { prompt: 'review' },
            ctx,
        );

        expect(r.kept.map((f) => f.relevantFile)).toEqual(['a.ts']);
        expect(r.droppedByVerify.map((d) => d.finding.relevantFile)).toEqual(['b.ts']);
        expect(r.droppedByVerify[0].evidence).toBe('refuted');
    });
});
