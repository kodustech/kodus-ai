/**
 * BYOKProvider — the vendor taxonomy the BYOK layer routes over. This is the
 * canonical home for it.
 *
 * IMPORTANT — enum member names AND string values are runtime-load-bearing: they
 * key stored config, DB rows, and cost attribution. Never rename a member or edit
 * a value without a data migration.
 *
 * caller now uses the model id string directly (`vendor:model`), which is the
 * same format BYOK's `NormalizedModel` already carries. See
 * `managedModelMaxInputTokens` (libs/llm/managed-model-window.ts) for per-model
 * input windows.
 */

export enum BYOKProvider {
    OPENAI = 'openai',
    ANTHROPIC = 'anthropic',
    GOOGLE_GEMINI = 'google_gemini',
    GOOGLE_VERTEX = 'google_vertex',
    AMAZON_BEDROCK = 'amazon_bedrock',
    OPENAI_COMPATIBLE = 'openai_compatible',
    ANTHROPIC_COMPATIBLE = 'anthropic_compatible',
    OPEN_ROUTER = 'open_router',
    NOVITA = 'novita',
    MOONSHOT = 'moonshot',
    ZAI = 'zai',
    AZURE = 'azure',
    /**
     * Kodus as the provider: the org picks a model and Kodus routes the call
     * over ITS OWN upstream accounts (Anthropic / OpenAI / Google). The
     * credential carries no key — usage is billed to the org's Kodus credits.
     * Cloud-only; see libs/llm/providers/kodus.
     */
    KODUS = 'kodus',
}
