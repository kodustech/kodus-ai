/**
 * runRecallPasses unit tests — ZERO LLM, fully deterministic.
 *
 * Locks the recall behavior after the soft-coverage change: a single
 * synthesis-rescue pass (always unless skipped), dedup-merge of its ADDITIONAL
 * findings, and the fast/trial skip. The legacy coverage-recovery + 2nd/3rd
 * chance passes (and the coverage-debt nudge) were removed — no coverage-forced
 * re-runs.
 */
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type { ToolContext } from '@libs/agent-harness/domain/contracts/tool.contract';

import { runRecallPasses, type FinderSuggestion } from '@libs/code-review/infrastructure/agents/core/finder.agent';

const ctx: ToolContext = { runId: 'recall-test' };

function sug(file: string, content: string): FinderSuggestion {
    return {
        relevantFile: file,
        suggestionContent: content,
        existingCode: '',
        improvedCode: '',
    };
}

/** A RunState whose submitResult artifact carries the given suggestions. */
function stateWith(suggestions: FinderSuggestion[]): RunState {
    return {
        artifacts: [
            { type: 'submitResult', payload: { reasoning: 'r', suggestions } },
        ],
        steps: [
            {
                index: 0,
                message: {
                    toolCalls: [{ name: 'readFile', input: { path: 'a.ts' } }],
                },
            },
        ],
        usage: {
            inputTokens: 10,
            outputTokens: 4,
            reasoningTokens: 2,
            cacheReadTokens: 1,
        },
        status: 'done',
    } as any;
}

/** A runner that returns the queued states in order (one per extra pass). */
function fakeRunner(states: RunState[]) {
    let i = 0;
    return {
        run: jest.fn(async () => states[i++] ?? states[states.length - 1]),
    } as any;
}

const base = { reasoning: 'base', suggestions: [sug('a.ts', 'bug1')] };
const finderState = stateWith(base.suggestions);

describe('runRecallPasses', () => {
    it('skips the recall pass in fast/trial mode (skipHeavyPasses)', async () => {
        const runner = fakeRunner([]);
        const out = await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p', skipHeavyPasses: true },
            ctx,
        );
        expect(runner.run).not.toHaveBeenCalled();
        expect(out.findings).toBe(base);
        expect(out.usage.inputTokens).toBe(0);
    });

    it('runs synthesis rescue and merges NEW findings', async () => {
        const runner = fakeRunner([stateWith([sug('e.ts', 'missed bug')])]);
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'review this',
            },
            ctx,
        );
        expect(runner.run).toHaveBeenCalledTimes(1); // synthesis only
        expect(out.findings.suggestions.map((s) => s.relevantFile)).toEqual([
            'a.ts',
            'e.ts',
        ]);
        expect(out.usage.inputTokens).toBe(10); // the synthesis run's usage
    });

    it('dedups identical findings across the synthesis merge', async () => {
        const runner = fakeRunner([stateWith([sug('a.ts', 'bug1')])]); // same as base
        const out = await runRecallPasses(
            base,
            { runner, finderSpec: {} as any, finderState, userPrompt: 'p' },
            ctx,
        );
        expect(out.findings.suggestions).toHaveLength(1);
    });

    it('skips synthesis rescue when skipSynthesisRescue is set', async () => {
        const runner = fakeRunner([]);
        const out = await runRecallPasses(
            base,
            {
                runner,
                finderSpec: {} as any,
                finderState,
                userPrompt: 'p',
                skipSynthesisRescue: true,
            },
            ctx,
        );
        expect(runner.run).not.toHaveBeenCalled();
        expect(out.findings).toBe(base);
    });
});
