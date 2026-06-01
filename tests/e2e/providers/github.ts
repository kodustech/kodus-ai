import type {
    OpenPRArgs,
    OpenPRFromBranchesArgs,
    OpenedPR,
    ProviderName,
    ProviderRepoRef,
    ReviewSignal,
    WebhookInfo,
} from "../lib/types.js";
import { randomUUID } from "node:crypto";
import type { Target } from "../lib/types.js";
import {
    BaseProvider,
    nowIso,
    pollUntil,
    requireEnv,
    resolveTargetRepo,
} from "./base.js";
import { ensureOk, http } from "../lib/http.js";
import { prepareBranch } from "../lib/git.js";
import { logger } from "../lib/log.js";

const log = logger("provider:github");

// Map a Kody license-block notification body to a discriminator the
// scenario layer can assert on. Loose keyword match so we can tell
// "trial expired" apart from "BYOK not yet configured" without
// committing to exact copy that may change.
function classifyLicenseNotice(
    body: string,
): "trial-ended" | "byok-required" | "no-license" | "other" {
    const b = body.toLowerCase();
    if (/trial.*(ended|expired|over)/.test(b)) return "trial-ended";
    if (/byok|own (api )?key|api[ -]?key/.test(b)) return "byok-required";
    if (/(no|invalid).*license|activate.*plan|subscribe/.test(b))
        return "no-license";
    return "other";
}

export class GitHubProvider extends BaseProvider {
    readonly name: ProviderName = "github";
    readonly integrationType = "GITHUB";
    readonly webhookPath = "/github/webhook";

    protected readonly token: string;
    protected readonly repoFullName: string;
    protected readonly apiBase = "https://api.github.com";
    protected readonly existingPrNumber?: number;

    constructor(opts?: { repoOverride?: string; target?: Target }) {
        super();
        this.token = requireEnv("GH_TEST_TOKEN");
        // Subclasses (notably GitHubAppProvider) need to target a
        // DIFFERENT repo than the PAT-driven default — the GitHub App
        // is installed scope-limited to that other repo, so any PR we
        // open against GH_TEST_REPO would never reach the App's
        // webhook. Pass repoOverride to redirect this provider's
        // entire surface (clone URL, /repos/<owner>/<repo>/*, webhook
        // listing) to the App-bound repo.
        this.repoFullName =
            opts?.repoOverride ??
            resolveTargetRepo("GH_TEST_REPO", opts?.target ?? "self-hosted");
        const existing = process.env.GH_TEST_PR_NUMBER;
        if (existing) this.existingPrNumber = Number(existing);
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        };
    }

    private cloneUrl(): string {
        return `https://x-access-token:${this.token}@github.com/${this.repoFullName}.git`;
    }

    async repoRef(): Promise<ProviderRepoRef> {
        const resp = await http<{ id: number; full_name: string; name: string }>(
            `${this.apiBase}/repos/${this.repoFullName}`,
            { headers: this.headers() },
        );
        ensureOk(resp, "github:repoRef");
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
                method: "POST",
                headers: this.headers(),
                body: {
                    name: "web",
                    active: true,
                    events: [
                        "pull_request",
                        "push",
                        "issue_comment",
                        "pull_request_review",
                        "pull_request_review_comment",
                    ],
                    config: {
                        url: webhookUrl,
                        content_type: "json",
                        insecure_ssl: "0",
                    },
                },
            },
        );
        ensureOk(resp, "github:createWebhook");
        return { id: String(resp.body.id) };
    }

    async deleteWebhook(id: string): Promise<void> {
        await http(
            `${this.apiBase}/repos/${this.repoFullName}/hooks/${id}`,
            { method: "DELETE", headers: this.headers() },
        );
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
        ensureOk(resp, "github:listWebhooks");
        return (resp.body ?? []).map((h) => ({
            id: String(h.id),
            url: h.config?.url ?? "",
            active: Boolean(h.active),
            events: h.events ?? [],
        }));
    }

    async openPR(args: OpenPRArgs): Promise<OpenedPR> {
        const prepared = await prepareBranch({
            cloneUrl: this.cloneUrl(),
            branch: args.branch,
            files: args.fixtureFiles,
            commitMessage: args.title,
            baseBranch: args.baseBranch,
        });
        try {
            const resp = await http<{ number: number; html_url: string }>(
                `${this.apiBase}/repos/${this.repoFullName}/pulls`,
                {
                    method: "POST",
                    headers: this.headers(),
                    body: {
                        title: args.title,
                        body: args.body,
                        head: args.branch,
                        base: prepared.baseBranch,
                    },
                },
            );
            ensureOk(resp, "github:openPR");
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
                if (!/HTTP 5\d\d/.test((err as Error).message) || attempt === 3) {
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
        ensureOk(tip, "github:openPRFromBranches:resolveHead");
        const headSha = tip.body.object.sha;
        const commitInfo = await http<{ tree: { sha: string } }>(
            `${this.apiBase}/repos/${this.repoFullName}/git/commits/${headSha}`,
            { headers: this.headers() },
        );
        ensureOk(commitInfo, "github:openPRFromBranches:resolveTree");

        const uid = randomUUID().slice(0, 8);
        const throwaway = `e2e/${args.head.replace(/[^a-zA-Z0-9._-]+/g, "-")}-${uid}`;
        const commit = await http<{ sha: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/git/commits`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    message: `[e2e] throwaway head for ${args.head} (${uid})`,
                    tree: commitInfo.body.tree.sha,
                    parents: [headSha],
                },
            },
        );
        ensureOk(commit, "github:openPRFromBranches:commit");
        const ref = await http(
            `${this.apiBase}/repos/${this.repoFullName}/git/refs`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    ref: `refs/heads/${throwaway}`,
                    sha: commit.body.sha,
                },
            },
        );
        ensureOk(ref, "github:openPRFromBranches:ref");

        const resp = await http<{ number: number; html_url: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    title: args.title,
                    body: args.body,
                    head: throwaway,
                    base: args.base,
                },
            },
        );
        ensureOk(resp, "github:openPRFromBranches");
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
        const owner = this.repoFullName.split("/")[0];
        const headRef = `${owner}:${head}`;
        const resp = await http<Array<{ number: number; state: string }>>(
            `${this.apiBase}/repos/${this.repoFullName}/pulls?state=open&head=${encodeURIComponent(headRef)}&base=${encodeURIComponent(base)}&per_page=10`,
            { headers: this.headers() },
        );
        for (const pr of resp.body ?? []) {
            await http(
                `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}`,
                {
                    method: "PATCH",
                    headers: this.headers(),
                    body: { state: "closed" },
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
            const resp = await http<Array<{ number: number; title: string; head: { ref: string } }>>(
                `${this.apiBase}/repos/${this.repoFullName}/pulls?state=open&per_page=100&page=${page}`,
                { headers: this.headers() },
            );
            ensureOk(resp, "github:cleanupStale:list");
            const batch = resp.body ?? [];
            if (batch.length === 0) break;
            for (const pr of batch) {
                if (!(pr.title ?? "").startsWith("[e2e]")) continue;
                await http(
                    `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}`,
                    { method: "PATCH", headers: this.headers(), body: { state: "closed" } },
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
                method: "PATCH",
                headers: this.headers(),
                body: { state: "closed" },
            },
        );
        if (pr.keepBranchOnClose) return;
        await http(
            `${this.apiBase}/repos/${this.repoFullName}/git/refs/heads/${pr.branch}`,
            { method: "DELETE", headers: this.headers() },
        );
    }

    async triggerReviewOnExistingPR(
        prNumber: number,
    ): Promise<{ triggerId: string; sinceIso: string }> {
        const target = prNumber || this.existingPrNumber;
        if (!target) throw new Error("github:triggerReview requires GH_TEST_PR_NUMBER");
        const resp = await http<{ id: number; created_at: string }>(
            `${this.apiBase}/repos/${this.repoFullName}/issues/${target}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { body: "@kody review" },
            },
        );
        ensureOk(resp, "github:triggerReview");
        return {
            triggerId: String(resp.body.id),
            sinceIso: resp.body.created_at,
        };
    }

    async pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal> {
        const since = encodeURIComponent(opts.sinceIso);
        const result = await pollUntil(
            async () => {
                const [reviewComments, issueComments, reviews] = await Promise.all([
                    http<{ id: number; body: string }[]>(
                        `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/comments?since=${since}`,
                        { headers: this.headers() },
                    ),
                    http<{ id: number; body: string }[]>(
                        `${this.apiBase}/repos/${this.repoFullName}/issues/${pr.number}/comments?since=${since}`,
                        { headers: this.headers() },
                    ),
                    http<
                        { submitted_at?: string; created_at?: string; body?: string }[]
                    >(
                        `${this.apiBase}/repos/${this.repoFullName}/pulls/${pr.number}/reviews`,
                        { headers: this.headers() },
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
                const classify = (
                    body: string,
                ): "started" | "license-block" | "review" => {
                    if (!body.includes("<!-- kody-codereview")) return "review";
                    if (body.includes("kody-codereview-completed")) return "review";
                    // Trial / BYOK / plan-activation prompts. Stable
                    // markers: the "Your trial has ended" and "activate
                    // your plan" / "BYOK" wording. Loose match so minor
                    // copy edits don't silently flip the classification.
                    if (
                        /trial.*ended|trial.*expired|byok|activate.*plan|talk.*to.*our.*founders/i.test(
                            body,
                        )
                    ) {
                        return "license-block";
                    }
                    return "started";
                };
                const filterNonTrigger = <T extends { id: number; body: string }>(
                    items: T[],
                ): { reviews: T[]; licenseNotice?: T } => {
                    const reviews: T[] = [];
                    let licenseNotice: T | undefined;
                    for (const c of items) {
                        if (String(c.id) === opts.triggerId) continue;
                        const body = c.body ?? "";
                        if (body.toLowerCase().startsWith("@kody")) continue;
                        const kind = classify(body);
                        if (kind === "started") continue;
                        if (kind === "license-block") {
                            licenseNotice ??= c;
                            continue;
                        }
                        reviews.push(c);
                    }
                    return { reviews, licenseNotice };
                };
                const rcRes = filterNonTrigger(reviewComments.body ?? []);
                const icRes = filterNonTrigger(issueComments.body ?? []);
                const reviewsList = (reviews.body ?? []).filter((r) => {
                    const ts = r.submitted_at ?? r.created_at ?? "";
                    if (ts <= opts.sinceIso) return false;
                    const body = r.body ?? "";
                    if (body.toLowerCase().startsWith("@kody")) return false;
                    return classify(body) === "review";
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
                        "";
                    return {
                        reviewComments: rcRes.reviews.length,
                        issueComments: icRes.reviews.length,
                        reviews: reviewsList.length,
                        sample: sample.slice(0, 240),
                        ...(licenseNotice
                            ? {
                                  licenseBlockedNotice: {
                                      message: licenseNotice.slice(0, 240),
                                      kind: classifyLicenseNotice(licenseNotice),
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
                const resp = await http<
                    { id: number; body: string; created_at: string }[]
                >(
                    `${this.apiBase}/repos/${this.repoFullName}/issues/${pr.number}/comments?since=${since}`,
                    { headers: this.headers() },
                );
                const hit = (resp.body ?? []).find((c) =>
                    (c.body ?? "").includes("<!-- kody-codereview"),
                );
                if (!hit) return null;
                return {
                    startedAt: hit.created_at,
                    sample: (hit.body ?? "").slice(0, 240),
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

    async postComment(
        prNumber: number,
        body: string,
    ): Promise<{ id: string }> {
        const resp = await http<{ id: number }>(
            `${this.apiBase}/repos/${this.repoFullName}/issues/${prNumber}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { body },
            },
        );
        ensureOk(resp, "github:postComment");
        return { id: String(resp.body.id) };
    }

    // Return type widened from the literal "token" to the full union so
    // GitHubAppProvider (which extends this class) can override and
    // return "oauth" without TS complaining about variance — the App
    // path identifies the integration by installationId, not a PAT.
    authMode(): "token" | "oauth" | "app-password" {
        return "token";
    }

    authToken(): string {
        return this.token;
    }

    async currentUserId(): Promise<string> {
        const resp = await http<{ id: number; login: string }>(
            `${this.apiBase}/user`,
            { headers: this.headers(), timeoutMs: 15_000 },
        );
        ensureOk(resp, "github:currentUserId");
        return String(resp.body.id);
    }

    licenseGitTool(): string {
        return "github";
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
                return (resp.body ?? []).some((r) => r.content === "-1")
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
