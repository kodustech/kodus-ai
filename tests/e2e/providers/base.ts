import type {
    Provider,
    ProviderName,
    OpenPRArgs,
    OpenedPR,
    ProviderRepoRef,
    ReviewSignal,
    Target,
    WebhookInfo,
} from "../lib/types.js";

export interface ProviderConfig {
    name: ProviderName;
    apiBaseUrl: string;
    webBaseUrl?: string;
}

export abstract class BaseProvider implements Provider {
    abstract readonly name: ProviderName;
    abstract readonly integrationType: string;
    abstract readonly webhookPath: string;

    abstract repoRef(): Promise<ProviderRepoRef>;
    abstract createWebhook(webhookUrl: string): Promise<{ id: string }>;
    abstract deleteWebhook(id: string): Promise<void>;
    abstract listWebhooks(): Promise<WebhookInfo[]>;
    abstract openPR(args: OpenPRArgs): Promise<OpenedPR>;
    abstract closePR(pr: OpenedPR): Promise<void>;
    abstract cleanupStaleE2EArtifacts(): Promise<{ closed: number }>;
    abstract triggerReviewOnExistingPR(prNumber: number): Promise<{
        triggerId: string;
        sinceIso: string;
    }>;
    abstract pollForReview(
        pr: { number: number },
        opts: { sinceIso: string; triggerId?: string; timeoutSec?: number },
    ): Promise<ReviewSignal>;
    abstract postComment(prNumber: number, body: string): Promise<{ id: string }>;
    abstract authMode(): "token" | "oauth" | "app-password";
    abstract authToken(): string;
    abstract currentUserId(): Promise<string>;
    abstract licenseGitTool(): string;
}

export function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) {
        throw new Error(`Required env var ${name} is not set`);
    }
    return v;
}

// Resolve a fixture-repo env var, scoped to the run target. Cloud and
// self-hosted run in parallel in ONE process, so they can't share a single
// GH_TEST_REPO — each target must hit its OWN repo or their webhooks/PRs
// collide on a shared repo (the whole reason cloud↔self-hosted couldn't run
// concurrently). Looks up `<base>_<TARGET>` (e.g. GH_TEST_REPO_CLOUD) and falls
// back to the plain `<base>` — self-hosted keeps using the original repo, cloud
// points at its own `*-cloud` repo. Suffix: cloud→CLOUD, self-hosted→SELF_HOSTED.
export function resolveTargetRepo(baseEnvName: string, target: Target): string {
    const sfx = target.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
    return process.env[`${baseEnvName}_${sfx}`] || requireEnv(baseEnvName);
}

export function nowIso(): string {
    return new Date().toISOString();
}

export async function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface PollOptions {
    timeoutSec: number;
    intervalSec: number;
}

export async function pollUntil<T>(
    fn: () => Promise<T | null>,
    opts: PollOptions,
): Promise<T | null> {
    const intervalSec = Number(
        process.env.E2E_POLL_INTERVAL_OVERRIDE_SEC ?? opts.intervalSec,
    );
    const timeoutSec = Number(
        process.env.E2E_POLL_TIMEOUT_OVERRIDE_SEC ?? opts.timeoutSec,
    );
    const deadline = Date.now() + timeoutSec * 1000;
    while (Date.now() < deadline) {
        const result = await fn();
        if (result !== null) return result;
        await sleep(intervalSec * 1000);
    }
    return null;
}
