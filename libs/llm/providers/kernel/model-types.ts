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

export interface ModelCapabilities {
    supportsTemperature: boolean;
    supportsReasoning: boolean;
    reasoningConfig?: ReasoningConfig;
    defaultMaxTokens?: number;
}
