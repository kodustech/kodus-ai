/**
 * Parse PR-description overrides for linked repositories (#1576 decision 1).
 *
 * Supported forms (only applied to repos already in the linked list):
 *  - `owner/repo#123` — review against that open PR's head
 *  - PR/MR URLs (GitHub / GitLab / Bitbucket / Azure DevOps)
 *  - `owner/repo@branch` — pin a branch on the linked repo
 *
 * Later mentions of the same repository win (closest to the bottom of the body,
 * matching "latest instruction" intuition).
 */

export type PrDescriptionOverride =
    | { kind: 'pr'; repository: string; prNumber: number }
    | { kind: 'branch'; repository: string; branch: string };

/**
 * Extract per-repo overrides from free-text PR title/body.
 * Returns a map keyed by normalized fullName (lowercase, no .git).
 */
export function parsePrDescriptionOverrides(
    text: string | undefined | null,
): Map<string, PrDescriptionOverride> {
    const result = new Map<string, PrDescriptionOverride>();
    if (!text || typeof text !== 'string') return result;

    // Collect matches in order; later overwrites earlier for the same repo.
    const patterns: Array<{
        re: RegExp;
        toOverride: (m: RegExpExecArray) => PrDescriptionOverride | null;
    }> = [
        // GitHub PR URL: https://github.com/owner/repo/pull/123
        {
            re: /https?:\/\/(?:www\.)?github\.com\/([^\s/#]+)\/([^\s/#]+)\/pull\/(\d+)/gi,
            toOverride: (m) => ({
                kind: 'pr',
                repository: `${m[1]}/${m[2]}`,
                prNumber: Number(m[3]),
            }),
        },
        // GitLab MR URL: https://gitlab.com/group/project/-/merge_requests/123
        // Also supports nested groups: group/sub/project
        {
            re: /https?:\/\/[^\s/]*gitlab[^\s/]*\/([^\s]+?)\/-\/merge_requests\/(\d+)/gi,
            toOverride: (m) => ({
                kind: 'pr',
                repository: m[1].replace(/\/$/, ''),
                prNumber: Number(m[2]),
            }),
        },
        // Bitbucket PR URL: https://bitbucket.org/workspace/repo/pull-requests/123
        {
            re: /https?:\/\/(?:www\.)?bitbucket\.org\/([^\s/#]+)\/([^\s/#]+)\/pull-requests\/(\d+)/gi,
            toOverride: (m) => ({
                kind: 'pr',
                repository: `${m[1]}/${m[2]}`,
                prNumber: Number(m[3]),
            }),
        },
        // Azure DevOps PR URL: .../_git/repo/pullrequest/123 or .../pullrequest/123
        {
            re: /https?:\/\/dev\.azure\.com\/[^\s]+\/_git\/([^\s/?#]+)\/pullrequest\/(\d+)/gi,
            toOverride: (m) => ({
                kind: 'pr',
                repository: m[1],
                prNumber: Number(m[2]),
            }),
        },
        // Shorthand: owner/repo#123 (also group/sub/repo#123)
        {
            re: /\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)#(\d+)\b/g,
            toOverride: (m) => ({
                kind: 'pr',
                repository: m[1],
                prNumber: Number(m[2]),
            }),
        },
        // Branch pin: owner/repo@branch (branch may contain /)
        {
            re: /\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)@([A-Za-z0-9_./-]+)\b/g,
            toOverride: (m) => {
                // Skip email-like false positives (a@b.com) — require a slash in repo.
                if (!m[1].includes('/')) return null;
                // Skip if it looks like a URL host fragment we already handled.
                if (m[2].includes('://')) return null;
                return {
                    kind: 'branch',
                    repository: m[1],
                    branch: m[2],
                };
            },
        },
    ];

    for (const { re, toOverride } of patterns) {
        re.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = re.exec(text)) !== null) {
            const override = toOverride(match);
            if (!override) continue;
            if (
                override.kind === 'pr' &&
                (!Number.isFinite(override.prNumber) || override.prNumber <= 0)
            ) {
                continue;
            }
            const key = normalizeRepoKey(override.repository);
            if (!key) continue;
            result.set(key, {
                ...override,
                repository: override.repository.replace(/\.git$/i, ''),
            });
        }
    }

    return result;
}

export function normalizeRepoKey(fullName: string): string {
    return fullName
        .trim()
        .replace(/\.git$/i, '')
        .replace(/^\/+|\/+$/g, '')
        .toLowerCase();
}

/**
 * Look up an override for a linked repo, matching fullName or trailing name.
 */
export function findOverrideForRepo(
    overrides: Map<string, PrDescriptionOverride>,
    fullName: string,
): PrDescriptionOverride | undefined {
    const key = normalizeRepoKey(fullName);
    if (overrides.has(key)) return overrides.get(key);
    const short = key.split('/').pop();
    if (!short) return undefined;
    // Only match short name if exactly one override ends with that segment —
    // avoid accidental collisions when multiple linked repos share a name.
    let found: PrDescriptionOverride | undefined;
    let count = 0;
    for (const [k, v] of overrides) {
        if (k === short || k.endsWith(`/${short}`)) {
            found = v;
            count += 1;
        }
    }
    return count === 1 ? found : undefined;
}
