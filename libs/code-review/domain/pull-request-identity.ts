/** Canonical provider location, including the host and repository path. */
export function pullRequestLocation(url?: string): string | undefined {
    const parsed = parsePullRequestUrl(url);
    return parsed && parsed.origin + parsed.pathname.replace(/\/+$/, '');
}

/** The provider instance stays the same when the PR's URL scheme or path changes. */
export function pullRequestHost(url?: string): string | undefined {
    return parsePullRequestUrl(url)?.host;
}

function parsePullRequestUrl(url?: string): URL | undefined {
    if (!url) return undefined;
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
            return undefined;
        return parsed;
    } catch {
        return undefined;
    }
}
