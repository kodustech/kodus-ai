/**
 * The SINGLE source for "does this model support reasoning, and in which shape".
 *
 * Reasoning is a MODEL-FAMILY property, not a host property: a Claude reasons the
 * same whether it is served natively, on Bedrock, or on Vertex. So the family
 * OWNER answers — Claude via the Anthropic traits, Gemini/OpenAI via their own
 * rules — and every consumer (the model catalog + the host modules that serve
 * these families) resolves through here. This replaces the old parallel table in
 * `kernel/capabilities.ts`, which drifted from the modules (Bedrock reported no
 * reasoning at all; Vertex reported `budget` for adaptive-only Claude 4.7+; the
 * table itself was stale for `claude-opus-4-8`).
 */
import type { ReasoningConfig } from './model-types';
import { detectModelFamily } from './model-family';
import { anthropicReasoningConfig } from '../anthropic/traits';
import { geminiReasoningConfig } from '../google-gemini/reasoning';
import { openaiReasoningConfig } from '../openai/reasoning';
import { compatibleReasoningConfig } from './reasoning-traits';

/**
 * Thin family dispatcher: detect the model FAMILY and defer to that family's
 * owning module. The only knowledge here is "which family" — each family's
 * actual reasoning rules live with their owner. Used by the model catalog and by
 * multi-family HOST modules (Bedrock/Vertex serve Claude + Gemini + …), which
 * can't answer per-family on their own.
 */
export function reasoningConfigForModel(
    model?: string,
): ReasoningConfig | undefined {
    if (!model) {
        return undefined;
    }

    // ONE family list, shared with the traits resolver (kernel/model-family.ts).
    // It used to be a private if-chain that knew only claude / gemini / openai,
    // so every Kimi, GLM, DeepSeek and MiniMax fell through to "no reasoning" —
    // including the ones a HOST module asks about, which is how a live Kimi and
    // a live MiniMax on Bedrock were advertised as non-reasoning models.
    switch (detectModelFamily(model)) {
        // Claude — native, Bedrock `anthropic.` prefix, or Vertex `@`-versioned.
        case 'anthropic':
            return anthropicReasoningConfig(model);
        case 'gemini':
            return geminiReasoningConfig(model);
        case 'openai':
            // The owner returns undefined for the non-reasoning OpenAI ids.
            return openaiReasoningConfig(model);
        case 'glm':
        case 'kimi':
        case 'deepseek':
        case 'minimax':
            return compatibleReasoningConfig(model);
        default:
            return undefined;
    }
}
