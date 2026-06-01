import {
    AgentContextWindowTooSmallError,
    AgentPromptTooLargeError,
} from './errors';
import { classifyLLMError, ReviewErrorCategory } from './error-classifier';

describe('AgentContextWindowTooSmallError', () => {
    it('classifies as CONTEXT_OVERFLOW via existing message-substring matcher', () => {
        const err = new AgentContextWindowTooSmallError({
            contextWindow: 12_288,
            overheadTokens: 15_500,
            modelName: 'meta-llama/Llama-3.3-70B-Instruct',
        });
        expect(classifyLLMError(err).category).toBe(
            ReviewErrorCategory.CONTEXT_OVERFLOW,
        );
    });

    it('exposes the numeric fields callers need for telemetry', () => {
        const err = new AgentContextWindowTooSmallError({
            contextWindow: 12_288,
            overheadTokens: 15_500,
            modelName: 'llama',
        });
        expect(err.contextWindow).toBe(12_288);
        expect(err.overheadTokens).toBe(15_500);
        expect(err.modelName).toBe('llama');
    });
});

describe('AgentPromptTooLargeError', () => {
    it('classifies as CONTEXT_OVERFLOW via existing message-substring matcher', () => {
        const err = new AgentPromptTooLargeError({
            estimatedTokens: 71_110,
            contextWindowTokens: 12_288,
            modelName: 'llama',
        });
        expect(classifyLLMError(err).category).toBe(
            ReviewErrorCategory.CONTEXT_OVERFLOW,
        );
    });

    it('exposes the numeric fields callers need for telemetry', () => {
        const err = new AgentPromptTooLargeError({
            estimatedTokens: 71_110,
            contextWindowTokens: 12_288,
            modelName: 'llama',
        });
        expect(err.estimatedTokens).toBe(71_110);
        expect(err.contextWindowTokens).toBe(12_288);
        expect(err.modelName).toBe('llama');
    });
});
