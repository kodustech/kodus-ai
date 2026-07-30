import { ProviderAdapter } from './types';
import { OpenAIAdapter } from './openaiAdapter';
import { AnthropicAdapter } from './anthropicAdapter';
import { GoogleGeminiAdapter } from './googleGeminiAdapter';
import { VertexAdapter } from './vertexAdapter';
import { NovitaAdapter } from './novitaAdapter';
export {
    getModelCapabilities,
    supportsReasoning,
    supportsTemperature,
    getReasoningType,
    supportsBudgetReasoning,
    supportsJsonMode,
} from './capabilities';
export type { ReasoningConfig, ModelCapabilities } from './modelTypes';

export function getAdapter(providerId: string): ProviderAdapter {
    switch (providerId) {
        case 'openai':
            return new OpenAIAdapter();
        case 'openai_compatible':
        case 'open_router':
            return new OpenAIAdapter();
        case 'anthropic':
        case 'anthropic_compatible':
            return new AnthropicAdapter();
        case 'google_gemini':
            return new GoogleGeminiAdapter();
        case 'google_vertex':
            return new VertexAdapter();
        case 'novita':
            return new NovitaAdapter();
        default:
            return new OpenAIAdapter();
    }
}
