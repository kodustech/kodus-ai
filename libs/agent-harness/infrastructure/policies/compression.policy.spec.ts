/**
 * CompressionPolicy unit tests — deterministic, zero LLM.
 */
import type {
    Compressor,
    CompressionResult,
} from '../../domain/contracts/compression.contract';
import type { AgentMessage } from '../../domain/contracts/run-state.contract';
import type { StepView } from '../../domain/contracts/policy.contract';
import { CompressionPolicy } from './compression.policy';

function view(messages: AgentMessage[]): StepView {
    return {
        runId: 'r',
        agentId: 'finder',
        stepNumber: 5,
        maxSteps: 20,
        steps: [],
        messages,
        activeTools: [],
    };
}

const msgs: AgentMessage[] = [
    { role: 'user', content: 'a'.repeat(1000) },
    { role: 'assistant', content: 'b'.repeat(1000) },
];

function fakeCompressor(result: CompressionResult | null): Compressor {
    return { maybeCompress: () => result };
}

describe('CompressionPolicy', () => {
    it('returns no directives when the compressor declines (null)', () => {
        const p = new CompressionPolicy(fakeCompressor(null));
        expect(p.prepareStep(view(msgs))).toEqual({});
    });

    it('replaces the window and emits a trace when compression saves tokens', () => {
        const compressed: AgentMessage[] = [{ role: 'user', content: 'short' }];
        const p = new CompressionPolicy(
            fakeCompressor({
                messages: compressed,
                beforeTokens: 500,
                afterTokens: 120,
            }),
        );
        const d = p.prepareStep(view(msgs));
        expect(d.messages).toEqual(compressed);
        expect(d.emit?.[0].kind).toBe('context.compress');
        expect(d.emit?.[0].detail?.savedTokens).toBe(380);
        expect(d.emit?.[0].detail?.afterMessages).toBe(1);
    });
});
