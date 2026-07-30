/** Minimal shape of a BYOK config slot — just the model id we price-check. */
interface ByokModelSlots {
    main?: { model?: string };
    fallback?: { model?: string };
}

/**
 * Assemble the distinct, non-blank model ids that a spend limit must be able
 * to price: the BYOK `main` and `fallback` models, plus any extra models the
 * caller supplies (e.g. per-repository / per-directory `byokModel` overrides).
 */
export function collectByokModels(
    byokConfig?: ByokModelSlots | null,
    extraModels: string[] = [],
): string[] {
    const candidates = [
        byokConfig?.main?.model,
        byokConfig?.fallback?.model,
        ...extraModels,
    ];

    return [
        ...new Set(
            candidates
                .map((m) => m?.trim())
                .filter((m): m is string => Boolean(m)),
        ),
    ];
}

/**
 * Deep-collect every `byokModel` string in a code-review config value. The
 * config is stored as untyped jsonb with per-repository and per-directory
 * overrides at varying depths, so we walk the whole structure rather than rely
 * on a fixed shape. Returns raw values (not de-duplicated); callers fold them
 * into `collectByokModels`.
 */
export function extractByokModelsFromConfig(configValue: unknown): string[] {
    const found: string[] = [];

    const walk = (node: unknown): void => {
        if (Array.isArray(node)) {
            node.forEach(walk);
            return;
        }
        if (node && typeof node === 'object') {
            for (const [key, value] of Object.entries(node)) {
                if (key === 'byokModel' && typeof value === 'string') {
                    found.push(value);
                } else {
                    walk(value);
                }
            }
        }
    };

    walk(configValue);
    return found;
}
