import type { OpenPRFromBranchesArgs } from "../lib/types.js";
import type {
    OpenPRArgs,
    OpenedPR,
    ProviderName,
    ProviderRepoRef,
    ReviewSignal,
    WebhookInfo,
} from "../lib/types.js";
import type { Target } from "../lib/types.js";
import {
    BaseProvider,
    pollUntil,
    requireEnv,
    resolveTargetRepo,
} from "./base.js";
import { ensureOk, http } from "../lib/http.js";
import { prepareBranch } from "../lib/git.js";

interface BitbucketComment {
    id: number;
    content: { raw: string };
    created_on: string;
    user: { uuid: string; display_name: string };
}

export class BitbucketProvider extends BaseProvider {
    readonly name: ProviderName = "bitbucket";
    readonly integrationType = "BITBUCKET";
    readonly webhookPath = "/bitbucket/webhook";

    private readonly user: string;
    private readonly appPassword: string;
    private readonly workspaceSlug: string;
    private readonly apiBase = "https://api.bitbucket.org/2.0";
    private readonly existingPrId?: number;

    constructor(target: Target = "self-hosted") {
        super();
        this.user = requireEnv("BB_TEST_USER");
        this.appPassword = requireEnv("BB_TEST_APP_PASSWORD");
        this.workspaceSlug = resolveTargetRepo("BB_TEST_REPO", target);
        const existing = process.env.BB_TEST_PR_ID;
        if (existing) this.existingPrId = Number(existing);
    }

    authExtraFields(): Record<string, unknown> {
        // Bitbucket's authenticateWithToken requires `username` to pair with
        // the app password — auth is HTTP Basic, not a bearer token. Sending
        // just `token` makes bitbucket-cloud.service.ts authenticate as an
        // empty user, which trips checkRepositoryPermissions with a 401.
        return { username: this.user };
    }

    private basicAuth(): string {
        const raw = `${this.user}:${this.appPassword}`;
        return `Basic ${Buffer.from(raw).toString("base64")}`;
    }

    private headers(): Record<string, string> {
        return {
            Authorization: this.basicAuth(),
            Accept: "application/json",
        };
    }

    private cloneUrl(): string {
        return `https://${this.user}:${this.appPassword}@bitbucket.org/${this.workspaceSlug}.git`;
    }

    async repoRef(): Promise<ProviderRepoRef> {
        const resp = await http<{ uuid: string; full_name: string; name: string }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}`,
            { headers: this.headers() },
        );
        ensureOk(resp, "bitbucket:repoRef");
        return {
            id: resp.body.uuid,
            full_name: resp.body.full_name,
            name: resp.body.name,
        };
    }

    async createWebhook(webhookUrl: string): Promise<{ id: string }> {
        const resp = await http<{ uuid: string }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/hooks`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    description: "Kodus E2E webhook",
                    url: webhookUrl,
                    active: true,
                    events: [
                        "pullrequest:created",
                        "pullrequest:updated",
                        "pullrequest:comment_created",
                        "pullrequest:approved",
                        "repo:push",
                    ],
                },
            },
        );
        ensureOk(resp, "bitbucket:createWebhook");
        return { id: resp.body.uuid };
    }

    async deleteWebhook(id: string): Promise<void> {
        await http(
            `${this.apiBase}/repositories/${this.workspaceSlug}/hooks/${encodeURIComponent(id)}`,
            { method: "DELETE", headers: this.headers() },
        );
    }

    async listWebhooks(): Promise<WebhookInfo[]> {
        const resp = await http<{
            values?: Array<{
                uuid: string;
                url: string;
                active: boolean;
                events: string[];
            }>;
        }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/hooks?pagelen=100`,
            { headers: this.headers() },
        );
        ensureOk(resp, "bitbucket:listWebhooks");
        return (resp.body.values ?? []).map((h) => ({
            id: h.uuid,
            url: h.url ?? "",
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
            const resp = await http<{
                id: number;
                links: { html: { href: string } };
            }>(
                `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests`,
                {
                    method: "POST",
                    headers: this.headers(),
                    body: {
                        title: args.title,
                        description: args.body,
                        source: { branch: { name: args.branch } },
                        destination: { branch: { name: prepared.baseBranch } },
                        close_source_branch: true,
                    },
                },
            );
            ensureOk(resp, "bitbucket:openPR");
            return {
                number: resp.body.id,
                url: resp.body.links.html.href,
                branch: args.branch,
                baseBranch: prepared.baseBranch,
            };
        } finally {
            prepared.cleanup();
        }
    }

    async openPRFromBranches(args: OpenPRFromBranchesArgs): Promise<OpenedPR> {
        // Why we don't POST directly from the fixture branch: observed
        // 2026-05-20 on QA run 3d7866, bitbucket returned a DECLINED
        // PR from 2 days earlier (id=12) in the body of a fresh
        // `POST /pullrequests` request from `fixture/kody-rule-todo-
        // remove-me` → `main`. The scenario then polled that closed
        // PR for a review that would never come and failed after 12
        // min. Couldn't reproduce manually 5 min later. Most likely a
        // bitbucket-cloud quirk where POSTing from a branch whose
        // tip-commit already has a recent PR returns the existing one
        // — github/gitlab/azure don't share this quirk.
        //
        // Fix: create a throwaway branch pointing at the fixture
        // branch's tip commit, open the PR from that throwaway, and
        // delete the throwaway on closePR. Identical diff (same tip
        // commit), but bitbucket can't dedup against a name it has
        // never seen.
        const fixtureRef = await http<{ target: { hash: string } }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/refs/branches/${encodeURIComponent(args.head)}`,
            { headers: this.headers() },
        );
        ensureOk(fixtureRef, "bitbucket:openPRFromBranches/getFixtureRef");
        const fixtureHash = fixtureRef.body.target?.hash;
        if (!fixtureHash) {
            throw new Error(
                `bitbucket:openPRFromBranches: fixture branch ${args.head} has no target.hash`,
            );
        }

        // Throwaway branch name: short, sortable, unique. Bitbucket
        // refs are case-sensitive and accept slashes.
        const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const throwawayBranch = `e2e/${args.head.replace(/[^a-z0-9-]/gi, "-")}-${suffix}`;

        const createRef = await http(
            `${this.apiBase}/repositories/${this.workspaceSlug}/refs/branches`,
            {
                method: "POST",
                headers: this.headers(),
                body: { name: throwawayBranch, target: { hash: fixtureHash } },
            },
        );
        ensureOk(createRef, "bitbucket:openPRFromBranches/createBranch");

        // Race window between bitbucket's `POST /refs/branches` returning
        // 201 and bitbucket's internal indexers (PR-commits API, webhook
        // payload assembly) recognizing the new ref. Observed 2026-05-23:
        // when the throwaway branch is created and a PR is opened against
        // it in the same tick, the webhook fires with a PR whose
        // `pullrequests/{id}/commits` endpoint returns 0 entries — Kodus's
        // ValidateNewCommitsStage then SKIPs the pipeline with
        // "PR has 0 commits", the scenario polls forever, and the test
        // times out at 25min. Confirmed via direct curl that the same
        // endpoint returns the correct commit a few seconds later. Five
        // seconds is enough headroom on every observed run; cheap
        // compared to scenarios that already take 4-25min.
        //
        // Why other providers don't need this: github and gitlab's
        // pull-request endpoints are strongly consistent with their
        // refs/branches creation — they share a single coordinated index
        // path. Bitbucket Cloud's branch-create and PR-commits paths run
        // through different services on Atlassian Edge.
        await new Promise((resolve) => setTimeout(resolve, 5_000));

        const resp = await http<{
            id: number;
            state?: string;
            created_on?: string;
            links: { html: { href: string } };
        }>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests`,
            {
                method: "POST",
                headers: this.headers(),
                body: {
                    title: args.title,
                    description: args.body,
                    source: { branch: { name: throwawayBranch } },
                    destination: { branch: { name: args.base } },
                    // Throwaway branch — closePR deletes it explicitly
                    // (close_source_branch on bitbucket only fires on
                    // merge, not decline, so we can't rely on it).
                    close_source_branch: false,
                },
            },
        );
        ensureOk(resp, "bitbucket:openPRFromBranches");

        // Belt-and-suspenders: keep the freshness check from the
        // earlier defensive landing in case bitbucket ever returns a
        // stale PR even for a throwaway branch (it shouldn't be able
        // to, since the branch name is brand new).
        const createdOn = resp.body.created_on;
        const state = resp.body.state;
        const ageMs = createdOn ? Date.now() - Date.parse(createdOn) : -1;
        const STALE_AGE_MS = 60_000;
        if (
            ageMs > STALE_AGE_MS ||
            (state && state.toUpperCase() !== "OPEN")
        ) {
            throw new Error(
                `bitbucket:openPRFromBranches returned a non-fresh PR even from a throwaway branch ` +
                    `(id=${resp.body.id}, state=${state}, created_on=${createdOn}, ageMs=${ageMs}, ` +
                    `branch=${throwawayBranch}). Unexpected — investigate bitbucket API state.`,
            );
        }

        return {
            number: resp.body.id,
            url: resp.body.links.html.href,
            branch: throwawayBranch,
            baseBranch: args.base,
            // closePR must delete the throwaway branch; without this
            // flag set to false the existing closePR no-ops on the
            // branch deletion and we'd leak refs.
            keepBranchOnClose: false,
        };
    }

    async cleanupStaleE2EArtifacts(): Promise<{ closed: number }> {
        // Bitbucket's `state` filter accepts OPEN; pagination via `?page=`.
        // The Bitbucket SDK banner-spam loop is server-side (issue #1155);
        // here we're talking to the REST API directly so each list call
        // is just one HTTPS round-trip.
        let closed = 0;
        let url: string | null =
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests?state=OPEN&pagelen=50`;
        for (let i = 0; i < 5 && url; i += 1) {
            const resp = await http<{
                values?: Array<{ id: number; title: string }>;
                next?: string;
            }>(url, { headers: this.headers() });
            ensureOk(resp, "bitbucket:cleanupStale:list");
            for (const pr of resp.body.values ?? []) {
                if (!(pr.title ?? "").startsWith("[e2e]")) continue;
                await http(
                    `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${pr.id}/decline`,
                    { method: "POST", headers: this.headers() },
                );
                closed += 1;
            }
            url = resp.body.next ?? null;
        }
        return { closed };
    }

    async closePR(pr: OpenedPR): Promise<void> {
        await http(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${pr.number}/decline`,
            { method: "POST", headers: this.headers() },
        );

        // Throwaway branches created by openPRFromBranches must be
        // explicitly deleted — bitbucket's decline never touches the
        // ref. Without this every scenario run leaks an
        // `e2e/<fixture>-<suffix>` branch into the repo. closePR is
        // wrapped in a best-effort try/catch by every scenario, so a
        // delete failure here surfaces as a warning, not a test fail.
        if (pr.keepBranchOnClose === false && pr.branch) {
            try {
                await http(
                    `${this.apiBase}/repositories/${this.workspaceSlug}/refs/branches/${encodeURIComponent(pr.branch)}`,
                    { method: "DELETE", headers: this.headers() },
                );
            } catch {
                // best-effort — a leaked branch is recoverable; failing
                // the scenario on cleanup would mask real failures.
            }
        }
    }

    async triggerReviewOnExistingPR(
        prNumber: number,
    ): Promise<{ triggerId: string; sinceIso: string }> {
        const target = prNumber || this.existingPrId;
        if (!target) throw new Error("bitbucket:triggerReview requires BB_TEST_PR_ID");
        const resp = await http<BitbucketComment>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${target}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { content: { raw: "@kody review" } },
            },
        );
        ensureOk(resp, "bitbucket:triggerReview");
        return {
            triggerId: String(resp.body.id),
            sinceIso: resp.body.created_on,
        };
    }

    async pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal> {
        const result = await pollUntil(
            async () => {
                const resp = await http<{ values: BitbucketComment[] }>(
                    `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${pr.number}/comments?pagelen=50&sort=-created_on`,
                    { headers: this.headers() },
                );
                ensureOk(resp, "bitbucket:pollForReview");
                const filtered = (resp.body.values ?? []).filter((c) => {
                    if (c.created_on <= opts.sinceIso) return false;
                    if (opts.triggerId && String(c.id) === opts.triggerId) return false;
                    const raw = c.content?.raw ?? "";
                    if (raw.toLowerCase().startsWith("@kody")) return false;
                    // Drop "Started!" placeholder but keep "Complete!" — the
                    // latter is a valid mechanics signal even when Kody
                    // found no inline findings. Bitbucket-specific: Kody
                    // does NOT inject the `<!-- kody-codereview -->` HTML
                    // marker into Bitbucket comments (it does on github/
                    // gitlab), so the marker check alone matches nothing.
                    // Fall back to detecting the visible heading text
                    // Kody renders into the placeholder.
                    if (
                        raw.includes("<!-- kody-codereview") &&
                        !raw.includes("kody-codereview-completed")
                    ) {
                        return false;
                    }
                    if (raw.includes("Code Review Started!")) {
                        return false;
                    }
                    // Bitbucket-only leftover: when the gate skips the pipeline
                    // mid-flow, Kody overwrites its "Code Review Started!"
                    // placeholder comment so only the docs.kodus.io feedback
                    // footer remains. The comment is then ~80 chars of just
                    // the 👎 link with no actual review content — meaningless
                    // for the per-seat scenario and easy to confuse with a
                    // real "No issues found" outcome. Drop it.
                    const trimmed = raw.trim();
                    // Regex (not String.includes) so CodeQL doesn't read this
                    // as URL-host sanitization — `trimmed` is a review-comment
                    // body and we're plain text-matching the footer's docs
                    // link, not validating a URL.
                    if (
                        trimmed.length < 200 &&
                        /docs\.kodus\.io/.test(trimmed) &&
                        !trimmed.includes("Kody Review Complete") &&
                        !trimmed.includes("Kody Guide")
                    ) {
                        return false;
                    }
                    return true;
                });
                if (filtered.length) {
                    return {
                        reviewComments: filtered.length,
                        issueComments: 0,
                        reviews: 0,
                        sample: (filtered[0]?.content?.raw ?? "").slice(0, 240),
                    };
                }
                return null;
            },
            { timeoutSec: opts.timeoutSec ?? 600, intervalSec: 10 },
        );
        return result ?? { reviewComments: 0, issueComments: 0, reviews: 0 };
    }

    async postComment(
        prNumber: number,
        body: string,
    ): Promise<{ id: string }> {
        const resp = await http<BitbucketComment>(
            `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${prNumber}/comments`,
            {
                method: "POST",
                headers: this.headers(),
                body: { content: { raw: body } },
            },
        );
        ensureOk(resp, "bitbucket:postComment");
        return { id: String(resp.body.id) };
    }

    authMode(): "token" {
        // Bitbucket's "app password" / "API token" auth flows are both
        // routed through Kodus's AuthMode.TOKEN branch — the backend
        // accepts `username:token` Basic auth. Returning the literal
        // "app-password" string here was silently bypassing the whole
        // authenticateWithToken flow on the Kodus side (no enum match →
        // default success response in <10ms with nothing persisted), so
        // the subsequent /repositories/org call had no auth detail to
        // pull repos from and returned an empty list.
        return "token";
    }

    authToken(): string {
        return this.appPassword;
    }

    async currentUserId(): Promise<string> {
        // Bitbucket returns uuid as `{abc-...}` with braces. Kodus's
        // bitbucket-cloud.service.ts strips them via sanitizeUUID before
        // storing as pullRequest.user.id, so we mirror that here — must
        // match exactly for the per-seat assign payload to land on the
        // same user the gate checks.
        const resp = await http<{ uuid: string; account_id: string }>(
            `${this.apiBase}/user`,
            { headers: this.headers(), timeoutMs: 15_000 },
        );
        ensureOk(resp, "bitbucket:currentUserId");
        return (resp.body.uuid ?? "").replace(/[{}]/g, "");
    }

    licenseGitTool(): string {
        return "bitbucket";
    }

    async pollForLicenseBlock(
        pr: { number: number },
        opts: { sinceIso: string; timeoutSec?: number },
    ): Promise<boolean> {
        // USER_NOT_LICENSED → on Bitbucket the stage posts a 👎 PR comment
        // linking the emoji-meaning docs (createIssueComment with
        // `[👎](https://docs.kodus.io/...what-each-emoji-means)`) rather than
        // a reaction. Match the 👎 in the comment body.
        const found = await pollUntil<boolean>(
            async () => {
                const resp = await http<{
                    values?: { content?: { raw?: string } }[];
                }>(
                    `${this.apiBase}/repositories/${this.workspaceSlug}/pullrequests/${pr.number}/comments?pagelen=100`,
                    { headers: this.headers() },
                );
                if (resp.status < 200 || resp.status >= 300) return null;
                return (resp.body.values ?? []).some((c) =>
                    (c.content?.raw ?? "").includes("👎"),
                )
                    ? true
                    : null;
            },
            { intervalSec: 5, timeoutSec: opts.timeoutSec ?? 120 },
        );
        return found === true;
    }
}
