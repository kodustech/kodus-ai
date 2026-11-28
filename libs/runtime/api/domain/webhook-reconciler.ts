import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

// The lost-webhook reconciler (docs/runtime/webhook-reconciler.md): a periodic
// pass that hands the PR trigger an open PR whose head a webhook should have
// started a Run on and did not. It never decides a Run itself: the trigger
// decides, with the same reads and rules as for a webhook.

export const RUNTIME_WEBHOOK_RECONCILER_CONFIG = Symbol.for('RuntimeApi.WebhookReconcilerConfig');
export const RUNTIME_RECONCILED_HEAD_STORE = Symbol.for('RuntimeApi.ReconciledHeadStore');

/**
 * The platforms whose webhook handler writes Runtime pull request events
 * (githubPullRequest.handler.ts only). On any other platform no webhook ever
 * starts a Run, so there is no lost webhook to make up for: reconciling there
 * would turn the reconciler into the trigger itself.
 */
export const RECONCILED_PLATFORMS: readonly PlatformType[] = [PlatformType.GITHUB];

export interface WebhookReconcilerConfig {
    /** Off unless RUNTIME_WEBHOOK_RECONCILER_ENABLED=true. */
    enabled: boolean;
    /** A PR not updated within this window is left alone: its head is older than the window. */
    windowMs: number;
    /** A PR updated this recently is left to its webhook, which may still be on its way. */
    graceMs: number;
    /** PRs handed to the trigger per organization per tick. */
    perOrgPerTick: number;
    /** PRs handed to the trigger per tick, every organization together. */
    perTick: number;
    /** Repositories whose open PRs are listed per tick (one platform call each). */
    repositoriesPerTick: number;
}

const MINUTE = 60_000;
/** One head of one pull request: the reconciler hands it to the trigger at most once. */
export interface ReconciledHeadKey {
    organizationId: string;
    repositoryId: string;
    prNumber: number;
    headSha: string;
}

/** How often a head whose trigger call failed is tried again, and when a claim nobody settled is taken over. */
export const RECONCILE_MAX_ATTEMPTS = 3;
export const RECONCILE_STALE_CLAIM_MS = 15 * MINUTE;

/**
 * `runtime_reconciled_heads` (product Postgres): the heads the reconciler
 * handed to the trigger. A claim is atomic across replicas and restarts: of
 * two claims of one head, one gets it. A head is claimed again only after its
 * trigger call failed, or after a claim nobody settled went stale, and at most
 * RECONCILE_MAX_ATTEMPTS times in all. The trigger is idempotent per head
 * (the Run's id is derived from it), so a second call never starts a second Run.
 */
export interface ReconciledHeadStore {
    /** The attempt this claim is (1 for the first), or null when another holds or settled the head. */
    claim(key: ReconciledHeadKey): Promise<number | null>;
    /** What the trigger decided; only the holder of `attempt` writes it. */
    settle(key: ReconciledHeadKey, attempt: number, outcome: string): Promise<void>;
    /** The trigger call threw: the head may be claimed again, up to the attempt limit. */
    fail(key: ReconciledHeadKey, attempt: number, reason: string): Promise<void>;
}
