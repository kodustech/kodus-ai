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
 *   formatModelLabel('claude-sonnet-4-6')           → 'Claude Sonnet 4.6'
 *   formatModelLabel('gpt-5.4')                      → 'GPT 5.4'
 *   formatModelLabel('accounts/fireworks/models/glm-5p3-flash') → 'GLM 5.3 Flash'
 *   formatModelLabel('.../deepseek-v4-flash-0731')  → 'Deepseek V4 Flash'
 *
 * Fireworks spells versions with `p` (`5p3`, `k2p7`) and pins a snapshot date
 * (`-0731`); both are the same model everyone else calls "5.3" / "K2.7", so the
 * label reads them that way.
 */
const ACRONYMS = new Set([
    "gpt",
    "glm",
    "llm",
    "ai",
    "api",
    "sdk",
    "ui",
    "ocr",
]);

export function formatModelLabel(id: string): string {
    if (!id) return id;
    // Deep-pathed ids (e.g. "accounts/fireworks/models/x") name the model in the
    // last segment; the path prefix is routing, not identity.
    const last = id.slice(id.lastIndexOf("/") + 1);
    const tokens = last.split("-").filter(Boolean);
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
        .map((tok) => tok.replace(/^([kv]?\d+)p(\d+)$/i, "$1.$2"))
        .map((tok) =>
            ACRONYMS.has(tok.toLowerCase())
                ? tok.toUpperCase()
                : tok.charAt(0).toUpperCase() + tok.slice(1),
        )
        .join(" ");
}

/** A model id, and the connection it runs on when the ids span several. */
export type LabeledId = { id: string; connection?: string };

/**
 * The label drops a snapshot pin and a path prefix, so different ids can read
 * the same: a pin and its alias (`deepseek-v4.1-flash`, `-1017`), or two
 * routes on one gateway (`openai/gpt-4o`, `azure/gpt-4o`). Those carry their
 * id; labels nobody else has are unchanged. Across connections the prefix is
 * routing, not identity: `gpt-5.4` on OpenAI and `openai/gpt-5.4` on
 * OpenRouter are the same model, and the connection tells them apart. Ids
 * given without a connection all count as one. `nameOf` swaps in another
 * label, such as a provider's own listing name.
 */
export function modelLabeler(
    ids: Iterable<string | LabeledId | undefined | null>,
    nameOf: (id: string) => string = formatModelLabel,
) {
    const lastSegment = (id: string) => id.slice(id.lastIndexOf("/") + 1);
    const byLabel = new Map<string, LabeledId[]>();
    for (const entry of ids) {
        if (!entry) continue;
        const model = typeof entry === "string" ? { id: entry } : entry;
        const label = nameOf(model.id);
        let group = byLabel.get(label);
        if (!group) byLabel.set(label, (group = []));
        group.push(model);
    }
    const clash = (a: LabeledId, b: LabeledId) =>
        a.id !== b.id &&
        (a.connection === b.connection ||
            lastSegment(a.id) !== lastSegment(b.id));
    // Decided per label, so every entry under one label reads the same way.
    const needsId = new Set<string>();
    for (const [label, group] of byLabel) {
        if (group.some((a) => group.some((b) => clash(a, b))))
            needsId.add(label);
    }
    const shares = (id: string, connection?: string) =>
        needsId.has(nameOf(id)) ||
        (byLabel.get(nameOf(id)) ?? []).some((other) =>
            clash(other, { id, connection }),
        );
    const labelOf = (id: string, connection?: string): string =>
        shares(id, connection) ? `${nameOf(id)} (${id})` : nameOf(id);
    return Object.assign(labelOf, { shares });
}
