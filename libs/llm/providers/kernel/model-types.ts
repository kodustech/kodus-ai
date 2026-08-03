// Pure type module for model capabilities (no runtime exports).
//
// This is the reasoning-only BASE `ModelCapabilities`. NOTE: `libs/llm/providers/
// types.ts` declares a SEPARATE, wider `ModelCapabilities` that `extends` this
// base with execution fields (structuredOutput, toolCalling, …). Both are
// intentional: this base is what `getModelCapabilities` returns and what general
// consumers import; the wider one in types.ts is the provider-registry's descriptor.

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
