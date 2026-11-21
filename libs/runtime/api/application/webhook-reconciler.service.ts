import { Inject, Injectable, Optional } from '@nestjs/common';
import { metrics, type Meter } from '@opentelemetry/api';

import type { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { createLogger } from '@libs/core/log/logger';
import type { RunProjectionReader, RuntimePullRequestObserved } from '@libs/runtime/run';

import { RUNTIME_EXTERNAL_STOP_READER, type ExternalStopReader } from '../domain/external-findings';
import {
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_SETTINGS_STORE,
    type AutomaticRepositoriesReader,
    type OpenPullRequestSummary,
    type ProductEnvironmentStore,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
} from '../domain/ports';
import {
    RECONCILED_PLATFORMS,
    RUNTIME_RECONCILED_HEAD_STORE,
    RUNTIME_WEBHOOK_RECONCILER_CONFIG,
    type ReconciledHeadKey,
    type ReconciledHeadStore,
    type WebhookReconcilerConfig,
} from '../domain/webhook-reconciler';
import { RuntimeEnvironmentMembers } from './environment-members.service';
import { RUNTIME_PLATFORM_RESOLVER, type RuntimePlatformResolver } from './runtime-run-enqueuer.service';
import { RuntimePullRequestTriggerUseCase, type TriggerOutcome } from './use-cases/pull-request-trigger.use-case';

/** Rows of automatic repositories read per tick, every organization together. */
const MAX_AUTOMATIC_REPOSITORIES = 2_000;
/** A PR's Runs read to tell whether its head already ran (the trigger reads the same page). */
const RUNS_PER_PULL_REQUEST = 50;
/** Failed reads of one org named in its log line; `count` carries the rest. */
const MAX_LOGGED_UNREADABLE = 20;

export const RECONCILER_STARTED_METRIC = 'runtime.reconciler.started';
export const RECONCILER_HANDED_METRIC = 'runtime.reconciler.handed';
export const RECONCILER_SKIPPED_METRIC = 'runtime.reconciler.skipped';

/** Why a listed PR was not handed to the trigger, or how a tick stopped short. */
export type ReconcilerSkip =
    | 'draft'
    | 'no_updated_at'
    | 'outside_window'
    | 'too_recent'
    | 'already_ran'
    | 'already_reconciled'
    | 'runs_unreadable'
    | 'org_cap'
    | 'tick_cap'
    | 'repository_cap'
    | 'deadline'
    | 'org_stopped'
    | 'stop_unknown'
    | 'platform_not_reconciled'
    | 'platform_unreadable'
    | 'environment_unreadable'
    | 'setup_unreadable'
    | 'members_unreadable'
    | 'listing_unsupported'
    | 'listing_failed';

export interface WebhookReconcilerMetrics {
    /** Runs the trigger enqueued for a head the reconciler handed it. */
    started(count: number, organizationId: string): void;
    /** A head handed to the trigger: what it decided (`enqueued`, `skipped:<reason>`, `failed`). */
    handed(outcome: string): void;
    skipped(reason: ReconcilerSkip, count?: number): void;
}

export const RUNTIME_WEBHOOK_RECONCILER_METRICS = Symbol.for('RuntimeApi.WebhookReconcilerMetrics');

/** The reconciler's counters. The product worker registers no meter provider yet: the per-tick log line carries the same counts. */
export class OtelWebhookReconcilerMetrics implements WebhookReconcilerMetrics {
    private readonly startedRuns;
    private readonly handedHeads;
    private readonly skippedHeads;

    constructor(meter: Meter = metrics.getMeter('kody-runtime-api')) {
        this.startedRuns = meter.createCounter(RECONCILER_STARTED_METRIC, { description: 'Runs the lost-webhook reconciler started' });
        this.handedHeads = meter.createCounter(RECONCILER_HANDED_METRIC, { description: 'Pull request heads the reconciler handed to the trigger, by outcome' });
        this.skippedHeads = meter.createCounter(RECONCILER_SKIPPED_METRIC, { description: 'Pull requests the reconciler left alone, by reason' });
    }

    started(count: number) {
        // No organization attribute: one series per org would be unbounded.
        if (count > 0) this.startedRuns.add(count);
    }

    handed(outcome: string) {
        this.handedHeads.add(1, { outcome });
    }

    skipped(reason: ReconcilerSkip, count = 1) {
        if (count > 0) this.skippedHeads.add(count, { reason });
    }
}

export interface ReconcileTickSummary {
    enabled: boolean;
    organizations: number;
    repositories: number;
    pullRequests: number;
    handed: number;
    started: number;
    skipped: Partial<Record<ReconcilerSkip, number>>;
}

/** A repository the reconciler lists, and each automatic environment it triggers, with the earliest PR update that environment answers for. */
interface Target {
    organizationId: string;
    teamId: string;
    repositoryId: string;
    repositoryName: string;
    /** environmentId → the earliest `updatedAt` (ms) a webhook of that environment could have started a Run at. */
    floors: Map<string, number>;
}

const startedIn = (outcome: TriggerOutcome) =>
    outcome.action === 'enqueued' ? 1 : outcome.action === 'per_environment' ? outcome.outcomes.filter((o) => o.action === 'enqueued').length : 0;

const outcomeLabel = (outcome: TriggerOutcome) => {
    if (outcome.action === 'skipped') return `skipped:${outcome.reason}`;
    if (outcome.action === 'cancelled') return `cancelled:${outcome.reason}`;
    if (outcome.action === 'per_environment') return startedIn(outcome) > 0 ? 'enqueued' : 'skipped:per_environment';
    return 'enqueued';
};

/**
 * Lost webhooks (docs/runtime/webhook-reconciler.md): a pull request
 * event that never reached the product never became a Run. Each tick lists
 * the open PRs of every repository an automatic environment (mode `rules`,
 * setup active) triggers on, and hands the trigger a PR whose head has no Run
 * in one of those environments, as the webhook would have. It hands nothing:
 *
 * - for a platform whose webhooks write no Runtime event (RECONCILED_PLATFORMS);
 * - for an org whose Runtime is stopped, or whose stop cannot be read;
 * - for a draft, or a PR updated within the grace (its webhook may be on its way);
 * - for a PR not updated since the window, the settings' last change or the
 *   setup's activation: its head was pushed when no webhook would have run it;
 * - for a head that has any Run in that environment, cancelled ones included
 *   (superseded, stopped, closed): a head is never run twice;
 * - for a head already handed once (the ledger, shared by replicas and restarts).
 *
 * The trigger then reads the PR from the Git API and applies every rule as for
 * a webhook (fork policy, draft, rules, agent authors, new pushes), and its
 * Run id is derived from the head, so a Run is started at most once per head.
 */
@Injectable()
export class RuntimeWebhookReconciler {
    private readonly logger = createLogger(RuntimeWebhookReconciler.name);
    /** Where the next tick starts among the organizations, so a capped tick does not always favour the same ones. */
    private orgOffset = 0;

    constructor(
        @Inject(RUNTIME_WEBHOOK_RECONCILER_CONFIG)
        private readonly config: WebhookReconcilerConfig,
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly automatic: AutomaticRepositoriesReader,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'findByRepository'>,
        private readonly members: RuntimeEnvironmentMembers,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups: RuntimeEnvironmentSetupReader,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: Pick<RunProjectionReader, 'list'>,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: Pick<RuntimeGitPort, 'listOpenPullRequests'>,
        @Inject(RUNTIME_PLATFORM_RESOLVER)
        private readonly platforms: RuntimePlatformResolver,
        @Inject(RUNTIME_RECONCILED_HEAD_STORE)
        private readonly ledger: ReconciledHeadStore,
        @Inject(RuntimePullRequestTriggerUseCase)
        private readonly trigger: Pick<RuntimePullRequestTriggerUseCase, 'execute'>,
        @Optional()
        @Inject(RUNTIME_EXTERNAL_STOP_READER)
        private readonly stops?: ExternalStopReader,
        @Optional()
        @Inject(RUNTIME_WEBHOOK_RECONCILER_METRICS)
        private readonly metrics: WebhookReconcilerMetrics = new OtelWebhookReconcilerMetrics(),
    ) {}

    /** One pass. `deadline` (ms): no PR is handed to the trigger after it. */
    async tick(now: Date = new Date(), deadline = Number.POSITIVE_INFINITY): Promise<ReconcileTickSummary> {
        const summary: ReconcileTickSummary = { enabled: this.config.enabled, organizations: 0, repositories: 0, pullRequests: 0, handed: 0, started: 0, skipped: {} };
        if (!this.config.enabled) return summary;
        const skip = (reason: ReconcilerSkip, count = 1) => {
            summary.skipped[reason] = (summary.skipped[reason] ?? 0) + count;
            this.metrics.skipped(reason, count);
        };

        const rows = await this.automatic.listAutomaticAcrossOrganizations(MAX_AUTOMATIC_REPOSITORIES);
        const byOrg = new Map<string, typeof rows>();
        for (const row of rows) byOrg.set(row.organizationId, [...(byOrg.get(row.organizationId) ?? []), row]);
        const orgs = [...byOrg.keys()];
        const start = orgs.length ? this.orgOffset % orgs.length : 0;
        this.orgOffset = start + 1;
        const ordered = [...orgs.slice(start), ...orgs.slice(0, start)];

        let repositoriesLeft = this.config.repositoriesPerTick;
        /** Set when the tick's cap or deadline is reached: no other organization is read. */
        let over = false;
        for (const organizationId of ordered) {
            if (over) break;
            summary.organizations++;
            const stopped = await this.isStopped(organizationId);
            if (stopped !== false) {
                skip(stopped === true ? 'org_stopped' : 'stop_unknown');
                continue;
            }
            const targets = await this.targetsOf(organizationId, byOrg.get(organizationId)!, now, skip);
            let handedInOrg = 0;
            const platformOf = new Map<string, Promise<PlatformType | null | 'unreadable'>>();
            orgLoop: for (const target of targets) {
                if (repositoriesLeft <= 0 || Date.now() > deadline) {
                    skip(repositoriesLeft <= 0 ? 'repository_cap' : 'deadline');
                    over = true;
                    break;
                }
                if (!platformOf.has(target.teamId)) {
                    const teamId = target.teamId;
                    platformOf.set(
                        teamId,
                        this.platforms.getTypeIntegration({ organizationId, teamId }).catch((error: unknown) => {
                            // Once per team and tick (the promise is shared): an unreadable platform is not one the reconciler skips by design.
                            this.logger.warn({
                                message: 'Runtime reconciler: the platform of a team could not be read; its repositories wait for a later tick',
                                context: RuntimeWebhookReconciler.name,
                                error: error instanceof Error ? error : undefined,
                                metadata: { organizationId, teamId },
                            });
                            return 'unreadable' as const;
                        }),
                    );
                }
                const platform = await platformOf.get(target.teamId)!;
                if (platform === 'unreadable') {
                    skip('platform_unreadable');
                    continue;
                }
                if (!platform || !RECONCILED_PLATFORMS.includes(platform)) {
                    skip('platform_not_reconciled');
                    continue;
                }
                repositoriesLeft--;
                summary.repositories++;
                const listed = await this.listOpen(target);
                if (listed === 'unsupported' || listed === 'failed') {
                    skip(listed === 'unsupported' ? 'listing_unsupported' : 'listing_failed');
                    continue;
                }
                for (const pr of listed) {
                    summary.pullRequests++;
                    const reason = await this.leaveAlone(target, pr, now);
                    if (reason) {
                        skip(reason);
                        continue;
                    }
                    if (handedInOrg >= this.config.perOrgPerTick) {
                        skip('org_cap');
                        break orgLoop;
                    }
                    if (summary.handed >= this.config.perTick || Date.now() > deadline) {
                        skip(summary.handed >= this.config.perTick ? 'tick_cap' : 'deadline');
                        over = true;
                        break orgLoop;
                    }
                    const key: ReconciledHeadKey = { organizationId, repositoryId: target.repositoryId, prNumber: pr.number, headSha: pr.headSha };
                    const attempt = await this.ledger.claim(key);
                    if (attempt === null) {
                        skip('already_reconciled');
                        continue;
                    }
                    handedInOrg++;
                    summary.handed++;
                    summary.started += await this.hand(target, pr, key, attempt, now);
                }
            }
        }
        return summary;
    }

    /** true / false, or undefined when the stop cannot be read (which holds the org back). */
    private async isStopped(organizationId: string): Promise<boolean | undefined> {
        if (!this.stops) return false;
        try {
            return await this.stops.isStopped(organizationId);
        } catch {
            return undefined;
        }
    }

    /**
     * The repositories the org's automatic environments trigger on: the
     * primary of each environment whose own settings are `rules` and whose
     * setup is active, and every member that triggers. A repository in two such
     * environments is listed once, with both floors.
     *
     * A read that fails skips that repository for this tick under its own
     * reason, never as "no environment" or "setup not active", and the org's
     * failed reads are logged in one line.
     */
    private async targetsOf(
        organizationId: string,
        rows: Array<{ repositoryId: string; updatedAt: string }>,
        now: Date,
        skip: (reason: ReconcilerSkip) => void,
    ): Promise<Target[]> {
        const targets = new Map<string, Target>();
        const windowFloor = now.getTime() - this.config.windowMs;
        const unreadable: Array<{ repositoryId: string; environmentId?: string; reason: ReconcilerSkip; error: string }> = [];
        const failed = (reason: ReconcilerSkip, repositoryId: string, environmentId: string | undefined) => (error: unknown) => {
            skip(reason);
            unreadable.push({ repositoryId, environmentId, reason, error: error instanceof Error ? error.name : 'error' });
            return 'unreadable' as const;
        };
        for (const row of rows) {
            const env = await this.environments.findByRepository(organizationId, row.repositoryId).catch(failed('environment_unreadable', row.repositoryId, undefined));
            if (!env || env === 'unreadable') continue;
            const setup = await this.setups.get(organizationId, env.environmentId).catch(failed('setup_unreadable', row.repositoryId, env.environmentId));
            if (setup === 'unreadable' || setup?.state !== 'active') continue;
            const floor = Math.max(windowFloor, Date.parse(row.updatedAt) || 0, Date.parse(setup.finishedAt ?? '') || 0);
            const repositories = await this.members.list(env).catch(failed('members_unreadable', row.repositoryId, env.environmentId));
            if (repositories === 'unreadable') continue;
            for (const repo of repositories.filter((r) => r.triggers)) {
                const target = targets.get(repo.repositoryId) ?? {
                    organizationId,
                    teamId: env.teamId,
                    repositoryId: repo.repositoryId,
                    repositoryName: repo.fullName || repo.repositoryName,
                    floors: new Map<string, number>(),
                };
                target.floors.set(env.environmentId, floor);
                targets.set(repo.repositoryId, target);
            }
        }
        if (unreadable.length) {
            this.logger.warn({
                message: 'Runtime reconciler: repositories skipped because a read failed; they are tried again on a later tick',
                context: RuntimeWebhookReconciler.name,
                metadata: { organizationId, count: unreadable.length, unreadable: unreadable.slice(0, MAX_LOGGED_UNREADABLE) },
            });
        }
        return [...targets.values()];
    }

    private async listOpen(target: Target): Promise<OpenPullRequestSummary[] | 'unsupported' | 'failed'> {
        if (!this.git.listOpenPullRequests) return 'unsupported';
        try {
            const listed = await this.git.listOpenPullRequests({
                organizationId: target.organizationId,
                teamId: target.teamId,
                repositoryId: target.repositoryId,
                repositoryName: target.repositoryName,
            });
            return listed === 'unsupported_platform' ? 'unsupported' : listed;
        } catch {
            return 'failed';
        }
    }

    /** Why this PR is not handed to the trigger, or undefined when one of its environments has no Run on its head. */
    private async leaveAlone(target: Target, pr: OpenPullRequestSummary, now: Date): Promise<ReconcilerSkip | undefined> {
        if (pr.draft === true) return 'draft';
        const updated = Date.parse(pr.updatedAt ?? '');
        if (!Number.isFinite(updated)) return 'no_updated_at';
        if (updated > now.getTime() - this.config.graceMs) return 'too_recent';
        const answerable = [...target.floors].filter(([, floor]) => updated >= floor).map(([environmentId]) => environmentId);
        if (!answerable.length) return 'outside_window';
        let runs;
        try {
            runs = await this.runs.list({ organizationId: target.organizationId, repositoryId: target.repositoryId, prNumber: pr.number, limit: RUNS_PER_PULL_REQUEST });
        } catch {
            return 'runs_unreadable';
        }
        // Any Run on the head counts, whatever its state: a Run cancelled on purpose is never started again.
        const ran = (environmentId: string) => runs.some((r) => r.environmentId === environmentId && r.headSha === pr.headSha);
        return answerable.every(ran) ? 'already_ran' : undefined;
    }

    /** Hands the head to the trigger as the webhook would have; the Runs it started. */
    private async hand(target: Target, pr: OpenPullRequestSummary, key: ReconciledHeadKey, attempt: number, now: Date): Promise<number> {
        const event: RuntimePullRequestObserved = {
            organizationId: target.organizationId,
            teamId: target.teamId,
            repository: { id: target.repositoryId, name: target.repositoryName },
            prNumber: pr.number,
            // A push: the decision reads every fact from the Git API, never from this event (ADR-057).
            event: 'synchronize',
            headSha: pr.headSha,
            labels: [],
            observedAt: now.toISOString(),
        };
        const metadata = { organizationId: key.organizationId, repositoryId: key.repositoryId, prNumber: key.prNumber, headSha: key.headSha, attempt };
        let outcome: TriggerOutcome;
        try {
            // This line logs the trigger's failure, with the attempt: the trigger does not log it too.
            outcome = await this.trigger.execute(event, { reportFailures: false });
        } catch (error) {
            // A failure the ledger could not record leaves the claim to be taken over once stale; the line below says which.
            const failureRecorded = await this.ledger.fail(key, attempt, error instanceof Error ? error.name : 'error').then(
                () => true,
                () => false,
            );
            this.metrics.handed('failed');
            this.logger.warn({
                message: 'Runtime reconciler: the trigger failed on a head; it is tried again on a later tick',
                context: RuntimeWebhookReconciler.name,
                error: error instanceof Error ? error : undefined,
                metadata: { ...metadata, failureRecorded },
            });
            return 0;
        }
        const label = outcomeLabel(outcome);
        await this.ledger.settle(key, attempt, label);
        const started = startedIn(outcome);
        this.metrics.handed(label);
        this.metrics.started(started, key.organizationId);
        this.logger.log({
            message: started > 0 ? 'Runtime reconciler: started a Run a webhook did not' : 'Runtime reconciler: a head without a Run, and the trigger started none',
            context: RuntimeWebhookReconciler.name,
            metadata: { ...metadata, outcome: label, started },
        });
        return started;
    }
}
