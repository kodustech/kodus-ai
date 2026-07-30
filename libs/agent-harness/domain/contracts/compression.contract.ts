/**
 * agent-harness — Compressor port (generic context management).
 *
 * Cross-cutting concern: when the message window approaches the model's
 * context budget, older tool-result content is truncated/recapped to avoid
 * overflow. The STRATEGY (what to keep, how to recap) is domain/infra
 * supplied; the policy just asks "can you shrink this?".
 *
 * The concrete compressor (token estimation + head-preserving truncation)
 * lives in infra, wrapping the existing context-compressor.
 */
import type { AgentMessage } from './run-state.contract';

export interface CompressionResult {
    readonly messages: readonly AgentMessage[];
    readonly beforeTokens: number;
    readonly afterTokens: number;
}

export interface Compressor {
    /** Returns a compressed window when it would actually save tokens, or
     *  null when no compression is needed/possible (leave messages as-is).
     *  The compressor owns its token budget (context window). */
    maybeCompress(
        messages: readonly AgentMessage[],
    ): CompressionResult | null;
}
