import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createLogger } from '@libs/core/log/logger';
import type { IGitHubPublicPrService } from '@libs/cli-review/domain/contracts/github-public-pr.service.contract';

export interface ParsedPrUrl {
    owner: string;
    repo: string;
    prNumber: number;
}

export interface PublicPrAuthor {
    login: string;
    avatarUrl?: string;
    htmlUrl?: string;
}

export interface PublicPrLabel {
    name: string;
    /** Background hex color (without #) from the GitHub label. */
    color?: string;
    description?: string;
}

export interface PublicPrAssignee {
    login: string;
    avatarUrl?: string;
    htmlUrl?: string;
}

export interface PublicPrReviewer {
    login: string;
    avatarUrl?: string;
    state: 'approved' | 'changes_requested' | 'commented' | 'pending';
}

export interface PublicPrCheckSummary {
    total: number;
    passed: number;
    failed: number;
    pending: number;
    conclusion: 'success' | 'failure' | 'partial' | 'pending' | 'unknown';
}

export interface PublicPrCommit {
    sha: string;
    message: string;
    authorLogin?: string;
    authorAvatarUrl?: string;
    authoredAt?: string;
    htmlUrl: string;
}

export interface PublicPrComment {
    id: number;
    authorLogin?: string;
    authorAvatarUrl?: string;
    body: string;
    createdAt: string;
    htmlUrl: string;
    /** "issue" = top-level PR comment; "review" = inline code comment. */
    kind: 'issue' | 'review';
    path?: string;
    line?: number;
}

export interface PublicPrMetadata {
    owner: string;
    repo: string;
    prNumber: number;
    title: string;
    state: 'open' | 'closed';
    /** When state is closed, was this PR merged or just closed without merge. */
    merged: boolean;
    isDraft: boolean;
    headSha: string;
    headRef: string;
    baseSha: string;
    baseRef: string;
    additions: number;
    deletions: number;
    changedFiles: number;
    /** Number of commits in the PR. */
    commitsCount: number;
    /** Number of issue comments + review comments — proxy for "discussion". */
    discussionCount: number;
    htmlUrl: string;
    cloneUrl: string;
    diff: string;
    author?: PublicPrAuthor;
    reviewers: PublicPrReviewer[];
    checks?: PublicPrCheckSummary;
    commits: PublicPrCommit[];
    comments: PublicPrComment[];
    labels: PublicPrLabel[];
    assignees: PublicPrAssignee[];
    /** PR description body (markdown), pulled from `body` on the GitHub
     *  pull-request payload. Capped server-side to keep the snapshot
     *  small; long descriptions truncate. */
    body?: string;
}

export class PublicPrFetchError extends Error {
    constructor(
        message: string,
        public readonly code:
            | 'invalid_url'
            | 'not_found'
            | 'requires_auth'
            | 'too_large'
            | 'rate_limited'
            | 'upstream_error',
        public readonly statusCode: number = 400,
    ) {
        super(message);
        this.name = 'PublicPrFetchError';
    }
}

@Injectable()
export class GitHubPublicPrService implements IGitHubPublicPrService {
    private readonly logger = createLogger(GitHubPublicPrService.name);
    private readonly apiBase = 'https://api.github.com';

    // Caps for the public demo. Past these we route the user through
    // signup instead of running the review — anonymous LLM/sandbox
    // budget would balloon, and reviews this large take 10+ minutes
    // which kills the demo UX anyway.
    private readonly MAX_CHANGED_LINES = 10000;
    private readonly MAX_CHANGED_FILES = 80;

    constructor(private readonly configService: ConfigService) {}

    parseUrl(prUrl: string): ParsedPrUrl {
        let url: URL;
        try {
            url = new URL(prUrl.trim());
        } catch {
            throw new PublicPrFetchError(
                'Invalid URL — paste a full https://github.com/... URL',
                'invalid_url',
            );
        }

        const host = url.hostname.toLowerCase();

        // If the URL clearly belongs to a non-GitHub provider, surface
        // it as `requires_auth` so the frontend shows the "connect your
        // provider" signup CTA instead of a dead-end validation error.
        const otherProvider = detectOtherProvider(host, url.pathname);
        if (otherProvider) {
            throw new PublicPrFetchError(
                `Kodus's public demo only supports GitHub today. Sign up and connect ${otherProvider} to review ${otherProvider} PRs.`,
                'requires_auth',
                403,
            );
        }

        if (host !== 'github.com' && host !== 'www.github.com') {
            throw new PublicPrFetchError(
                'Only github.com URLs are supported in the public demo. Sign up to review PRs from self-hosted GitHub / GitLab / Bitbucket / Azure DevOps.',
                'requires_auth',
                403,
            );
        }

        const segments = url.pathname.split('/').filter(Boolean);
        const pullIdx = segments.indexOf('pull');
        if (pullIdx < 2 || pullIdx + 1 >= segments.length) {
            throw new PublicPrFetchError(
                'URL must be in the form github.com/owner/repo/pull/123',
                'invalid_url',
            );
        }

        const owner = segments[pullIdx - 2];
        const repo = segments[pullIdx - 1].replace(/\.git$/, '');
        const prNumber = Number.parseInt(segments[pullIdx + 1], 10);

        if (!owner || !repo || !Number.isFinite(prNumber) || prNumber < 1) {
            throw new PublicPrFetchError(
                'URL must be in the form github.com/owner/repo/pull/123',
                'invalid_url',
            );
        }

        return { owner, repo, prNumber };
    }

    async fetch(prUrl: string): Promise<PublicPrMetadata> {
        const parsed = this.parseUrl(prUrl);

        // Metadata + diff are mandatory. Everything else is best-effort —
        // we don't want to fail the whole demo because one auxiliary
        // call hit a rate limit or transient 5xx.
        const [meta, diff, reviewers, checks, commits, comments] =
            await Promise.all([
                this.fetchPrMetadata(parsed),
                this.fetchPrDiff(parsed),
                this.fetchReviewers(parsed).catch(() => []),
                this.fetchChecks(parsed).catch(() => undefined),
                this.fetchCommits(parsed).catch(
                    () => [] as PublicPrCommit[],
                ),
                this.fetchComments(parsed).catch(
                    () => [] as PublicPrComment[],
                ),
            ]);

        const totalLines = meta.additions + meta.deletions;
        if (totalLines > this.MAX_CHANGED_LINES) {
            throw new PublicPrFetchError(
                `This PR has ${totalLines.toLocaleString()} lines changed — a bit much for the free demo. Sign up (free) and Kody reviews PRs of any size on your own repos.`,
                'too_large',
                413,
            );
        }
        if (meta.changedFiles > this.MAX_CHANGED_FILES) {
            throw new PublicPrFetchError(
                `This PR touches ${meta.changedFiles} files — past the free demo cap. Sign up (free) and Kody reviews PRs of any size on your own repos.`,
                'too_large',
                413,
            );
        }

        return { ...meta, diff, reviewers, checks, commits, comments };
    }

    private async fetchCommits(
        parsed: ParsedPrUrl,
    ): Promise<PublicPrCommit[]> {
        const url = `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/commits?per_page=30`;
        const response = await this.githubFetch(url, {
            Accept: 'application/vnd.github+json',
        });
        if (!response.ok) return [];
        const body = (await response.json()) as any[];
        return body.map((c) => ({
            sha: c.sha,
            // First line only — GitHub's UI does the same. Keeps the
            // commit row scannable without expanding multi-paragraph
            // bodies.
            message: (c.commit?.message ?? '').split('\n')[0] || '',
            authorLogin: c.author?.login ?? c.commit?.author?.name,
            authorAvatarUrl: c.author?.avatar_url,
            authoredAt: c.commit?.author?.date,
            htmlUrl:
                c.html_url ??
                `https://github.com/${parsed.owner}/${parsed.repo}/commit/${c.sha}`,
        }));
    }

    private async fetchComments(
        parsed: ParsedPrUrl,
    ): Promise<PublicPrComment[]> {
        // Two distinct GitHub endpoints — issue comments are the
        // top-level PR conversation, review comments are inline replies
        // on code lines. We merge them so the Discussion tab matches
        // the count we already advertise.
        const [issueRes, reviewRes] = await Promise.all([
            this.githubFetch(
                `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/issues/${parsed.prNumber}/comments?per_page=30`,
                { Accept: 'application/vnd.github+json' },
            ),
            this.githubFetch(
                `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/comments?per_page=30`,
                { Accept: 'application/vnd.github+json' },
            ),
        ]);

        const items: PublicPrComment[] = [];

        if (issueRes.ok) {
            const body = (await issueRes.json()) as any[];
            for (const c of body) {
                items.push({
                    id: c.id,
                    authorLogin: c.user?.login,
                    authorAvatarUrl: c.user?.avatar_url,
                    body: c.body ?? '',
                    createdAt: c.created_at,
                    htmlUrl: c.html_url,
                    kind: 'issue',
                });
            }
        }
        if (reviewRes.ok) {
            const body = (await reviewRes.json()) as any[];
            for (const c of body) {
                items.push({
                    id: c.id,
                    authorLogin: c.user?.login,
                    authorAvatarUrl: c.user?.avatar_url,
                    body: c.body ?? '',
                    createdAt: c.created_at,
                    htmlUrl: c.html_url,
                    kind: 'review',
                    path: c.path,
                    line: c.line ?? c.original_line,
                });
            }
        }

        items.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        // Cap at 40 so the job payload stays small; the link to GitHub
        // is right there in the header for the rare case of >40 cmts.
        return items.slice(0, 40);
    }

    private async fetchReviewers(
        parsed: ParsedPrUrl,
    ): Promise<PublicPrReviewer[]> {
        const url = `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}/reviews?per_page=100`;
        const response = await this.githubFetch(url, {
            Accept: 'application/vnd.github+json',
        });
        if (!response.ok) return [];
        const body = (await response.json()) as any[];

        // Collapse multiple reviews from the same user into the latest
        // non-COMMENTED state — same heuristic GitHub uses on the PR
        // page so "Approved" sticks until the user requests changes.
        const map = new Map<string, PublicPrReviewer>();
        for (const review of body) {
            const login = review?.user?.login;
            if (!login) continue;
            const state = mapReviewState(review?.state);
            const prev = map.get(login);
            // Always keep the most recent meaningful state; "commented"
            // is the weakest and only wins if nothing else is set.
            if (
                !prev ||
                state !== 'commented' ||
                prev.state === 'commented'
            ) {
                map.set(login, {
                    login,
                    avatarUrl: review?.user?.avatar_url,
                    state,
                });
            }
        }
        return Array.from(map.values()).slice(0, 8);
    }

    private async fetchChecks(
        parsed: ParsedPrUrl,
    ): Promise<PublicPrCheckSummary | undefined> {
        // First need the head SHA; the diff fetch path doesn't expose it
        // back here, so query the PR endpoint just for that field.
        const prRes = await this.githubFetch(
            `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}`,
            { Accept: 'application/vnd.github+json' },
        );
        if (!prRes.ok) return undefined;
        const prBody = (await prRes.json()) as any;
        const sha = prBody?.head?.sha;
        if (!sha) return undefined;

        const checksRes = await this.githubFetch(
            `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/commits/${sha}/check-runs?per_page=100`,
            { Accept: 'application/vnd.github+json' },
        );
        if (!checksRes.ok) return undefined;
        const checks = (await checksRes.json()) as any;
        const runs: any[] = checks?.check_runs ?? [];
        if (runs.length === 0) return undefined;

        let passed = 0;
        let failed = 0;
        let pending = 0;
        for (const run of runs) {
            if (run.status !== 'completed') {
                pending += 1;
                continue;
            }
            if (run.conclusion === 'success' || run.conclusion === 'neutral') {
                passed += 1;
            } else if (
                run.conclusion === 'skipped' ||
                run.conclusion === 'stale'
            ) {
                // Don't fail the bucket for skipped runs — GitHub UI
                // doesn't treat them as red either.
                passed += 1;
            } else {
                failed += 1;
            }
        }

        const total = runs.length;
        const conclusion: PublicPrCheckSummary['conclusion'] = pending
            ? 'pending'
            : failed === 0
              ? 'success'
              : passed === 0
                ? 'failure'
                : 'partial';

        return { total, passed, failed, pending, conclusion };
    }

    private async fetchPrMetadata(parsed: ParsedPrUrl) {
        const url = `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}`;
        const response = await this.githubFetch(url, {
            Accept: 'application/vnd.github+json',
        });

        if (response.status === 404 || response.status === 403) {
            throw new PublicPrFetchError(
                'This PR is private or not found. Sign up and connect GitHub to review private PRs.',
                'requires_auth',
                403,
            );
        }
        if (response.status === 429 || this.isPrimaryRateLimited(response)) {
            throw new PublicPrFetchError(
                'GitHub rate limit reached. Try again in a few minutes.',
                'rate_limited',
                429,
            );
        }
        if (!response.ok) {
            throw new PublicPrFetchError(
                `GitHub returned ${response.status} when fetching PR metadata.`,
                'upstream_error',
                502,
            );
        }

        const body = (await response.json()) as any;

        return {
            owner: parsed.owner,
            repo: parsed.repo,
            prNumber: parsed.prNumber,
            title: body.title ?? `PR #${parsed.prNumber}`,
            state: body.state === 'closed' ? 'closed' : 'open',
            merged: !!body.merged_at,
            isDraft: !!body.draft,
            headSha: body.head?.sha ?? '',
            headRef: body.head?.ref ?? '',
            baseSha: body.base?.sha ?? '',
            baseRef: body.base?.ref ?? 'main',
            additions: body.additions ?? 0,
            deletions: body.deletions ?? 0,
            changedFiles: body.changed_files ?? 0,
            commitsCount: body.commits ?? 0,
            discussionCount:
                (body.comments ?? 0) + (body.review_comments ?? 0),
            htmlUrl: body.html_url ?? prUrlFromParsed(parsed),
            cloneUrl: `https://github.com/${parsed.owner}/${parsed.repo}.git`,
            author: body.user?.login
                ? {
                      login: body.user.login,
                      avatarUrl: body.user.avatar_url,
                      htmlUrl: body.user.html_url,
                  }
                : undefined,
            labels: Array.isArray(body.labels)
                ? body.labels
                      .map((l: any) => ({
                          name: l?.name as string,
                          color: l?.color as string | undefined,
                          description: l?.description as string | undefined,
                      }))
                      .filter((l: any) => !!l.name)
                : [],
            assignees: Array.isArray(body.assignees)
                ? body.assignees
                      .map((a: any) => ({
                          login: a?.login as string,
                          avatarUrl: a?.avatar_url as string | undefined,
                          htmlUrl: a?.html_url as string | undefined,
                      }))
                      .filter((a: any) => !!a.login)
                : [],
            // Truncate the body so a 10k-line description doesn't blow
            // up the job payload. Markdown renders fine truncated.
            body: typeof body.body === 'string'
                ? body.body.slice(0, 8000)
                : undefined,
        } as const;
    }

    private async fetchPrDiff(parsed: ParsedPrUrl): Promise<string> {
        const url = `${this.apiBase}/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.prNumber}`;
        const response = await this.githubFetch(url, {
            Accept: 'application/vnd.github.v3.diff',
        });

        if (response.status === 404 || response.status === 403) {
            throw new PublicPrFetchError(
                'This PR is private or not found.',
                'requires_auth',
                403,
            );
        }
        if (response.status === 406 || response.status === 422) {
            // GitHub returns 406 for diffs that are too large.
            throw new PublicPrFetchError(
                'PR diff is too large to fetch from GitHub. Sign up to review it.',
                'too_large',
                413,
            );
        }
        if (response.status === 429 || this.isPrimaryRateLimited(response)) {
            throw new PublicPrFetchError(
                'GitHub rate limit reached. Try again in a few minutes.',
                'rate_limited',
                429,
            );
        }
        if (!response.ok) {
            throw new PublicPrFetchError(
                `GitHub returned ${response.status} when fetching PR diff.`,
                'upstream_error',
                502,
            );
        }

        return await response.text();
    }

    private async githubFetch(
        url: string,
        headers: Record<string, string>,
    ): Promise<Response> {
        const finalHeaders: Record<string, string> = {
            'User-Agent': 'kodus-public-demo',
            ...headers,
        };

        const token = this.configService.get<string>('GITHUB_PUBLIC_DEMO_PAT');
        if (token) {
            finalHeaders.Authorization = `Bearer ${token}`;
        }

        try {
            return await fetch(url, { headers: finalHeaders });
        } catch (err) {
            this.logger.warn({
                message: 'GitHub fetch failed',
                context: GitHubPublicPrService.name,
                error: err,
                metadata: { url },
            });
            throw new PublicPrFetchError(
                'Failed to reach GitHub. Try again in a few seconds.',
                'upstream_error',
                502,
            );
        }
    }

    private isPrimaryRateLimited(response: Response): boolean {
        const remaining = response.headers.get('x-ratelimit-remaining');
        return remaining === '0';
    }
}

function mapReviewState(s: string | undefined): PublicPrReviewer['state'] {
    switch ((s ?? '').toLowerCase()) {
        case 'approved':
            return 'approved';
        case 'changes_requested':
            return 'changes_requested';
        case 'pending':
            return 'pending';
        default:
            return 'commented';
    }
}

function prUrlFromParsed(parsed: ParsedPrUrl): string {
    return `https://github.com/${parsed.owner}/${parsed.repo}/pull/${parsed.prNumber}`;
}

/**
 * Spot the obvious non-GitHub PR/MR URLs so we can route the user to
 * the signup CTA with a provider-specific message instead of a generic
 * "invalid URL" error. Returns the canonical provider name or null.
 */
function detectOtherProvider(host: string, pathname: string): string | null {
    const path = pathname.toLowerCase();

    // GitLab.com (and gitlab.* SaaS variants). MR URLs look like
    // /group/{...subgroups}/repo/-/merge_requests/123
    if (host === 'gitlab.com' || host.endsWith('.gitlab.com')) {
        return 'GitLab';
    }
    if (path.includes('/-/merge_requests/')) {
        return 'GitLab';
    }

    // Bitbucket Cloud: /workspace/repo/pull-requests/123
    if (host === 'bitbucket.org' || host.endsWith('.bitbucket.org')) {
        return 'Bitbucket';
    }
    if (path.includes('/pull-requests/')) {
        return 'Bitbucket';
    }

    // Azure DevOps: dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/N
    // or legacy {org}.visualstudio.com/...
    if (
        host === 'dev.azure.com' ||
        host.endsWith('.visualstudio.com') ||
        path.includes('/_git/') ||
        path.includes('/pullrequest/')
    ) {
        return 'Azure DevOps';
    }

    // GitHub Enterprise: any host whose path matches github's PR shape
    // (.../pull/N) but isn't github.com. We don't validate strictly —
    // good enough heuristic to recognize "this looks like GitHub
    // somewhere we don't have access to".
    if (
        host !== 'github.com' &&
        host !== 'www.github.com' &&
        /\/pull\/\d+/.test(path)
    ) {
        return 'GitHub Enterprise';
    }

    return null;
}
