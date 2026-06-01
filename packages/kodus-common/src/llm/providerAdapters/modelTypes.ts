// Pure type module for model capabilities (no runtime exports)

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
