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
 *   formatModelLabel('claude-sonnet-4-6')            → 'Claude Sonnet 4.6'
 *   formatModelLabel('glm-5.2')                       → 'GLM 5.2'
 *   formatModelLabel('accounts/fireworks/models/x')  → 'X'
 *   formatModelLabel('accounts/fireworks/models/glm-5p3-flash') → 'GLM 5.3 Flash'
 *   formatModelLabel('.../deepseek-v4-flash-0731')   → 'Deepseek V4 Flash'
 *
 * Fireworks spells versions with `p` (`5p3`, `k2p7`) and pins a snapshot date
 * (`-0731`); both are the same model everyone else calls "5.3" / "K2.7", so the
 * label reads them that way. Mirrored in apps/web (model-label.ts) — the parity
 * spec keeps the two in lockstep.
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
    const tokens = last.split('-').filter(Boolean);
    // A trailing -YYYY-MM-DD snapshot date (`gpt-4o-2024-08-06`) is a pin too;
    // drop it before the version join so month and day don't fuse into "08.06".
    if (
        tokens.length > 3 &&
        /^(19|20)\d{2}$/.test(tokens[tokens.length - 3]) &&
        /^(0[1-9]|1[0-2])$/.test(tokens[tokens.length - 2]) &&
        /^(0[1-9]|[12]\d|3[01])$/.test(tokens[tokens.length - 1])
    ) {
        tokens.splice(-3);
    }
    // A trailing MMDD snapshot date is a pin, not a name (`-0731`, `-0813`).
    if (
        tokens.length > 1 &&
        /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(tokens[tokens.length - 1])
    ) {
        tokens.pop();
    }
    // Anthropic spells a version with hyphens (`claude-sonnet-4-6`): two bare
    // numbers side by side are one dotted version, "4.6", not two words.
    const words = tokens.reduce<string[]>((acc, tok) => {
        const prev = acc[acc.length - 1];
        if (
            prev !== undefined &&
            /^\d{1,2}$/.test(prev) &&
            /^\d{1,2}$/.test(tok)
        ) {
            acc[acc.length - 1] = `${prev}.${tok}`;
        } else {
            acc.push(tok);
        }
        return acc;
    }, []);
    return words
        .map((tok) => tok.replace(/^([kv]?\d+)p(\d+)$/i, '$1.$2'))
        .map((tok) => {
            if (ACRONYMS.has(tok.toLowerCase())) return tok.toUpperCase();
            // Capitalize the first char, keep the rest verbatim so version tokens
            // survive intact ("k2.6" → "K2.6", "2.5" → "2.5", "v3" → "V3").
            return tok.charAt(0).toUpperCase() + tok.slice(1);
        })
        .join(' ');
}
