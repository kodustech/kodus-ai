export type Target = 'cloud' | 'self-hosted';

export type ProviderName =
    | 'github'
    | 'github-app'
    | 'gitlab'
    | 'bitbucket'
    | 'azure-devops';

export type LicenseMode =
    | 'free'
    | 'trial'
    | 'paid'
    | 'community-byok' // free plan with the org's own LLM API key configured
    | 'license-paid'
    | 'license-free';

export type Priority = 'P0' | 'P1' | 'P2';

export interface TargetContext {
    target: Target;
    apiBaseUrl: string;
    webBaseUrl: string;
    tunnelUrl?: string;
}

export interface ProviderRepoRef {
    full_name: string;
    id: string | number;
    name?: string;
}

export interface OpenPRArgs {
    branch: string;
    title: string;
    body: string;
    fixtureFiles: Record<string, string>;
    /** Repo-relative paths to git-rm in the same commit (lifecycle tests: file removal must remove the synced rule). */
    deleteFiles?: string[];
    baseBranch?: string;
}

// For test repos that already have head/base branch pairs with deliberate
// diffs committed (e.g. the forked benchmark repos in the kodus-e2e org).
// No clone, no push — just opens a PR between two existing branches. Each
// call creates a fresh PR number, so the `validate-new-commits` pipeline
// stage always treats it as a new review (unlike re-triggering on a
// standing PR, which gets short-circuited as "already reviewed").
export interface OpenPRFromBranchesArgs {
    head: string;
    base: string;
    title: string;
    body: string;
}

export interface OpenedPR {
    number: number;
    url: string;
    branch: string;
    baseBranch: string;
    // When true, `closePR` only closes the PR and does NOT delete the head
    // branch. Used by `openPRFromBranches` where the branch is a permanent
    // fixture in the test repo, not something the scenario created.
    keepBranchOnClose?: boolean;
}

export interface ReviewSignal {
    reviewComments: number;
    issueComments: number;
    reviews: number;
    sample?: string;
    // Set when Kody posted a license-related notification (e.g. "Your
    // trial has ended! Activate your plan…" or a BYOK prompt) instead of
    // a real review. Scenarios that expect the entitlement gate to
    // BLOCK a review still want to verify Kody told the user *why* —
    // bare silence (no comment at all) is a different failure mode
    // (webhook never arrived, pipeline crashed silently) than the
    // intended UX. Providers populate this when they detect a
    // license/trial/BYOK-prompt comment from Kody on the PR.
    licenseBlockedNotice?: {
        message: string;
        kind: 'trial-ended' | 'byok-required' | 'no-license' | 'other';
    };
}

export interface WebhookInfo {
    id: string;
    url: string;
    active: boolean;
    events: string[];
}

export interface Provider {
    readonly name: ProviderName;
    readonly integrationType: string;
    readonly webhookPath: string;
    repoRef(): Promise<ProviderRepoRef>;
    createWebhook(webhookUrl: string): Promise<{ id: string }>;
    deleteWebhook(id: string): Promise<void>;
    // Lists webhooks currently registered against the target repo/project.
    // Used by the onboarding-webhook-registration scenario to verify that
    // Kodus's auto-register step actually wired a hook — the alternative
    // (waiting for a review to materialize) only fails after 10+ min and
    // doesn't distinguish "webhook never registered" from "review pipeline
    // bug downstream of webhook receipt".
    listWebhooks(): Promise<WebhookInfo[]>;
    openPR(args: OpenPRArgs): Promise<OpenedPR>;
    // Optional: opens a PR using two already-existing branches (head/base)
    // without cloning or pushing. Providers that don't implement this throw
    // a clear "not supported" error. See `OpenPRFromBranchesArgs` for the
    // motivation (avoid `validate-new-commits` skip on standing PRs).
    openPRFromBranches?(args: OpenPRFromBranchesArgs): Promise<OpenedPR>;
    closePR(pr: OpenedPR): Promise<void>;
    triggerReviewOnExistingPR(prNumber: number): Promise<{
        triggerId: string;
        sinceIso: string;
    }>;
    pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal>;
    // Phase-A poll for "Kody acknowledged the PR" — i.e. ANY comment
    // carrying the `<!-- kody-codereview` marker has appeared on the
    // PR (including the "Code Review Started!" placeholder that
    // `pollForReview` deliberately filters out). Lets the scenario
    // distinguish "review pipeline never woke up" (fail fast, ~60s)
    // from "pipeline ran but LLM produced no findings" (the long
    // 1500s budget). Optional because GitLab/Bitbucket/Azure aren't
    // wired yet — code-review-basic only runs phase A when the
    // provider implements this.
    waitForPipelineStart?(
        pr: { number: number },
        opts: { sinceIso: string; timeoutSec: number },
    ): Promise<{ startedAt: string; sample: string }>;
    postComment(prNumber: number, body: string): Promise<{ id: string }>;
    // Optional: posts a comment as a DIFFERENT identity (token override). The
    // conversation scenario needs this — Kody ignores comments whose author
    // login contains "kody"/"kodus" (the e2e bots), so the `@kody` mention must
    // come from a non-Kody account.
    postCommentAs?(
        prNumber: number,
        body: string,
        token: string,
    ): Promise<{ id: string }>;
    // Optional: posts an INLINE review comment as a different identity. Kody's
    // ConversationAgent only resolves the mention from a review comment (issue
    // comments are never found), so the conversation scenario needs this.
    postReviewCommentAs?(
        prNumber: number,
        body: string,
        token: string,
    ): Promise<{ id: string }>;
    // Optional: polls for Kody's conversational reply to an `@kody <question>`
    // new non-trigger, non-code-review comment, or null at timeout. Only GitHub
    // is wired; the conversation scenario gates on its presence.
    pollForKodyReply?(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<{ id: string; body: string } | null>;
    // Optional: merges a PR (falls back to close). Drives the closed/merged-PR
    // webhook that triggers kody-issues generation (v2/BYOK path).
    mergePR?(pr: OpenedPR): Promise<void>;
    authMode(): 'token' | 'oauth' | 'app-password';
    authToken(): string;
    // Provider-specific extra body fields for POST /code-management/auth-integration.
    // Azure DevOps needs `orgUrl` + `orgName`; everything else returns {}.
    // Override only when the Kodus backend rejects a bare token+authMode body.
    authExtraFields?(): Record<string, unknown>;
    // Returns the id Kodus stores as `pullRequest.user.id` for PRs opened by
    // this PAT — i.e. exactly what `validate-prerequisites.stage.ts` reads
    // when deciding whether the author has a license seat. Per-provider:
    //   * github / gitlab: numeric id from /user (stringified)
    //   * bitbucket: uuid from /2.0/user with `{}` stripped (sanitizeUUID)
    //   * azure-devops: authenticatedUser.id GUID from connectionData
    currentUserId(): Promise<string>;
    // Kodus's gitTool value for /license/assign (lowercase platformType).
    // Matches `assignLicense(provider.toLowerCase())` in license.service.ts.
    licenseGitTool(): string;
    // Detects Kody's "blocked: PR author has no license seat" signal on the
    // PR since `sinceIso`. validate-prerequisites.stage.ts emits a 👎 on
    // USER_NOT_LICENSED — a reaction on github/gitlab, a comment carrying the
    // docs.kodus.io emoji-meaning link on bitbucket/azure. Resolves true once
    // the signal appears (false at timeout). This lets a scenario assert the
    // seat gate ACTIVELY blocked the review, rather than inferring it from the
    // mere absence of a review comment — absence also happens when a webhook
    // is lost or routed to another tenant, so it cannot prove the block.
    pollForLicenseBlock?(
        pr: { number: number },
        opts: { sinceIso: string; timeoutSec?: number },
    ): Promise<boolean>;
    // Idempotent pre-flight sweep — closes/abandons every PR (or MR) on
    // the fixture repo whose title starts with `[e2e]` and is still
    // open. Called once per (provider, target) pair at matrix start,
    // BEFORE any scenario runs. Reason: the per-scenario `closePR()`
    // finally block only fires on the happy path. A scenario crash, a
    // SIGINT to the runner, or a parallel-cell abort all leave PRs
    // open; the next matrix run then hits provider-specific errors
    // (Azure HTTP 409 "active PR exists on this branch pair",
    // GitHub/GitLab webhook bursts on auto-closed orphans, Bitbucket
    // PR-number drift). Cleanup at the start makes every run start
    // from a known-clean state regardless of how the previous run
    // ended. Filters strictly by `[e2e]` title prefix so we never
    // touch PRs a human opened on the same repo.
    cleanupStaleE2EArtifacts(): Promise<{ closed: number }>;
}

export interface TenantCredentials {
    email: string;
    password: string;
    // Optional per-tenant fixture repo (cloud only). When set, the
    // provider for this cell targets THIS repo instead of the
    // env-resolved per-target default. Required for cloud GitHub PAT
    // tenants, where each license tier is a separate Kodus org: sharing
    // one repo across orgs makes the webhook→org resolution ambiguous
    // (it picks the first org by updatedAt DESC), so the test's own org
    // isn't reliably the one that reviews its PR. One repo per tenant
    // restores the 1 org : 1 repo invariant the other providers already
    // have. `owner/name` form, e.g. `kodus-e2e/tiny-url-cloud-paid`.
    repoFullName?: string;
}

export interface KodusSession {
    accessToken: string;
    organizationId: string;
    teamId: string;
}

export interface RunContext {
    target: TargetContext;
    provider: Provider;
    license: LicenseMode;
    tenant?: TenantCredentials;
    kodus: {
        login: (creds: TenantCredentials) => Promise<KodusSession>;
        registerIntegration: (session: KodusSession) => Promise<void>;
        registerRepo: (
            session: KodusSession,
            opts?: { forceRecreate?: boolean },
        ) => Promise<ProviderRepoRef>;
        finishOnboarding: (
            session: KodusSession,
            repo: ProviderRepoRef,
        ) => Promise<void>;
    };
    assert: (cond: unknown, msg: string) => asserts cond;
    // Throw ScenarioSkipError (via this helper) when a scenario can
    // detect at runtime that its preconditions aren't met and the
    // outcome should be recorded as `skipped` rather than `failed`.
    // Used by upgrade-n-1-to-n when not invoked from the upgrade
    // provisioning script — the assertion-shaped failure was
    // misleading bottom-line counts.
    skip: (reason: string) => never;
    artifactDir: string;
    runId: string;
}

// Sentinel thrown by `ctx.skip(...)`. The matrix runner catches
// this specifically and records the cell as `skipped` instead of
// `failed`. Plain Error subclasses won't match (we check by name
// to survive a bundler dropping prototype-chain identity).
export class ScenarioSkipError extends Error {
    readonly name = 'ScenarioSkipError';
    constructor(reason: string) {
        super(reason);
    }
}

export type ScenarioStatus = 'passed' | 'failed' | 'skipped' | 'blocked';

export interface ScenarioResult {
    scenarioId: string;
    cell: {
        target: Target;
        provider: ProviderName;
        license: LicenseMode;
    };
    status: ScenarioStatus;
    durationMs: number;
    evidence: Record<string, unknown>;
    errorMessage?: string;
    errorStack?: string;
    startedAt: string;
    finishedAt: string;
}

export interface ScenarioAppliesTo {
    target?: Target[];
    provider?: ProviderName[];
    license?: LicenseMode[];
}

export interface Scenario {
    id: string;
    title: string;
    priority: Priority;
    appliesTo: ScenarioAppliesTo;
    timeoutSec?: number;
    run: (ctx: RunContext) => Promise<Record<string, unknown>>;
}

export interface MatrixCell {
    target: Target;
    provider: ProviderName;
    license: LicenseMode;
}

export interface MatrixConfig {
    id: string;
    description?: string;
    scenarios: string[];
    cells: MatrixCell[];
}
