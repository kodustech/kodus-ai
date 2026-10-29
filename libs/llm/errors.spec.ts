import { AgentContextWindowTooSmallError } from './errors';
import { classifyLLMError, LlmErrorCategory } from './error-classifier';

describe('AgentContextWindowTooSmallError', () => {
    it('classifies as CONTEXT_OVERFLOW via existing message-substring matcher', () => {
        const err = new AgentContextWindowTooSmallError({
            contextWindow: 12_288,
            overheadTokens: 15_500,
            modelName: 'meta-llama/Llama-3.3-70B-Instruct',
        });
        expect(classifyLLMError(err).category).toBe(
            LlmErrorCategory.CONTEXT_OVERFLOW,
        );
    });

});
