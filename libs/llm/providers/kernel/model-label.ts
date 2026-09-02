/**
 * Derive a human label from a model id — the ONE formatter every listing parser
 * and the curated aggregator share.
 *
 * It never invents words: the label IS the id, only segmented and cased. This is
 * why it can be the default everywhere — a curated pick with no override, an
 * OpenAI-standard `/models` list (which carries only ids), a manually typed id.
 * Providers whose API returns a real name (Anthropic's `display_name`) use that
 * and fall back here.
 *
 * A curated `displayName` stays an OPTIONAL override for the ids this can't clean
 * up on its own: region-prefixed / dated ids (`us.anthropic.claude-…-20250929`),
 * brand casing this doesn't know (`DeepSeek`), or clarifiers (`(custom tools)`).
 *
 *   formatModelLabel('kimi-k2.6')                    → 'Kimi K2.6'
 *   formatModelLabel('kimi-k2.7-code')               → 'Kimi K2.7 Code'
 *   formatModelLabel('gemini-2.5-pro')               → 'Gemini 2.5 Pro'
 *   formatModelLabel('glm-5.2')                       → 'GLM 5.2'
 *   formatModelLabel('accounts/fireworks/models/x')  → 'X'
 */
const ACRONYMS = new Set([
    'gpt',
    'glm',
    'llm',
    'ai',
    'api',
    'sdk',
    'ui',
    'ocr',
]);

export function formatModelLabel(id: string): string {
    if (!id) {
        return id;
    }
    // Deep-pathed ids (e.g. "accounts/fireworks/models/deepseek-v3") name the
    // model in the last segment; the path prefix is routing, not identity.
    const last = id.slice(id.lastIndexOf('/') + 1);
    return last
        .split('-')
        .filter(Boolean)
        .map((tok) => {
            if (ACRONYMS.has(tok.toLowerCase())) return tok.toUpperCase();
            // Capitalize the first char, keep the rest verbatim so version tokens
            // survive intact ("k2.6" → "K2.6", "2.5" → "2.5", "v3" → "V3").
            return tok.charAt(0).toUpperCase() + tok.slice(1);
        })
        .join(' ');
}
