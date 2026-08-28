/**
 * Human labels for BYOK provider ids, keyed by the stored `provider` value. Used
 * across the connect flow, the connected-provider views, and the manual form so
 * a provider id renders as a friendly name instead of its raw id.
 */
export const PROVIDER_LABELS: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    google_gemini: 'Google',
    openrouter: 'OpenRouter',
    open_router: 'OpenRouter',
    novita: 'Novita',
    moonshot: 'Moonshot',
    zai: 'Z.ai',
    openai_compatible: 'OpenAI-compatible',
    // Distinct labels so registry-only providers never collide with their
    // native sibling in the picker (e.g. two "Anthropic" cards).
    anthropic_compatible: 'Anthropic-compatible',
    google_vertex: 'Google Vertex AI',
    amazon_bedrock: 'Amazon Bedrock',
    azure: 'Azure OpenAI',
};
