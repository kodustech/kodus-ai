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
 */
const ACRONYMS = new Set(["gpt", "glm", "llm", "ai", "api", "sdk", "ui", "ocr"]);

export function formatModelLabel(id: string): string {
    if (!id) return id;
    // Deep-pathed ids (e.g. "accounts/fireworks/models/x") name the model in the
    // last segment; the path prefix is routing, not identity.
    const last = id.slice(id.lastIndexOf("/") + 1);
    return last
        .split("-")
        .filter(Boolean)
        .map((tok) =>
            ACRONYMS.has(tok.toLowerCase())
                ? tok.toUpperCase()
                : tok.charAt(0).toUpperCase() + tok.slice(1),
        )
        .join(" ");
}
