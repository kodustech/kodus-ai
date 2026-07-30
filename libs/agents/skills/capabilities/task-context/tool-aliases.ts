/**
 * task-context — tool alias keys.
 *
 * Extracted from the task-context-read monolith. Collapses a tool name into a
 * normalized, noise-stripped alias key so a "desired" task-context tool can be
 * matched against the actually-registered MCP tools regardless of casing,
 * pluralization, or boilerplate tokens (provider/workspace/plugin/…). Pure.
 *
 * Public: `buildToolAliasKey`. The token helpers are its internals.
 */

/** Build a normalized alias key (sorted, noise-stripped tokens) for a tool name. */
export function buildToolAliasKey(value: string): string {
    const normalized = value
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .toLowerCase();
    const tokens = normalized
        .split(/[^a-z0-9]+/i)
        .map((token) => normalizeToolAliasToken(token))
        .filter((token) => token.length > 0)
        .filter((token) => !isAliasNoiseToken(token));

    return tokens.sort().join(' ');
}

/** Crude singularization so "issues" ~ "issue", "categories" ~ "category". */
function normalizeToolAliasToken(token: string): string {
    if (token.length > 3 && token.endsWith('ies')) {
        return `${token.slice(0, -3)}y`;
    }
    if (token.length > 3 && token.endsWith('s')) {
        return token.slice(0, -1);
    }
    return token;
}

/** Boilerplate tokens that carry no matching signal. */
function isAliasNoiseToken(token: string): boolean {
    return (
        token === 'provider' ||
        token === 'workspace' ||
        token === 'workspaces' ||
        token === 'plugin' ||
        token === 'integration'
    );
}
