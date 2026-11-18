/** Canonical provider location, including the host and repository path. */
export function pullRequestLocation(
    url: string | undefined,
): string | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
            return undefined;
        return parsed.origin + parsed.pathname.replace(/\/+$/, '');
    } catch {
        return undefined;
    }
}
