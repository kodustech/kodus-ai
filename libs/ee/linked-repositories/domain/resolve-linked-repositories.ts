import {
    LinkedRefCandidate,
    LinkedRepositoryConfig,
    MAX_LINKED_REPOSITORIES,
    ResolvedLinkedRepository,
} from './linked-repository.types';
import {
    findOverrideForRepo,
    parsePrDescriptionOverrides,
    type PrDescriptionOverride,
} from './parse-pr-description-overrides';

/** Minimal shape of a team-connected repository used for org-scope checks. */
export type ConnectedRepository = {
    id: string;
    name: string;
    full_name?: string;
    default_branch?: string;
};

/**
 * Provider-specific fetch ref for an open PR head.
 * GitHub: refs/pull/N/head; GitLab: refs/merge-requests/N/head; else branch/SHA.
 */
export type PrHeadRefspecResolver = (
    prNumber: number,
) => { fetchRef: string; displayRef: string };

export type ResolveLinkedRepositoriesInput = {
    configured: LinkedRepositoryConfig[] | undefined | null;
    /** Repositories connected to the same org/team (tenant isolation). */
    connectedRepositories: ConnectedRepository[];
    /** Absolute path of the PR sandbox repo root (used to derive `_linked` base). */
    sandboxRepoDir: string;
    /** PR head branch name — used for same-branch cascade when no pin/override. */
    prHeadBranch?: string;
    /**
     * PR title+body text scanned for `owner/repo#123`, PR URLs, `owner/repo@branch`.
     * Overrides only apply to repos already in `configured`.
     */
    prDescription?: string;
    /**
     * Optional map of linked fullName → open PR on the matching head branch.
     * Populated asynchronously before resolve (prefer open PR over bare branch).
     */
    openPrOnHeadBranch?: Map<
        string,
        { prNumber: number; headRef: string; headSha?: string }
    >;
    /**
     * Resolve a PR number (from description override) to a fetchable ref.
     * Defaults to GitHub-style `refs/pull/N/head`.
     */
    resolvePrHeadRefspec?: PrHeadRefspecResolver;
    /**
     * Resolved head refs for description `#N` overrides (async lookup).
     * Keyed by normalized fullName. When present, replaces the synthetic
     * PR refspec with the real head SHA/branch from the API.
     */
    descriptionPrHeads?: Map<
        string,
        { prNumber: number; headRef: string; headSha?: string }
    >;
    /** Soft cap; defaults to MAX_LINKED_REPOSITORIES. */
    maxLinked?: number;
};

export type ResolveLinkedRepositoriesResult = {
    resolved: ResolvedLinkedRepository[];
    /** Dropped / capped entries — must be surfaced, never silent. */
    warnings: string[];
    /** Parsed description overrides (for logging / enrichment). */
    descriptionOverrides: Map<string, PrDescriptionOverride>;
};

/**
 * Validate and normalize `linkedRepositories` config.
 *
 * Ref cascade (CodeRabbit-style, decision 1):
 *  1. PR-description override (`owner/repo#123` / URL / `@branch`) — per-review
 *  2. Config `ref` pin
 *  3. Open PR on matching head branch (when provided via openPrOnHeadBranch)
 *  4. PR head branch name
 *  5. Linked repo default branch
 *  6. main / master fallbacks
 *
 * Invalid entries are dropped with warnings (never silently).
 * Does NOT clone — that is lazy on first tool access.
 */
export function resolveLinkedRepositories(
    input: ResolveLinkedRepositoriesInput,
): ResolveLinkedRepositoriesResult {
    const warnings: string[] = [];
    const configured = input.configured;
    const descriptionOverrides = parsePrDescriptionOverrides(
        input.prDescription,
    );

    if (!configured?.length) {
        return { resolved: [], warnings, descriptionOverrides };
    }

    // Warn about description overrides that don't match any linked repo —
    // they're ignored by design (only effective for already-linked repos).
    const maxLinked = input.maxLinked ?? MAX_LINKED_REPOSITORIES;
    const connectedByKey = buildConnectedIndex(input.connectedRepositories);
    const resolved: ResolvedLinkedRepository[] = [];
    const seen = new Set<string>();
    const linkedKeys = new Set<string>();

    for (const entry of configured) {
        if (resolved.length >= maxLinked) {
            warnings.push(
                `linkedRepositories capped at ${maxLinked}; dropped "${entry?.repository ?? '(empty)'}".`,
            );
            continue;
        }

        const rawName =
            typeof entry?.repository === 'string'
                ? entry.repository.trim()
                : '';
        if (!rawName) {
            warnings.push(
                'linkedRepositories entry missing required "repository" field; dropped.',
            );
            continue;
        }

        const match = findConnected(rawName, connectedByKey);
        if (!match) {
            warnings.push(
                `linkedRepositories: "${rawName}" is not connected to this organization; dropped.`,
            );
            continue;
        }

        const fullName = normalizeFullName(match);
        const fullKey = fullName.toLowerCase();
        if (seen.has(fullKey)) {
            warnings.push(
                `linkedRepositories: duplicate "${fullName}" ignored.`,
            );
            continue;
        }
        seen.add(fullKey);
        linkedKeys.add(fullKey);
        linkedKeys.add((match.name || '').toLowerCase());

        const defaultBranch =
            (match.default_branch && match.default_branch.trim()) || 'main';
        const configRef =
            typeof entry.ref === 'string' && entry.ref.trim()
                ? entry.ref.trim()
                : undefined;

        const override = findOverrideForRepo(descriptionOverrides, fullName);
        const openPr =
            input.openPrOnHeadBranch?.get(fullKey) ||
            input.openPrOnHeadBranch?.get(fullName) ||
            undefined;
        const descriptionPrHead =
            input.descriptionPrHeads?.get(fullKey) ||
            input.descriptionPrHeads?.get(fullName) ||
            undefined;

        const refCandidates = buildRefCandidates({
            override,
            configRef,
            openPr,
            descriptionPrHead,
            prHeadBranch: input.prHeadBranch?.trim() || undefined,
            defaultBranch,
            resolvePrHeadRefspec:
                input.resolvePrHeadRefspec ?? defaultGithubPrRefspec,
        });

        const preferredRef =
            refCandidates[0]?.displayRef ||
            configRef ||
            input.prHeadBranch?.trim() ||
            defaultBranch;

        const slug = slugifyRepo(fullName);
        const rootPath = linkedRepoRootPath(input.sandboxRepoDir, slug);

        resolved.push({
            repository: rawName,
            fullName,
            id: String(match.id),
            name: match.name || fullName.split('/').pop() || fullName,
            instructions:
                typeof entry.instructions === 'string' &&
                entry.instructions.trim()
                    ? entry.instructions.trim()
                    : undefined,
            preferredRef,
            refCandidates,
            defaultBranch,
            rootPath,
            status: 'pending',
        });
    }

    for (const [key, ov] of descriptionOverrides) {
        const matchesLinked =
            linkedKeys.has(key) ||
            [...linkedKeys].some((k) => k.endsWith(`/${key}`) || key.endsWith(`/${k}`));
        if (!matchesLinked) {
            warnings.push(
                `PR description references "${ov.repository}" but it is not in linkedRepositories; override ignored.`,
            );
        }
    }

    return { resolved, warnings, descriptionOverrides };
}

function buildRefCandidates(args: {
    override?: PrDescriptionOverride;
    configRef?: string;
    openPr?: { prNumber: number; headRef: string; headSha?: string };
    descriptionPrHead?: { prNumber: number; headRef: string; headSha?: string };
    prHeadBranch?: string;
    defaultBranch: string;
    resolvePrHeadRefspec: PrHeadRefspecResolver;
}): LinkedRefCandidate[] {
    const candidates: LinkedRefCandidate[] = [];
    const push = (c: LinkedRefCandidate | null | undefined) => {
        if (!c?.fetchRef) return;
        // Dedupe by fetchRef (case-sensitive for SHAs; branches lowercased).
        const key = c.fetchRef;
        if (candidates.some((x) => x.fetchRef === key)) return;
        candidates.push(c);
    };

    // 1. PR-description override (per-review, most specific)
    if (args.override?.kind === 'pr') {
        if (args.descriptionPrHead) {
            // Prefer concrete head SHA when the API resolved the PR.
            push({
                fetchRef:
                    args.descriptionPrHead.headSha ||
                    args.descriptionPrHead.headRef,
                displayRef: `open PR #${args.override.prNumber}`,
                source: 'pr-description',
                prNumber: args.override.prNumber,
            });
            if (
                args.descriptionPrHead.headRef &&
                args.descriptionPrHead.headRef !==
                    args.descriptionPrHead.headSha
            ) {
                push({
                    fetchRef: args.descriptionPrHead.headRef,
                    displayRef: `open PR #${args.override.prNumber}`,
                    source: 'pr-description',
                    prNumber: args.override.prNumber,
                });
            }
        } else {
            const spec = args.resolvePrHeadRefspec(args.override.prNumber);
            push({
                fetchRef: spec.fetchRef,
                displayRef: spec.displayRef,
                source: 'pr-description',
                prNumber: args.override.prNumber,
            });
        }
    } else if (args.override?.kind === 'branch') {
        push({
            fetchRef: args.override.branch,
            displayRef: args.override.branch,
            source: 'pr-description',
        });
    }

    // 2. Config pin
    if (args.configRef) {
        push({
            fetchRef: args.configRef,
            displayRef: args.configRef,
            source: 'config-pin',
        });
    }

    // 3. Open PR on matching head branch (prefer PR head over bare branch)
    if (args.openPr) {
        push({
            fetchRef: args.openPr.headSha || args.openPr.headRef,
            displayRef: `open PR #${args.openPr.prNumber}`,
            source: 'open-pr',
            prNumber: args.openPr.prNumber,
        });
        if (
            args.openPr.headRef &&
            args.openPr.headRef !== args.openPr.headSha
        ) {
            push({
                fetchRef: args.openPr.headRef,
                displayRef: `open PR #${args.openPr.prNumber}`,
                source: 'open-pr',
                prNumber: args.openPr.prNumber,
            });
        }
    }

    // 4. Same head branch name
    if (args.prHeadBranch) {
        push({
            fetchRef: args.prHeadBranch,
            displayRef: args.prHeadBranch,
            source: 'head-branch',
        });
    }

    // 5. Default branch
    push({
        fetchRef: args.defaultBranch,
        displayRef: args.defaultBranch,
        source: 'default',
    });

    // 6. Fallbacks
    for (const fb of ['main', 'master']) {
        push({
            fetchRef: fb,
            displayRef: fb,
            source: 'fallback',
        });
    }

    return candidates;
}

function defaultGithubPrRefspec(prNumber: number): {
    fetchRef: string;
    displayRef: string;
} {
    return {
        fetchRef: `refs/pull/${prNumber}/head`,
        displayRef: `open PR #${prNumber}`,
    };
}

/** Provider-aware PR head refspec helper used by the pipeline stage. */
export function prHeadRefspecForPlatform(
    platform: string | undefined,
    prNumber: number,
): { fetchRef: string; displayRef: string } {
    const p = (platform || '').toLowerCase();
    if (p.includes('gitlab')) {
        return {
            fetchRef: `refs/merge-requests/${prNumber}/head`,
            displayRef: `open PR #${prNumber}`,
        };
    }
    // GitHub, Forgejo, Gitea, and most GH-compat hosts use pull/N/head.
    // Bitbucket/Azure don't expose a stable PR refspec — callers should
    // resolve the head SHA via API (descriptionPrHeads / openPrOnHeadBranch).
    return {
        fetchRef: `refs/pull/${prNumber}/head`,
        displayRef: `open PR #${prNumber}`,
    };
}

function buildConnectedIndex(
    connected: ConnectedRepository[],
): Map<string, ConnectedRepository> {
    const map = new Map<string, ConnectedRepository>();
    for (const repo of connected || []) {
        if (!repo) continue;
        const keys = [
            repo.id != null ? String(repo.id) : '',
            repo.name,
            repo.full_name,
            normalizeFullName(repo),
        ]
            .filter(Boolean)
            .map((k) => k!.toLowerCase());
        for (const key of keys) {
            if (!map.has(key)) map.set(key, repo);
        }
    }
    return map;
}

function findConnected(
    wanted: string,
    index: Map<string, ConnectedRepository>,
): ConnectedRepository | undefined {
    const key = wanted.toLowerCase().replace(/\.git$/, '');
    return (
        index.get(key) ||
        index.get(key.split('/').pop() || key) ||
        undefined
    );
}

function normalizeFullName(repo: ConnectedRepository): string {
    if (repo.full_name && repo.full_name.trim()) {
        return repo.full_name.trim().replace(/\.git$/, '');
    }
    return (repo.name || String(repo.id)).trim();
}

/** Filesystem-safe slug for the linked clone directory. */
export function slugifyRepo(fullName: string): string {
    return (
        fullName
            .replace(/\.git$/, '')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '')
            .slice(0, 80) || 'repo'
    );
}

/**
 * Absolute path for a linked-repo clone.
 * E2B: `/home/user/repo` → `/home/user/_linked/<slug>`
 * Local: temp dir is the repo root → nest under `<repoDir>/_linked/<slug>`
 * so cleanup still covers the clones.
 */
export function linkedRepoRootPath(
    sandboxRepoDir: string,
    slug: string,
): string {
    const repoDir = sandboxRepoDir.replace(/\/+$/, '');
    const isE2bLayout = /\/repo$/.test(repoDir);
    const base = isE2bLayout
        ? repoDir.replace(/\/repo$/, '/_linked')
        : `${repoDir}/_linked`;
    return `${base}/${slug}`;
}
