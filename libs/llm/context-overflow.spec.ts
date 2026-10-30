import { runStateErrorText, isContextOverflowResult } from './context-overflow';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';

const errorState = (detail: Record<string, unknown>): RunState =>
    ({
        runId: 'r',
        agentId: 'a',
        status: 'error',
        steps: [],
        artifacts: [],
        trace: [{ at: 0, source: 'runner', kind: 'error', detail }],
        usage: {},
    }) as unknown as RunState;

const cleanState = (): RunState =>
    ({
        runId: 'r',
        agentId: 'a',
        status: 'completed',
        steps: [],
        artifacts: [],
        trace: [],
        usage: {},
    }) as unknown as RunState;

describe('runStateErrorText', () => {
    it('is empty for a non-error run', () => {
        expect(runStateErrorText(cleanState())).toBe('');
    });

    it('folds message + responseBody from the error trace event', () => {
        const text = runStateErrorText(
            errorState({ message: 'Bad Request', responseBody: 'context_length_exceeded' }),
        );
        expect(text).toContain('Bad Request');
        expect(text).toContain('context_length_exceeded');
    });
});

describe('isContextOverflowResult', () => {
    it('is true when the failure is a context-length overflow', () => {
        expect(
            isContextOverflowResult(
                errorState({ message: 'context_length_exceeded' }),
            ),
        ).toBe(true);
    });

    it('is false for a non-overflow failure (rate limit)', () => {
        expect(
            isContextOverflowResult(
                errorState({ message: 'rate limit exceeded, try again' }),
            ),
        ).toBe(false);
    });

    it('is false for a clean run (nothing to recover)', () => {
        expect(isContextOverflowResult(cleanState())).toBe(false);
    });
});
