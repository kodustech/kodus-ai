/**
 * In-app destinations for notification CTAs.
 *
 * A notification is only useful if it lands where the reader can act, so
 * every event that concerns a scope or a rule carries a link built here
 * rather than a hand-written path in a template. Paths are relative: the
 * in-app drawer navigates them client-side, and the email channel prefixes
 * the web base URL.
 */

/** Rules screen for a scope. `repositoryId` absent = the global scope. */
export const rulesPageLink = (params?: {
    repositoryId?: string;
    directoryId?: string;
    /** Opens this rule's detail panel on arrival. */
    ruleId?: string;
    /** Opens the Memories tab instead of Review Rules. */
    memories?: boolean;
}): string => {
    const scope = params?.repositoryId ?? 'global';
    const query = new URLSearchParams();
    if (params?.ruleId) query.set('rule', params.ruleId);
    if (params?.memories) query.set('tab', 'memories');
    if (params?.directoryId) query.set('directoryId', params.directoryId);
    const suffix = query.toString();
    return `/settings/code-review/${scope}/kody-rules${suffix ? `?${suffix}` : ''}`;
};

/** Where a repository's review configuration is edited. */
export const repositorySettingsLink = (repositoryId?: string): string =>
    `/settings/code-review/${repositoryId ?? 'global'}/general`;

export const APP_LINKS = {
    rulesLibrary: '/library/kody-rules',
    models: '/byok',
    subscription: '/settings/subscription',
    tokenUsage: '/token-usage',
    cockpit: '/cockpit',
    sso: '/organization/sso',
    organizationMembers: '/organization/general',
} as const;
