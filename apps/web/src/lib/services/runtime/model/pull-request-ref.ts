// Pull requests typed in "Simulate on past PRs": a URL of this repository's
// PR, `#482` or `482`, one or several.

export type PullRequestRef =
    { ok: true; prNumber: number } | { ok: false; error: string };

const PR_URL =
    /^https?:\/\/[^/]+\/(.+?)\/(?:pull|pull-requests|merge_requests|-\/merge_requests)\/(\d{1,9})(?:[/?#].*)?$/;

/** One pull request. A URL of another repository is refused. */
export const parsePullRequestRef = (
    input: string,
    repositoryName?: string,
): PullRequestRef => {
    const v = input.trim();
    if (!v) return { ok: false, error: "Paste a pull request URL or number." };
    const plain = /^#?(\d{1,9})$/.exec(v);
    if (plain) {
        const prNumber = Number(plain[1]);
        return prNumber > 0
            ? { ok: true, prNumber }
            : { ok: false, error: "Not a pull request number." };
    }
    const url = PR_URL.exec(v);
    if (!url) return { ok: false, error: "Not a pull request URL." };
    const path = url[1].replace(/\/-$/, "");
    if (repositoryName && path.toLowerCase() !== repositoryName.toLowerCase())
        return {
            ok: false,
            error: `That pull request is not in ${repositoryName}.`,
        };
    return { ok: true, prNumber: Number(url[2]) };
};

export const MAX_SIMULATED_PULL_REQUESTS = 5;

/**
 * Several pull requests, separated by commas, spaces or new lines. Duplicates
 * collapse; the first bad entry is the error.
 */
export const parsePullRequestRefs = (
    input: string,
    repositoryName?: string,
): { ok: true; prNumbers: number[] } | { ok: false; error: string } => {
    const parts = input.split(/[\s,]+/).filter(Boolean);
    if (parts.length === 0)
        return { ok: false, error: "Paste a pull request URL or number." };
    const prNumbers: number[] = [];
    for (const part of parts) {
        const ref = parsePullRequestRef(part, repositoryName);
        if (!ref.ok) return { ok: false, error: `${part}: ${ref.error}` };
        if (!prNumbers.includes(ref.prNumber)) prNumbers.push(ref.prNumber);
    }
    if (prNumbers.length > MAX_SIMULATED_PULL_REQUESTS)
        return {
            ok: false,
            error: `Up to ${MAX_SIMULATED_PULL_REQUESTS} pull requests at a time.`,
        };
    return { ok: true, prNumbers };
};
