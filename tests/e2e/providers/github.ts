import type {
    ChangedFile,
    OpenPRArgs,
    OpenPRFromBranchesArgs,
    OpenedPR,
    ProviderName,
    ProviderRepoRef,
    ReviewSignal,
    WebhookInfo,
} from '../lib/types.js';
import { randomUUID } from 'node:crypto';
import type { Target } from '../lib/types.js';
import {
    BaseProvider,
    nowIso,
    pollUntil,
    requireEnv,
    resolveTargetRepo,
} from './base.js';
import { ensureOk, http } from '../lib/http.js';
import { prepareBranch } from '../lib/git.js';
import { logger } from '../lib/log.js';

const log = logger('provider:github');

// Map a Kody license-block notification body to a discriminator the
// scenario layer can assert on. Loose keyword match so we can tell
// "trial expired" apart from "BYOK not yet configured" without
// committing to exact copy that may change.
function classifyLicenseNotice(
    body: string,
): 'trial-ended' | 'byok-required' | 'no-license' | 'other' {
    const b = body.toLowerCase();
    if (/trial.*(ended|expired|over)/.test(b)) return 'trial-ended';
    if (/byok|own (api )?key|api[ -]?key/.test(b)) return 'byok-required';
    if (/(no|invalid).*license|activate.*plan|subscribe/.test(b))
        return 'no-license';
    return 'other';
}

/**
 * Classify a Kody comment on a PR. Hoisted and exported because it has
 * misread comments twice: once ranking an incidental status above a real
 * one, and once reading a security finding that mentions BYOK as a BYOK
 * license notice (cloud run 31616209955).
 */
export function classifyKodyComment(
    body: string,
): 'started' | 'license-block' | 'review' {
    if (!body.includes('<!-- kody-codereview')) return 'review';
    if (body.includes('kody-codereview-completed'))
        return 'review';
    // A severity badge means this is a FINDING, whatever words
    // it happens to contain. License notices never carry one.
    //
    // Without this, a review finding that mentions BYOK is read
    // as a BYOK license notice -- and on THIS codebase that is
    // routine: cloud run 31616209955 failed
    // license-attribution x community-byok on a genuine
    // Security/critical finding about /stats exposing an API
    // key. The keyword match below cannot tell "Kody is telling
    // you to configure a key" from "Kody found a key problem in
    // your code", so the badge has to decide first.
    if (/severity_level-/.test(body)) return 'review';
    // Trial / BYOK / plan-activation prompts. Stable
    // markers: the "Your trial has ended" and "activate
    // your plan" / "BYOK" wording. Loose match so minor
    // copy edits don't silently flip the classification.
    if (
        /trial.*ended|trial.*expired|byok|activate.*plan|talk.*to.*our.*founders/i.test(
            body,
        )
    ) {
        return 'license-block';
    }
    return 'started';
}

export class GitHubProvider extends BaseProvider {
    readonly name: ProviderName = 'github';
    readonly integrationType = 'GITHUB';
    readonly webhookPath = '/github/webhook';

    // Not readonly: refreshInstallationTokenIfNeeded() swaps in a re-minted
    // GitHub App installation token when a long poll outlives the ~1h expiry.
    protected token: string;
    protected readonly repoFullName: string;
    protected readonly apiBase = 'https://api.github.com';
    protected readonly existingPrNumber?: number;

    constructor(opts?: {
        repoOverride?: string;
        target?: Target;
        tokenOverride?: string;
    }) {
        super();
        // tokenOverride is the round-robin token the matrix runner assigns
        // from the bot-account pool (see lib/github-token-pool.ts). Falls back
        // to the single GH_TEST_TOKEN when no pool is configured.
        this.token = opts?.tokenOverride || requireEnv('GH_TEST_TOKEN');
        // Subclasses (notably GitHubAppProvider) need to target a
        // DIFFERENT repo than the PAT-driven default — the GitHub App
        // is installed scope-limited to that other repo, so any PR we
        // open against GH_TEST_REPO would never reach the App's
        // webhook. Pass repoOverride to redirect this provider's
        // entire surface (clone URL, /repos/<owner>/<repo>/*, webhook
        // listing) to the App-bound repo.
        this.repoFullName =
            opts?.repoOverride ??
            resolveTargetRepo('GH_TEST_REPO', opts?.target ?? 'self-hosted');
        const existing = process.env.GH_TEST_PR_NUMBER;
        if (existing) this.existingPrNumber = Number(existing);
    }

    private headers(): Record<string, string> {
        return {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    // Headers for writes that establish AUTHORSHIP of a product-visible
    // event (creating a PR, posting a trigger comment). When the harness
    // runs on a GitHub App installation token (cloud cells, for quota), the
    // author of those events becomes the App's `[bot]` account — and the
    // product correctly skips reviews for bot authors ("User is ignored,
    // skipping automation"), which silently zeroed the whole cloud matrix
    // since the App secrets landed. Route authorship writes through the
    // durable PAT (a human-typed account) and keep every read/poll on the
    // App token's own quota. On PAT-only runs this is identical to
    // headers().
    private authorHeaders(): Record<string, string> {
        const pat = process.env.GH_TEST_TOKEN;
        const token =
            this.token.startsWith('ghs_') && pat && !pat.startsWith('ghs_')
                ? pat
                : this.token;
        return {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
    }

    private cloneUrl(): string {
        return `https://x-access-token:${this.token}@github.com/${this.repoFullName}.git`;
    }

    async repoRef(): Promise<ProviderRepoRef> {
        const resp = await http<{
            id: number;
            full_name: string;
            name: string;
        }>(`${this.apiBase}/repos/${this.repoFullName}`, {
            headers: this.headers(),
        });
        ensureOk(resp, 'github:repoRef');
        return {
            id: resp.body.id,
            full_name: resp.body.full_name,
            name: resp.body.name,
        };
    }

    async createWebhook(webhookUrl: string): Promise<{ id: string }> {
        const resp = await http<{ id: number }>(
            `${this.apiBase}/repos/${this.repoFullName}/hooks`,
            {
                method: 'POST',
                headers: this.headers(),
                body: {
                    name: 'web',
                    active: true,
                    events: [
                        'pull_request',
                        'push',
                        'issue_comment',
                        'pull_request_review',
                        'pull_request_review_comment',
                    ],
                    config: {
                        url: webhookUrl,
                        content_type: 'json',
                        insecure_ssl: '0',
                    },
                },
            },
        );
        ensureOk(resp, 'github:createWebhook');
        return { id: String(resp.body.id) };
    }

    async deleteWebhook(id: string): Promise<void> {
        await http(`${this.apiBase}/repos/${this.repoFullName}/hooks/${id}`, {
            method: 'DELETE',
            headers: this.headers(),
        });
    }

    async listWebhooks(): Promise<WebhookInfo[]> {
        const resp = await http<
            Array<{
                id: number;
                active: boolean;
                events: string[];
                config?: { url?: string };
            }>
        >(`${this.apiBase}/repos/${this.repoFullName}/hooks?per_page=100`, {
            headers: this.headers(),
        });
        ensureOk(resp, 'github:listWebhooks');
        return (resp.body ?? []).map((h) => ({
            id: String(h.id),
            url: h.config?.url ?? '',
            active: Boolean(h.active),
            events: h.events ?? [],
        }));
    }

    async openPR(args: OpenPRArgs): Promise<OpenedPR> {
        const prepared = await prepareBranch({
            cloneUrl: this.cloneUrl(),
            branch: args.branch,
            files: args.fixtureFiles,
            deleteFiles: args.deleteFiles,
            commitMessage: args.title,
            baseBranch: args.baseBranch,
        });
        try {
            const resp = await http<{ number: number; html_url: string }>(
                `${this.apiBase}/repos/${this.repoFullName}/pulls`,
                {
                    method: 'POST',
                    headers: this.authorHeaders(),
                    body: {
                        title: args.title,
                        body: args.body,
                        head: args.branch,
                        base: prepared.baseBranch,
                    },
                },
            );
            ensureOk(resp, 'github:openPR');
            return {
                number: resp.body.number,
                url: resp.body.html_url,
                branch: args.branch,
                baseBranch: prepared.baseBranch,
            };
        } finally {
            prepared.cleanup();
        }
    }

    async openPRFromBranches(args: OpenPRFromBranchesArgs): Promise<OpenedPR> {
        // GitHub's git data endpoints (create-commit / create-ref) intermittently
        // return HTTP 500 under no fault of ours. http() only retries transport
        // failures, not 5xx statuses, so a single hiccup would silently cost us
        // a benchmark review. Retry the whole sequence on 5xx — each attempt
        // mints a fresh uid/branch, so a half-applied ref from a "500 but it
        // actually worked" never collides (422) on the next try.
        let lastErr: unknown;
        for (let attempt = 0; attempt < 4; attempt++) {
            try {
                return await this.openPRFromBranchesOnce(args);
            } catch (err) {
                lastErr = err;
                if (
                    !/HTTP 5\d\d/.test((err as Error).message) ||
                    attempt === 3
                ) {
                    throw err;
                }
                await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
            }
        }
        throw lastErr;
    }

    private async openPRFromBranchesOnce(
        args: OpenPRFromBranchesArgs,
    ): Promise<OpenedPR> {
        // Open the PR from a UNIQUE throwaway branch carrying a fresh empty
        // commit on top of the fixture tip — never from the shared fixture
        // branch. GitHub caps a repo at 100 PRs sharing a head_sha, so opening
        // every PR off the fixture tip burns the repo out (HTTP 422). An empty
        // commit (same tree, parent = fixture tip) gives each PR a UNIQUE
        // head_sha with an IDENTICAL diff vs base, and a unique branch name
        // sidesteps the "one open PR per head→base" limit. The fixture branch
        // is never modified; closePR deletes the throwaway.
        const tip = await http<{ object: { sha: string } }>(
            `${this.apiBase}/repos/${this.repoFullName}/git/ref/heads/${args.head}`,
            { headers: this.headers() },
        );
        ensureOk(tip, 'github:openPRFromBranches:resolveHead');
        const headSha = tip.body.object.sha;
        const commitInfo = await http<{ tree: { sha: string } }>(
            `${this.apiBase}/repos/${this.repoFullName}/git/commits/${headSha}`,
            { headers: this.headers() },
        );
        ensureOk(commitInfo, 'github:openPRFromBranches:resolveTree');

        const uid = randomUUID().slice(0, 8);
        const throwaway = `e2e/${args.head.replace(/[^a-zA-Z0-9._-]+/g, '-')}-${uid}`;
        const commit = await http<{ sha: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/git/commits`,
            {
                method: 'POST',
                headers: this.headers(),
                body: {
                    message: `[e2e] throwaway head for ${args.head} (${uid})`,
                    tree: commitInfo.body.tree.sha,
                    parents: [headSha],
                },
            },
        );
        ensureOk(commit, 'github:openPRFromBranches:commit');
        const ref = await http(
            `${this.apiBase}/repos/${this.repoFullName}/git/refs`,
            {
                method: 'POST',
                headers: this.headers(),
                body: {
                    ref: `refs/heads/${throwaway}`,
                    sha: commit.body.sha,
                },
            },
        );
        ensureOk(ref, 'github:openPRFromBranches:ref');

        const resp = await http<{ number: number; html_url: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls`,
            {
                method: 'POST',
                headers: this.authorHeaders(),
                body: {
                    title: args.title,
                    body: args.body,
                    head: throwaway,
                    base: args.base,
                },
            },
        );
        ensureOk(resp, 'github:openPRFromBranches');
        return {
            number: resp.body.number,
            url: resp.body.html_url,
            branch: throwaway,
            baseBranch: args.base,
            keepBranchOnClose: false,
        };
    }

    private async closeOpenPRsBetween(
        head: string,
        base: string,
    ): Promise<void> {
        // GitHub's list-PRs `head` filter expects `owner:branch` form.
        const owner = this.repoFullName.split('/')[0];
        const headRef = `${owner}:${head}`;
        const resp = await http<Array<{ number: number; state: string }>>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls?state=open&head=${encodeURIComponent(headRef)}&base=${encodeURIComponent(base)}&per_page=10`,
            { headers: this.headers() },
        );
        for (const pr of resp.body ?? []) {
            await http(
                `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}`,
                {
                    method: 'PATCH',
                    headers: this.headers(),
                    body: { state: 'closed' },
                },
            );
        }
    }

    async cleanupStaleE2EArtifacts(): Promise<{ closed: number }> {
        // Paginate /pulls?state=open until we've seen them all. The test
        // repo is small (~10s of historical PRs) so a single page of 100
        // is enough in practice; the loop guards against future drift.
        let closed = 0;
        for (let page = 1; page <= 5; page += 1) {
            const resp = await http<
                Array<{ number: number; title: string; head: { ref: string } }>
            >(
                `${this.apiBase}/repos/${this.repoFullName}/pulls?state=open&per_page=100&page=${page}`,
                { headers: this.headers() },
            );
            ensureOk(resp, 'github:cleanupStale:list');
            const batch = resp.body ?? [];
            if (batch.length === 0) break;
            for (const pr of batch) {
                if (!(pr.title ?? '').startsWith('[e2e]')) continue;
                await http(
                    `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}`,
                    {
                        method: 'PATCH',
                        headers: this.headers(),
                        body: { state: 'closed' },
                    },
                );
                closed += 1;
            }
            if (batch.length < 100) break;
        }
        return { closed };
    }

    async closePR(pr: OpenedPR): Promise<void> {
        await http(
            `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}`,
            {
                method: 'PATCH',
                headers: this.headers(),
                body: { state: 'closed' },
            },
        );
        if (pr.keepBranchOnClose) return;
        await http(
            `${this.apiBase}/repos/${this.repoFullName}/git/refs/heads/${pr.branch}`,
            { method: 'DELETE', headers: this.headers() },
        );
    }

    async triggerReviewOnExistingPR(
        prNumber: number,
    ): Promise<{ triggerId: string; sinceIso: string }> {
        const target = prNumber || this.existingPrNumber;
        if (!target)
            throw new Error('github:triggerReview requires GH_TEST_PR_NUMBER');
        const resp = await http<{ id: number; created_at: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/issues/${target}/comments`,
            {
                method: 'POST',
                headers: this.authorHeaders(),
                body: { body: '@kody review' },
            },
        );
        ensureOk(resp, 'github:triggerReview');
        return {
            triggerId: String(resp.body.id),
            sinceIso: resp.body.created_at,
        };
    }

    // GitHub App installation tokens (ghs_) expire after ~1h. The runner
    // mints one per SCENARIO, but a scenario with two 25-min polls plus a
    // retry settle outlives it — observed on the cloud matrix as an opaque
    // HTTP 401 mid-poll after ~50min. githubAppToken() keeps a cache with a
    // 30-min refresh margin, so re-resolving here is free until a re-mint is
    // actually due. PATs (ghp_/github_pat_) never take this path.
    private async refreshInstallationTokenIfNeeded(): Promise<void> {
        if (!this.token.startsWith('ghs_')) return;
        try {
            const { githubAppToken } = await import(
                '../lib/github-app-token.js'
            );
            const fresh = await githubAppToken();
            if (fresh) this.token = fresh;
        } catch {
            // keep the current token — if it is truly expired the next
            // request 401s loudly, which is the pre-existing behaviour
        }
    }

    // Conditional GET with an ETag cache. GitHub serves 304 Not Modified
    // when the resource didn't change since the cached ETag — and 304s DO
    // NOT count against the per-account rate limit. The poll loops below
    // (pollForReview every 10s, waitForPipelineStart every 3s, both for
    // many minutes) are the harness's dominant quota consumers (~200-270
    // requests per scenario); with conditional requests only the polls
    // where something actually changed are billed. Cache is per provider
    // instance (one per cell), keyed by URL.
    private etagCache = new Map<string, { etag: string; body: unknown }>();

    private async conditionalGet<T>(
        url: string,
    ): Promise<{ status: number; body: T; raw: string }> {
        const cached = this.etagCache.get(url);
        const resp = await http<T>(url, {
            headers: {
                ...this.headers(),
                ...(cached ? { 'If-None-Match': cached.etag } : {}),
            },
        });
        if (resp.status === 304 && cached) {
            return { status: 200, body: cached.body as T, raw: '' };
        }
        const etag = resp.headers.get('etag');
        if (resp.status === 200 && etag) {
            this.etagCache.set(url, { etag, body: resp.body });
        }
        return resp;
    }

    // GitHub list endpoints return a JSON *error envelope* ({message,
    // documentation_url}) instead of an array when the request is rejected
    // — most commonly the per-account primary/secondary rate limit (HTTP
    // 403/429). Downstream code iterates these responses, so the raw
    // symptom is an opaque `items is not iterable` FAIL that the runner
    // can't classify (observed gating release run 28888685303 on
    // license-attribution). Name the failure at the source instead: a
    // rate-limit envelope becomes an explicit "rate limit exceeded" error
    // (which isGithubRateLimit maps to a loud non-gating SKIP), anything
    // else keeps the status + body for diagnosis.
    private listOrThrow<T>(
        resp: { status: number; body: T[]; raw: string },
        label: string,
    ): T[] {
        if (Array.isArray(resp.body)) return resp.body;
        // 2xx with an empty body (no JSON to parse) — treat as an empty
        // list rather than an envelope.
        if (
            resp.status >= 200 &&
            resp.status < 300 &&
            (resp.raw ?? '').trim() === ''
        ) {
            return [];
        }
        const raw = (resp.raw ?? '').slice(0, 300);
        if (/rate limit|abuse/i.test(raw)) {
            throw new Error(
                `${label}: GitHub API rate limit exceeded (HTTP ${resp.status}): ${raw}`,
            );
        }
        throw new Error(
            `${label}: expected an array from GitHub, got HTTP ${resp.status}: ${raw}`,
        );
    }

    async pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal> {
        const since = encodeURIComponent(opts.sinceIso);
        const result = await pollUntil(
            async () => {
                await this.refreshInstallationTokenIfNeeded();
                const [reviewComments, issueComments, reviews] =
                    await Promise.all([
                        this.conditionalGet<
                            {
                                id: number;
                                body: string;
                                path?: string;
                                line?: number | null;
                                side?: string;
                                start_line?: number | null;
                            }[]
                        >(
                            `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/comments?since=${since}`,
                        ),
                        this.conditionalGet<{ id: number; body: string }[]>(
                            `${this.apiBase}/repos/${this.repoFullName}/issues/${pr.number}/comments?since=${since}`,
                        ),
                        this.conditionalGet<
                            {
                                submitted_at?: string;
                                created_at?: string;
                                body?: string;
                            }[]
                        >(
                            `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/reviews`,
                        ),
                    ]);
                // Kody posts three distinct comment shapes that all carry
                // the `<!-- kody-codereview -->` discriminator:
                //
                //   1. "Code Review Started!" placeholder — no findings
                //      yet. Pure status, drop.
                //   2. "Your trial has ended! Activate your plan…" OR
                //      "Set up your BYOK key…" — license/entitlement
                //      gate fired and Kody is telling the user why no
                //      review is coming. NOT a real review, but a
                //      meaningful UX signal we want to surface as
                //      `licenseBlockedNotice` (not as reviewComments).
                //   3. Real review output — either
                //      `<!-- kody-codereview-completed-… -->` (Complete
                //      summary with "Kody Review Complete" / "Kody
                //      Guide") or individual finding comments with the
                //      docs.kodus.io footer. Keep as a review signal.
                const classify = classifyKodyComment;
                const filterNonTrigger = <
                    T extends { id: number; body: string },
                >(
                    items: T[],
                ): { reviews: T[]; licenseNotice?: T } => {
                    const reviews: T[] = [];
                    let licenseNotice: T | undefined;
                    for (const c of items) {
                        if (String(c.id) === opts.triggerId) continue;
                        const body = c.body ?? '';
                        if (body.toLowerCase().startsWith('@kody')) continue;
                        const kind = classify(body);
                        if (kind === 'started') continue;
                        if (kind === 'license-block') {
                            licenseNotice ??= c;
                            continue;
                        }
                        reviews.push(c);
                    }
                    return { reviews, licenseNotice };
                };
                const rcRes = filterNonTrigger(
                    this.listOrThrow(reviewComments, 'github:pollForReview:reviewComments'),
                );
                const icRes = filterNonTrigger(
                    this.listOrThrow(issueComments, 'github:pollForReview:issueComments'),
                );
                const reviewsList = this.listOrThrow(
                    reviews,
                    'github:pollForReview:reviews',
                ).filter((r) => {
                    const ts = r.submitted_at ?? r.created_at ?? '';
                    if (ts <= opts.sinceIso) return false;
                    const body = r.body ?? '';
                    if (body.toLowerCase().startsWith('@kody')) return false;
                    return classify(body) === 'review';
                });
                // Surface any license-block notice we found via comments,
                // even when no real review fired. Lets the scenario layer
                // assert on "gate blocked AND Kody notified" instead of
                // bare silence.
                const licenseNotice =
                    rcRes.licenseNotice?.body ??
                    icRes.licenseNotice?.body ??
                    undefined;
                if (
                    rcRes.reviews.length ||
                    icRes.reviews.length ||
                    reviewsList.length
                ) {
                    const sample =
                        rcRes.reviews[0]?.body ??
                        icRes.reviews[0]?.body ??
                        reviewsList[0]?.body ??
                        '';
                    // Anchors of the inline findings, for the placement
                    // assertion (lib/diff-position.ts). Only comments with a
                    // `path` are inline; the rest are PR-level.
                    const inlineComments = rcRes.reviews
                        .filter((c) => typeof c.path === 'string')
                        .map((c) => ({
                            path: c.path as string,
                            ...(typeof c.line === 'number'
                                ? { line: c.line }
                                : {}),
                            ...(c.side ? { side: c.side } : {}),
                            ...(typeof c.start_line === 'number'
                                ? { startLine: c.start_line }
                                : {}),
                        }));
                    return {
                        reviewComments: rcRes.reviews.length,
                        issueComments: icRes.reviews.length,
                        reviews: reviewsList.length,
                        sample: sample.slice(0, 240),
                        ...(inlineComments.length ? { inlineComments } : {}),
                        ...(licenseNotice
                            ? {
                                  licenseBlockedNotice: {
                                      message: licenseNotice.slice(0, 240),
                                      kind: classifyLicenseNotice(
                                          licenseNotice,
                                      ),
                                  },
                              }
                            : {}),
                    };
                }
                if (licenseNotice) {
                    return {
                        reviewComments: 0,
                        issueComments: 0,
                        reviews: 0,
                        licenseBlockedNotice: {
                            message: licenseNotice.slice(0, 240),
                            kind: classifyLicenseNotice(licenseNotice),
                        },
                    };
                }
                return null;
            },
            { timeoutSec: opts.timeoutSec ?? 600, intervalSec: 10 },
        );
        if (!result) {
            // Return-empty rather than throw — pollForReview is also used
            // for sanity snapshots where empty IS the expected outcome
            // (e.g. command-review.ts:108 polls with timeoutSec=1 to
            // confirm auto-review did NOT fire on a PR whose
            // automatedReviewActive is disabled). The caller decides
            // whether 0 findings is a failure; logging [err] from the
            // helper was misclassifying those expected zero-result
            // snapshots as failures and confusing the matrix log.
            // Caller-side assertions (ctx.assert in the scenario) are
            // the right place to surface real timeouts.
            return { reviewComments: 0, issueComments: 0, reviews: 0 };
        }
        return result;
    }

    // Phase-A signal for code-review-basic: returns as soon as ANY
    // comment with the `<!-- kody-codereview` discriminator shows up
    // on the PR. Includes the "Code Review Started!" placeholder
    // that pollForReview drops — by design, since this phase only
    // proves the worker dequeued the PR and Kody got far enough to
    // post a heartbeat. Issue comments only (placeholder lives
    // there); review-comments and reviews lag behind by definition.
    async waitForPipelineStart(
        pr: { number: number },
        opts: { sinceIso: string; timeoutSec: number },
    ): Promise<{ startedAt: string; sample: string }> {
        const since = encodeURIComponent(opts.sinceIso);
        const result = await pollUntil<{ startedAt: string; sample: string }>(
            async () => {
                await this.refreshInstallationTokenIfNeeded();
                const resp = await this.conditionalGet<
                    { id: number; body: string; created_at: string }[]
                >(
                    `${this.apiBase}/repos/${this.repoFullName}/issues/${pr.number}/comments?since=${since}`,
                );
                const hit = this.listOrThrow(
                    resp,
                    'github:waitForPipelineStart',
                ).find((c) => (c.body ?? '').includes('<!-- kody-codereview'));
                if (!hit) return null;
                return {
                    startedAt: hit.created_at,
                    sample: (hit.body ?? '').slice(0, 240),
                };
            },
            { timeoutSec: opts.timeoutSec, intervalSec: 3 },
        );
        if (!result) {
            throw new Error(
                `[provider:github] No kody-codereview status comment on PR #${pr.number} within ${opts.timeoutSec}s — review pipeline likely never started (check droplet worker logs and the webhook delivery list).`,
            );
        }
        return result;
    }

    async postComment(prNumber: number, body: string): Promise<{ id: string }> {
        const resp = await http<{ id: number }>(
            `${this.apiBase}/repos/${this.repoFullName}/issues/${prNumber}/comments`,
            {
                method: 'POST',
                headers: this.authorHeaders(),
                body: { body },
            },
        );
        ensureOk(resp, 'github:postComment');
        return { id: String(resp.body.id) };
    }

    // Posts an issue comment AS A DIFFERENT GitHub identity (token override).
    // The conversation scenario needs this: Kody ignores any comment whose
    // author login contains "kody"/"kodus" (isKodyComment → treats it as its
    // own), and the e2e bots are all `kodus-e2e-bot-N`. So the `@kody` mention
    // must come from a non-Kody account.
    async postCommentAs(
        prNumber: number,
        body: string,
        token: string,
    ): Promise<{ id: string }> {
        const resp = await http<{ id: number }>(
            `${this.apiBase}/repos/${this.repoFullName}/issues/${prNumber}/comments`,
            {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github+json',
                    'X-GitHub-Api-Version': '2022-11-28',
                },
                body: { body },
            },
        );
        ensureOk(resp, 'github:postCommentAs');
        return { id: String(resp.body.id) };
    }

    // Posts an INLINE review comment as a different identity (token override).
    // Kody's ConversationAgent only resolves the mention when it's a review
    // (inline) comment — `getPullRequestReviewComment` lists review comments
    // only, so an issue comment is never found and the flow silently returns.
    // We attach it at file level (subject_type=file) so no valid diff line is
    // needed. Returns the new review comment id.
    async postReviewCommentAs(
        prNumber: number,
        body: string,
        token: string,
    ): Promise<{ id: string }> {
        const h = {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
        };
        const pr = await http<{ head: { sha: string } }>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls/${prNumber}`,
            { headers: h },
        );
        ensureOk(pr, 'github:postReviewCommentAs:getPR');
        const files = await http<{ filename: string }[]>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls/${prNumber}/files`,
            { headers: h },
        );
        ensureOk(files, 'github:postReviewCommentAs:getFiles');
        const path = files.body?.[0]?.filename;
        const resp = await http<{ id: number }>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls/${prNumber}/comments`,
            {
                method: 'POST',
                headers: h,
                body: {
                    body,
                    commit_id: pr.body.head.sha,
                    path,
                    subject_type: 'file',
                },
            },
        );
        ensureOk(resp, 'github:postReviewCommentAs');
        return { id: String(resp.body.id) };
    }

    // Polls for Kody's conversational reply to an `@kody <question>` review
    // via createReplyForReviewComment, so the answer lands in the PR's REVIEW
    // comments. Returns the first NEW review comment that is neither ours
    // (`@kody …`) nor a code-review finding (those carry the
    // `<!-- kody-codereview` marker). null at timeout.
    async pollForKodyReply(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<{ id: string; body: string } | null> {
        const since = encodeURIComponent(opts.sinceIso);
        return pollUntil(
            async () => {
                const comments = await http<
                    { id: number; body: string; created_at?: string }[]
                >(
                    `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/comments?since=${since}`,
                    { headers: this.headers() },
                );
                for (const c of comments.body ?? []) {
                    if (String(c.id) === opts.triggerId) continue;
                    const body = c.body ?? '';
                    if (body.toLowerCase().startsWith('@kody')) continue;
                    // Skip code-review status/findings — conversation replies
                    // don't carry the review discriminator.
                    if (body.includes('<!-- kody-codereview')) continue;
                    if (!body.trim()) continue;
                    return { id: String(c.id), body: body.slice(0, 600) };
                }
                return null;
            },
            { timeoutSec: opts.timeoutSec ?? 300, intervalSec: 10 },
        );
    }

    // Merges a PR (kody-issues generation and rule-file sync fire off the
    // closed/MERGED PR webhook). GitHub returns 405 for a while right
    // after PR creation (mergeability is computed asynchronously), so
    // retry before concluding the PR is genuinely unmergeable. Only after
    // the retries fall back to a plain close — and log loudly, because
    // scenarios that REQUIRE a merged event (kody-rules-file-sync,
    // rule-file-detection) will otherwise fail downstream with a
    // confusing "sync never happened".
    async mergePR(pr: OpenedPR): Promise<void> {
        let lastStatus = 0;
        for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) {
                await new Promise((r) => setTimeout(r, 5_000));
            }
            const resp = await http(
                `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/merge`,
                {
                    method: 'PUT',
                    headers: this.headers(),
                    body: { merge_method: 'squash' },
                },
            );
            if (resp.status >= 200 && resp.status < 300) {
                return;
            }
            lastStatus = resp.status;
            // 405 = not mergeable *yet* (async mergeability check) or
            // blocked; 409 = head changed. Both are worth retrying.
            if (resp.status !== 405 && resp.status !== 409) {
                break;
            }
            log.info(
                `github:mergePR PR#${pr.number} HTTP ${resp.status} (attempt ${attempt + 1}/6) — retrying`,
            );
        }
        log.warn(
            `github:mergePR PR#${pr.number} not mergeable after retries (HTTP ${lastStatus}) — falling back to close (NOT a merged event)`,
        );
        await this.closePR(pr);
    }

    // Return type widened from the literal "token" to the full union so
    // GitHubAppProvider (which extends this class) can override and
    // return "oauth" without TS complaining about variance — the App
    // path identifies the integration by installationId, not a PAT.
    authMode(): 'token' | 'oauth' | 'app-password' {
        return 'token';
    }

    // The credential Kodus STORES on the integration (auth-integration
    // payload) — the product uses it for its own GitHub calls for the
    // tenant's lifetime, so it must be DURABLE. `this.token` may be a
    // GitHub App installation token (runner prefers it for cloud cells'
    // harness-side quota), which expires in ~1h — storing that would kill
    // the product's credential mid-run. Always hand the backend the
    // long-lived base PAT; the assigned token keeps serving the harness's
    // own API calls (clone, PRs, polling).
    //
    // Prefer a DEDICATED integration account (GH_INTEGRATION_TOKEN) so the
    // product's own GitHub calls (read diff/files, post comments, resolve
    // threads) draw on a separate 5,000 req/hr budget from the harness
    // driver pool. Without it, the product and the harness both hammer
    // GH_TEST_TOKEN — that single account's quota was tripping mid-cell and
    // cascading scenarios into rate-limit SKIPs. Falls back to GH_TEST_TOKEN
    // when the dedicated secret is unset, so this is a no-op until wired.
    authToken(): string {
        // Installation tokens are prefixed ghs_ and die in ~1h. NOTHING with
        // that prefix may become the stored integration credential — not the
        // runner-assigned token, and not a misconfigured secret either (a
        // silent 1h credential in CI config would fail mid-run).
        const durable =
            process.env.GH_INTEGRATION_TOKEN || process.env.GH_TEST_TOKEN;
        if (durable) {
            if (durable.startsWith('ghs_')) {
                throw new Error(
                    'The GitHub integration credential (GH_INTEGRATION_TOKEN / GH_TEST_TOKEN) is a GitHub App installation token (ghs_) — it must be a durable PAT',
                );
            }
            return durable;
        }
        if (this.token.startsWith('ghs_')) {
            throw new Error(
                'GH_TEST_TOKEN (durable PAT) is required when the harness runs on a GitHub App installation token — the integration credential must not expire',
            );
        }
        return this.token;
    }

    // Identity, not traffic — and the two need DIFFERENT credentials.
    //
    // `GET /user` is the one call a GitHub App installation token cannot
    // make (it has no user identity), which is why the runner only handed
    // App tokens to cloud cells: self-hosted needs this id for seat
    // assignment, so it stayed on the abuse-flagged PAT for ALL its GitHub
    // traffic, quota limit included.
    //
    // Resolving the id from the durable PAT while everything else keeps
    // using `this.token` lifts that restriction: the heavy traffic (clone,
    // PRs, comment polling) can ride the App's own 5000/h budget on
    // self-hosted too. The PAT spends exactly one request per cell here.
    // Files + patches for the PR under test. Used by the review-placement
    // assertion to decide whether a comment's line is one this PR added.
    async listChangedFiles(pr: { number: number }): Promise<ChangedFile[]> {
        const resp = await http<{ filename: string; patch?: string }[]>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/files?per_page=100`,
            { headers: this.headers(), timeoutMs: 30_000 },
        );
        ensureOk(resp, 'github:listChangedFiles');
        const files = this.listOrThrow(resp, 'github:listChangedFiles');
        return files.map((f) => ({ path: f.filename, patch: f.patch }));
    }

    async currentUserId(): Promise<string> {
        // authorHeaders() already resolves to the durable PAT whenever the
        // assigned token is an App installation token — exactly what this
        // call needs, since installation tokens have no user identity.
        const resp = await http<{ id: number; login: string }>(
            `${this.apiBase}/user`,
            { headers: this.authorHeaders(), timeoutMs: 15_000 },
        );
        ensureOk(resp, 'github:currentUserId');
        return String(resp.body.id);
    }

    licenseGitTool(): string {
        return 'github';
    }

    async pollForLicenseBlock(
        pr: { number: number },
        opts: { sinceIso: string; timeoutSec?: number },
    ): Promise<boolean> {
        // USER_NOT_LICENSED → validate-prerequisites adds a 👎 reaction on the
        // PR via addReactionToPR. GitHub stores 👎 as the `-1` reaction
        // content. The 🚀 start reaction is removed when a review actually
        // completes, so a surviving `-1` unambiguously means the seat gate
        // blocked the review (vs. a review that ran).
        const found = await pollUntil<boolean>(
            async () => {
                const resp = await http<{ content: string }[]>(
                    `${this.apiBase}/repos/${this.repoFullName}/issues/${pr.number}/reactions?per_page=100`,
                    { headers: this.headers() },
                );
                if (resp.status < 200 || resp.status >= 300) return null;
                return (resp.body ?? []).some((r) => r.content === '-1')
                    ? true
                    : null;
            },
            { intervalSec: 5, timeoutSec: opts.timeoutSec ?? 120 },
        );
        return found === true;
    }
}

export function _touch() {
    return nowIso();
}
