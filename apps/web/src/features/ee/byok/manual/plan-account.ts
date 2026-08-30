/**
 * Account-identity helpers for BYOK plans. A model can ship more than one plan
 * (e.g. Kimi Developer API on api.moonshot.ai vs Kimi Code Plan on api.kimi.com),
 * and each plan is a SEPARATE account with its own key. These pure helpers decide
 * whether an edit has moved to a different account, so the editor can require the
 * plan's own key instead of silently reusing a stored key that won't authenticate.
 */

/** Host of a URL, or undefined if empty/unparseable. */
export function hostOf(u?: string | null): string | undefined {
    if (!u) return undefined;
    try {
        return new URL(u).host;
    } catch {
        return undefined;
    }
}

/**
 * True when an EDIT has moved the model to a plan on a different account — the
 * stored key belongs to the old account (host) and can't be reused. Same host,
 * a fresh add, or unknown endpoints all mean "reuse is fine" → false.
 */
export function planAccountChanged(
    isEditing: boolean,
    storedBaseURL?: string | null,
    selectedBaseURL?: string | null,
): boolean {
    if (!isEditing) return false;
    const stored = hostOf(storedBaseURL);
    const selected = hostOf(selectedBaseURL);
    return !!stored && !!selected && stored !== selected;
}
