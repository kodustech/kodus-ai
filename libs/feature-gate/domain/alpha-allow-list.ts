/**
 * Whether an organization is on a feature's env allow-list: `*` (everyone,
 * for dev VMs, previews and e2e) or comma-separated organization ids. One
 * definition for the API's gate and the web app's, so the page and the API
 * never disagree on who is in.
 */
export function isOnAlphaAllowList(
    raw: string | undefined,
    organizationId: string | undefined,
): boolean {
    const value = (raw ?? '').trim();
    if (value === '*') {
        return true;
    }
    if (!organizationId) {
        return false;
    }
    return value
        .split(',')
        .map((id) => id.trim())
        .some((id) => id.length > 0 && id === organizationId);
}
