import type { RepositoryFact } from './repository-facts';

/**
 * Which apps of a monorepo the repository's open pull requests change, so the
 * recipe author boots the app the Runs will test instead of the easiest one
 * (a design partner's author booted a small app the PRs never touched, and
 * every Run of theirs stopped at "Fix the recipe"). Computed from the changed
 * paths alone, no model; a path names a member only as a plain path token.
 */
export interface PullRequestPaths {
    number: number;
    paths: readonly string[];
}

export const PULL_REQUEST_FOCUS_LIMITS = {
    /** Open pull requests read, the most recently updated first. */
    pullRequests: 10,
    /** Members the fact names. */
    shown: 6,
} as const;

/** Top-level directories that hold apps by convention, for a repository with no workspace globs. */
const CONVENTIONAL_ROOTS = new Set(['apps', 'packages', 'services', 'libs', 'projects']);
const SEGMENT = /^[\w@.+-]{1,80}$/;

function segmentMatches(pattern: string, segment: string): boolean {
    if (pattern === '*' || pattern === '**') return true;
    if (!pattern.includes('*')) return pattern === segment;
    const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
    return re.test(segment);
}

/**
 * The workspace member a changed path belongs to: the first glob whose
 * segments match the path's leading segments (`apps/*` gives apps/<name>).
 * With no globs, apps/<name>, packages/<name>... by convention. Null for a
 * root file, a path under no member, or a name that is not a plain path.
 */
export function memberOf(path: string, globs: readonly string[]): string | null {
    const segments = path.split('/');
    if (segments.length < 2 || segments.some((s) => !SEGMENT.test(s) || s === '..' || s === '.')) return null;
    const split = (g: string) => {
        const parts = g.replace(/^!/, '').replace(/^\.\//, '').replace(/\/+$/, '').split('/');
        // A trailing ** names the directory before it as the member (packages/** reads as packages/*).
        return parts[parts.length - 1] === '**' && parts.length > 1 ? [...parts.slice(0, -1), '*'] : parts;
    };
    const under = (p: string[]) => segments.length > p.length && p.every((part, i) => segmentMatches(part, segments[i]));
    const excluded = globs.filter((g) => g.startsWith('!')).map(split);
    for (const p of globs.filter((g) => !g.startsWith('!')).map(split)) {
        if (!under(p)) continue;
        const member = segments.slice(0, p.length);
        // !apps/legacy leaves that member out of apps/*, as the package manager does.
        if (excluded.some((x) => x.length === member.length && x.every((part, i) => segmentMatches(part, member[i])))) return null;
        return member.join('/');
    }
    if (globs.length) return null;
    return CONVENTIONAL_ROOTS.has(segments[0]) && segments.length > 2 ? segments.slice(0, 2).join('/') : null;
}

/** Members by how many pull requests change them, most first, then by name. */
export function pullRequestFocus(prs: readonly PullRequestPaths[], globs: readonly string[]): Array<{ member: string; pullRequests: number }> {
    const counts = new Map<string, number>();
    for (const pr of prs) {
        const members = new Set(pr.paths.map((p) => memberOf(p, globs)).filter((m): m is string => m !== null));
        for (const m of members) counts.set(m, (counts.get(m) ?? 0) + 1);
    }
    return [...counts.entries()].map(([member, pullRequests]) => ({ member, pullRequests })).sort((a, b) => b.pullRequests - a.pullRequests || a.member.localeCompare(b.member));
}

/** The Facts line, or null when no pull request changes a member. */
export function pullRequestFocusFact(prs: readonly PullRequestPaths[], globs: readonly string[]): RepositoryFact | null {
    const focus = pullRequestFocus(prs, globs);
    if (!focus.length) return null;
    const of = prs.length;
    const shown = focus.slice(0, PULL_REQUEST_FOCUS_LIMITS.shown).map((f) => `${f.member} (${f.pullRequests} of ${of})`);
    const more = focus.length > shown.length ? `, ${focus.length - shown.length} more` : '';
    return {
        fact: `open pull requests change: ${shown.join(', ')}${more}; boot the app they change most`,
        source: `the ${of} most recently updated open pull requests`,
    };
}
