import { finalText } from './run-state.util';
import type { RunState } from './contracts/run-state.contract';

function state(contents: Array<string>): RunState {
    return {
        runId: 'r',
        agentId: 'a',
        status: 'completed',
        steps: contents.map((content, index) => ({
            index,
            message: { role: 'assistant', content },
        })),
        artifacts: [],
        usage: {},
        trace: [],
    };
}

describe('finalText', () => {
    it('returns the last non-empty assistant step', () => {
        expect(finalText(state(['thinking…', 'the answer']))).toBe('the answer');
    });

    it('skips trailing empty (tool-only) steps', () => {
        expect(finalText(state(['the answer', '', '   ']))).toBe('the answer');
    });

    it('returns empty string when no step has text', () => {
        expect(finalText(state(['', '   ']))).toBe('');
        expect(finalText(state([]))).toBe('');
    });
});
