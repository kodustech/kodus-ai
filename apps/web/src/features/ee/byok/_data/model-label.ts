/**
 * Human label for a model id — the web-local mirror of the backend
 * `formatModelLabel` (libs/llm/providers/kernel/model-label.ts). Kept as its own
 * tiny copy ON PURPOSE: importing a VALUE from `@libs/*` into apps/web breaks the
 * isolated web prod build (the Dockerfile.web copies libs à la carte). It never
 * invents words — the label is the id, segmented and cased — so a curated pick,
 * a live-listed id, or a manually typed one all render consistently.
 *
 *   formatModelLabel('kimi-k2.6')                   → 'Kimi K2.6'
 *   formatModelLabel('deepseek/deepseek-v4-pro')    → 'Deepseek V4 Pro'
 *   formatModelLabel('gpt-5.4')                      → 'GPT 5.4'
 *   formatModelLabel('accounts/fireworks/models/glm-5p3-flash') → 'GLM 5.3 Flash'
 *   formatModelLabel('.../deepseek-v4-flash-0731')  → 'Deepseek V4 Flash'
 *
 * Fireworks spells versions with `p` (`5p3`, `k2p7`) and pins a snapshot date
 * (`-0731`); both are the same model everyone else calls "5.3" / "K2.7", so the
 * label reads them that way.
 */
const ACRONYMS = new Set(["gpt", "glm", "llm", "ai", "api", "sdk", "ui", "ocr"]);

export function formatModelLabel(id: string): string {
    if (!id) return id;
    // Deep-pathed ids (e.g. "accounts/fireworks/models/x") name the model in the
    // last segment; the path prefix is routing, not identity.
    const last = id.slice(id.lastIndexOf("/") + 1);
    const tokens = last.split("-").filter(Boolean);
    // A trailing MMDD snapshot date is a pin, not a name (`-0731`, `-0813`).
    if (tokens.length > 1 && /^(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/.test(tokens[tokens.length - 1])) {
        tokens.pop();
    }
    return tokens
        .map((tok) => tok.replace(/^(k?\d+)p(\d+)$/i, "$1.$2"))
        .map((tok) =>
            ACRONYMS.has(tok.toLowerCase())
                ? tok.toUpperCase()
                : tok.charAt(0).toUpperCase() + tok.slice(1),
        )
        .join(" ");
}
