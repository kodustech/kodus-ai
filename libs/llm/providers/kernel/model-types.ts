// Pure type module for model capabilities (no runtime exports).
//
// This is the reasoning-only BASE `ModelCapabilities`. NOTE: `libs/llm/providers/
// kernel/types.ts` declares a SEPARATE, wider `ModelCapabilities` that `extends`
// this base with execution fields (structuredOutput, toolCalling, …). This base
// holds `ReasoningConfig`, the shape the family reasoning resolver
// (kernel/model-reasoning.ts) returns; the wider one is the provider descriptor.

export type ReasoningConfig =
    | {
          type: 'level';
          options: Array<'low' | 'medium' | 'high'>;
      }
    | {
          type: 'budget';
          options: { min: number; max?: number; default: number };
      }
    | {
          type: 'adaptive';
          options: Array<'low' | 'medium' | 'high'>;
      };

/**
 * How a model treats the `temperature` sampling parameter — the ONE per-model
 * answer a provider declares (via `ProviderModule.temperaturePolicy`), read by
 * both the runtime (what to send) and the connect form (how to render the field).
 * A discriminated union, same shape family as {@link ReasoningConfig}, so a new
 * constraint is a new `kind` rather than another boolean bolted on:
 *   - `adjustable`  → any value; the configured (or model-default) temperature stands.
 *   - `unsupported` → must NOT be sent; the request 400s if it is (Anthropic 4.7+).
 *   - `fixed`       → exactly one valid value; sent over whatever is stored and the
 *                     form locks the field to it (the Anthropic protocol pins
 *                     temperature to 1 while thinking, so always-thinking upstreams
 *                     — Kimi k2.7-code/k3, GLM-5.3 — have a single sound value).
 *
 * NOTE: scoped to `temperature` deliberately — it is the only sampling param this
 * codebase sends (top_p / top_k are never set). Add a sibling policy if that changes.
 */
export type TemperaturePolicy =
    | { kind: 'adjustable' }
    | { kind: 'unsupported' }
    | { kind: 'fixed'; value: number };

export interface ModelCapabilities {
    supportsTemperature: boolean;
    supportsReasoning: boolean;
    reasoningConfig?: ReasoningConfig;
    defaultMaxTokens?: number;
}
