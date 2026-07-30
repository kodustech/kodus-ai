/**
 * agent-harness — CompressionPolicy (context management as a policy).
 *
 * Extracted from the monolith's inlined shouldCompress/compressMessages
 * block in prepareStep. Replaces the message window with a compressed one
 * when the injected Compressor says it would save tokens.
 *
 * Domain-agnostic: the compaction strategy lives in the injected Compressor.
 * Unit-testable with a fake compressor; no LLM.
 */
import type { Compressor } from '../../domain/contracts/compression.contract';
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '../../domain/contracts/policy.contract';

export class CompressionPolicy implements AgentPolicy {
    readonly name = 'compression';

    constructor(private readonly compressor: Compressor) {}

    prepareStep(view: StepView): StepDirectives {
        const result = this.compressor.maybeCompress(view.messages);

        if (!result) {
            return {};
        }

        return {
            messages: result.messages,
            emit: [
                {
                    kind: 'context.compress',
                    detail: {
                        beforeTokens: result.beforeTokens,
                        afterTokens: result.afterTokens,
                        savedTokens: result.beforeTokens - result.afterTokens,
                        beforeMessages: view.messages.length,
                        afterMessages: result.messages.length,
                    },
                },
            ],
        };
    }
}
