/**
 * The Kodus provider's model-id grammar — a PURE leaf (no registry, no
 * catalog) so the limiter and other kernel code can parse an id without
 * pulling in the provider modules.
 *
 * `<upstream>/<model>`: the prefix picks the upstream account Kodus routes to
 * (`fireworks` today; `anthropic` | `openai` | `google` stay wired for a later
 * catalog), the remainder is the upstream's own model id, passed through
 * verbatim. Only the FIRST slash splits — a Fireworks id carries several
 * (`fireworks/accounts/fireworks/models/deepseek-v4p1-flash`).
 */

/** Upstream accounts the Kodus provider can route to. The value is the
 *  registered provider id whose module builds the model. */
export const KODUS_UPSTREAMS = {
    // Fireworks serves open models (DeepSeek, Kimi, GLM) over the OpenAI
    // protocol; the kodus module pins the endpoint (see asUpstream).
    fireworks: 'openai_compatible',
    anthropic: 'anthropic',
    openai: 'openai',
    google: 'google_gemini',
} as const;

export type KodusUpstream = keyof typeof KODUS_UPSTREAMS;

export interface KodusModelRef {
    upstream: KodusUpstream;
    /** Registered provider id whose module serves this upstream. */
    providerId: string;
    /** The upstream's own model id (the part after the slash). */
    model: string;
}

/**
 * Catalog ids the upstream stopped serving, mapped to their replacement. BYOK
 * configs keep the id the user saved, so a retired id would otherwise 404 at
 * the upstream and fall out of the closed catalog (no price, so it must not
 * run). Resolving it here keeps those configs reviewing, billed at the
 * replacement's price.
 */
const RETIRED_KODUS_MODELS: ReadonlyMap<string, string> = new Map([
    // Fireworks: 404 "Model not found … not deployed" since 2026-09-27.
    [
        'fireworks/accounts/fireworks/models/deepseek-v4-flash-0731',
        'fireworks/accounts/fireworks/models/deepseek-v4p1-flash',
    ],
]);

/** The id a saved Kodus model id runs as today (retired ids → replacement). */
export function canonicalKodusModelId(id: string): string {
    return RETIRED_KODUS_MODELS.get(id) ?? id;
}

/** Split `<upstream>/<model>` into its parts, or null when the prefix is not
 *  one Kodus routes to (or the id has no slash). Pure, never throws. */
export function splitKodusModelId(rawId: string | undefined): KodusModelRef | null {
    if (!rawId) return null;
    const id = canonicalKodusModelId(rawId);
    const slash = id.indexOf('/');
    if (slash <= 0 || slash === id.length - 1) return null;
    const upstream = id.slice(0, slash) as KodusUpstream;
    const providerId = KODUS_UPSTREAMS[upstream];
    if (!providerId) return null;
    return { upstream, providerId, model: id.slice(slash + 1) };
}
