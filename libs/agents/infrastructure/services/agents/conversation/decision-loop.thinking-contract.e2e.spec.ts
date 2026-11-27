/**
 * The conversation's policies against Anthropic's preserved-thinking check,
 * through the real runner. 9% of conversations looped on kodusDecideAction to
 * the step limit (Nov 2026); the loop guard must end that without changing the
 * tool list or the history, or Anthropic rejects the run's earlier thinking
 * (#2731).
 */
jest.mock('@libs/llm/model-invocation', () => ({
    resolveModelConfig: jest.fn(),
}));

import { resolveModelConfig } from '@libs/llm/model-invocation';
import { AiSdkAgentRunner } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-agent-runner';
import { AiSdkToolRegistry } from '@libs/agent-harness/infrastructure/ai-sdk/ai-sdk-tool-registry';
import {
    replayedSignatures,
    signedThinkingModel,
    thinkingContractViolations,
} from '@libs/agent-harness/infrastructure/ai-sdk/__test-utils__/anthropic-thinking-contract';

import {
    buildDecisionTool,
    CONVERSATION_DECISION_TOOL,
} from './conversation-decision';
import { DecisionLoopPolicy } from './decision-loop.policy';
import { createWriteAuthorization } from './write-authorization';
import { WriteGatePolicy } from './write-gate.policy';
import { WriteTruthPolicy } from './write-truth.policy';

describe('conversation decision loop — Anthropic thinking contract', () => {
    async function runLoopingModel() {
        // The production loop: a decision on every step, never an answer.
        const { model, calls } = signedThinkingModel((turn) => ({
            id: `d${turn}`,
            name: CONVERSATION_DECISION_TOOL,
            input: { intent: 'answer', why: `step ${turn}` },
        }));
        (resolveModelConfig as jest.Mock).mockImplementation(() => ({
            model,
            callOptions: {},
            providerOptions: {},
            modelName: 'mock',
            usageIdentity: {},
        }));
        const prompt = 'Fixed in abc1234.';
        const registry = new AiSdkToolRegistry({ ...buildDecisionTool() });
        const state = await new AiSdkAgentRunner(undefined).run(
            {
                id: 'conversation',
                systemPrompt: 'You are Kodus.',
                tools: registry,
                resultToolName: CONVERSATION_DECISION_TOOL,
                policies: [
                    new WriteGatePolicy(prompt, createWriteAuthorization()),
                    new WriteTruthPolicy(() => []),
                    new DecisionLoopPolicy(),
                ],
                maxSteps: 12,
            },
            { prompt },
            { runId: 'decision-loop-e2e' },
        );
        return { state, calls };
    }

    it('ends the loop at the fourth decision instead of the step limit', async () => {
        const { calls } = await runLoopingModel();
        expect(calls).toHaveLength(4);
    });

    it('keeps the tool list and the history the thinking was bound to', async () => {
        const { calls } = await runLoopingModel();
        // Not vacuous: earlier thinking was replayed on later calls.
        expect(replayedSignatures(calls).at(-1)).toEqual(['sig-1', 'sig-2', 'sig-3']);
        expect(thinkingContractViolations(calls)).toEqual([]);
    });
});
