import { ConflictException, Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import {
    RUNTIME_SKIPPED_TRIGGER_REPLY_TOKEN,
    type SkippedTriggerReplyOutcome,
    type SkippedTriggerReplyPublisher,
} from '@libs/runtime-publish/application/skipped-trigger-reply';
import { isAnsweredSkip, type SkippedSetupState } from '@libs/runtime-publish/domain/render-skipped-trigger';
import { RuntimePullRequestObservedSchema, type RuntimePullRequestObserved } from '@libs/runtime/run';

import { deterministicUuid } from '../../domain/deterministic-id';
import { decideForkRun } from '../../domain/fork-policy';
import { decideRun, type RepositoryTriggerSettings } from '../../domain/trigger-rules';
import { ASKED_RUNS_REACHED_DETAIL, askedRunsReached } from '../asked-runs';
import { membersOr, RuntimeEnvironmentMembers, type EnvironmentMembership } from '../environment-members.service';
import type { RuntimePoolController } from '../pool-controller.service';
import {
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RELEASE_GATE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_SETTINGS_STORE,
    repositoryAccessProblemOf,
    type ProductEnvironmentStore,
    type PullRequestDiff,
    type PullRequestHead,
    type RepositoryAccessProblem,
    type RunProjectionReader,
    type RuntimeEnvironmentSetupReader,
    type RuntimeReleaseGate,
    type RuntimeGitPort,
    type RuntimeRepositorySettingsRecord,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import { RuntimeRunRequestBuilder } from '../run-request-builder.service';
import { RuntimeRunEnqueuer } from '../runtime-run-enqueuer.service';

/** Coding agents that open PRs under their own account; bots end in [bot]. */
const AGENT_LOGINS = /^(devin-ai-integration|copilot-swe-agent|claude|codex|cursor|sweep-ai|openhands-agent|google-labs-jules)(\[bot\])?$/i;

/** Whether the PR's author (as the Git API names it) is a bot or a coding agent. */
export const isAgentAuthor = (head: Pick<PullRequestHead, 'authorLogin' | 'authorIsBot'>) => {
    const login = head.authorLogin ?? '';
    return head.authorIsBot === true || /\[bot\]$/i.test(login) || AGENT_LOGINS.test(login);
};

export type TriggerOutcome =
    | { action: 'enqueued'; runId: string; trigger: 'pull_request' | 'comment' }
    | { action: 'cancelled'; reason: 'pr_closed' | 'superseded' }
    /** `setup`: for `environment_not_ready`, where the environment's setup stands. */
    | { action: 'skipped'; reason: string; detail?: string; setup?: SkippedSetupState }
    /** A repository in several environments that trigger on it: one outcome per environment. */
    | { action: 'per_environment'; outcomes: Array<EnvironmentOutcome & { environmentId: string }> };

type EnvironmentOutcome = Exclude<TriggerOutcome, { action: 'per_environment' } | { action: 'cancelled' }>;

/**
 * How often a PR event on a repository whose PR read came back empty may ask
 * the provider whether the connection still reads it, and so how often the
 * warning that it does not is logged, per organization and repository and per
 * process.
 */
export const UNREADABLE_REPOSITORY_WARNING_WINDOW_MS = 30 * 60_000;

/** At most this many remembered repositories: past it, the ones whose window ended, then the oldest, are forgotten. */
const UNREADABLE_REPOSITORY_KEYS_MAX = 1_000;

type Repo = { repositoryId: string; repositoryName: string };
type OrgTeam = { organizationId: string; teamId: string };

/** What the decision read, kept for the answer to a skipped `@kody runtime`. */
interface DecisionFacts {
    orgTeam?: OrgTeam;
    repo?: Repo;
    head?: PullRequestHead | null;
    repoSettings?: RuntimeRepositorySettingsRecord;
    settingsRead?: boolean;
    /** The commenter's permission, once the decision checked it. */
    commenterAllowed?: boolean;
}

/**
 * PR 2: a pull request event becomes a Run, or not. The webhook event only
 * says that something happened; every fact the decision reads (the head, its
 * state, draft, labels, author, the diff, the commenter's permission) comes
 * from the Git API (ADR-057), so a late or out-of-order event can neither
 * cancel the Run of the real head nor start one on a stale fact. A closed PR
 * and a moved head cancel the Runs still live on an older head. A Run starts
 * only on an environment whose setup is ready, once per head unless someone
 * asks again with `@kody runtime`. The runId is derived from what the Run is
 * for, so a redelivered event enqueues the same Run. A `@kody runtime` that
 * starts nothing is answered on the PR with why, once per PR, head and reason,
 * and only to someone who may ask (render-skipped-trigger.ts). A Git
 * connection that cannot serve the repository (RepositoryAccessProblem) is a
 * decision, not a failure: answered when the connection can still post, else
 * logged once, and never retried. A PR event is never answered, so a PR read
 * that came back empty on a connection that no longer reads the repository is
 * logged, at most once per window per repository (warnIfUnreadable).
 */
@Injectable()
export class RuntimePullRequestTriggerUseCase {
    private readonly logger = createLogger(RuntimePullRequestTriggerUseCase.name);
    /** When each organization's repository last asked for its read diagnosis after an empty PR read on a PR event. */
    private readonly unreadableAsked = new Map<string, number>();

    constructor(
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: Pick<RuntimeSettingsStore, 'listRepositories'>,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'findByRepository'>,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: Pick<RunProjectionReader, 'findLive' | 'list'>,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: Pick<RuntimeGitPort, 'getPullRequestHead' | 'getPullRequestDiff' | 'userCanWrite' | 'isOrganizationMember' | 'repositoryReadAccess'>,
        private readonly requests: RuntimeRunRequestBuilder,
        private readonly enqueuer: RuntimeRunEnqueuer,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups: RuntimeEnvironmentSetupReader,
        @Optional()
        private readonly pool?: Pick<RuntimePoolController, 'onPullRequest'>,
        // Required by Nest; a use case made without it (the older tests) reads the environment the repository is the primary of.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
        // The worker's product publisher; absent, a skipped comment is only logged.
        @Optional()
        @Inject(RUNTIME_SKIPPED_TRIGGER_REPLY_TOKEN)
        private readonly skipReplies?: Pick<SkippedTriggerReplyPublisher, 'answer'>,
        // Required by Nest; a use case made without it starts nothing (fails closed).
        @Inject(RUNTIME_RELEASE_GATE)
        private readonly release?: RuntimeReleaseGate,
    ) {}

    /**
     * The message as RabbitMQ hands it (the outbox envelope) or the bare payload.
     * `reportFailures: false` is for a caller that logs the failure it is thrown
     * (the reconciler): a store the decision cannot read is then logged once, by it.
     * `closeOnlyWhenConfirmed` is for a `closed` no platform sent (the session
     * sweep): it stops the PR only when the Git API says closed or merged, and a
     * PR it cannot read (a rate limit, a 5xx, a network error) is `pr_state_unknown`.
     */
    async execute(message: unknown, opts: { reportFailures?: boolean; closeOnlyWhenConfirmed?: boolean } = {}): Promise<TriggerOutcome> {
        const raw = (message as { payload?: unknown })?.payload ?? message;
        const { workflowType: _ignored, ...rest } = (raw ?? {}) as Record<string, unknown>;
        const parsed = RuntimePullRequestObservedSchema.safeParse(rest);
        if (!parsed.success) {
            // A malformed event never becomes valid on a retry: drop it here instead of dead-lettering it five times.
            this.logger.warn({
                message: 'Runtime trigger: invalid event dropped',
                context: RuntimePullRequestTriggerUseCase.name,
                metadata: { issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`) },
            });
            return { action: 'skipped', reason: 'invalid_event' };
        }
        const ev = parsed.data;
        // The Runtime is an alpha in the feature catalog: an org it is not released to starts nothing and
        // hears nothing, a `@kody runtime` included (no answer advertises it). A close still goes through,
        // so the Runs it accepted before stop with their PR.
        if (ev.event !== 'closed' && !(await this.release?.isEnabledFor(ev.organizationId))) {
            this.logger.log({
                message: 'Runtime trigger: skipped',
                context: RuntimePullRequestTriggerUseCase.name,
                metadata: { organizationId: ev.organizationId, repositoryId: ev.repository.id, prNumber: ev.prNumber, event: ev.event, reason: 'not_enabled' },
            });
            return { action: 'skipped', reason: 'not_enabled' };
        }
        const facts: DecisionFacts = {};
        let outcome: TriggerOutcome;
        try {
            outcome = await this.decide(ev, facts, opts.closeOnlyWhenConfirmed === true);
        } catch (error) {
            // The broker's consumer and retry handler log only the error's message: the ids are logged here.
            if (error instanceof TriggerReadFailure && opts.reportFailures !== false) {
                this.logger.warn({
                    message: error.message,
                    context: RuntimePullRequestTriggerUseCase.name,
                    error: error.cause instanceof Error ? error.cause : undefined,
                    metadata: error.metadata,
                });
            }
            throw error;
        }
        if (ev.event !== 'comment' && ev.event !== 'closed' && hasSkipReason(outcome, 'pr_not_found')) {
            await this.warnIfUnreadable(ev, facts);
        }
        const metadata = { organizationId: ev.organizationId, repositoryId: ev.repository.id, prNumber: ev.prNumber, event: ev.event, ...outcome };
        let reply: SkippedTriggerReplyOutcome['outcome'] | 'not_posted' | undefined;
        try {
            reply = ev.event === 'comment' ? await this.answerSkipped(ev, outcome, facts) : undefined;
        } catch (error) {
            // The broker retries the event: the decision is idempotent and the answer's key posts it once.
            // Logged here, with the event's ids: the broker's consumer and retry handler log only the error's message.
            if (opts.reportFailures !== false) {
                this.logger.warn({
                    message: 'Runtime trigger: the answer to a skipped comment was not posted; retrying',
                    context: RuntimePullRequestTriggerUseCase.name,
                    error: error instanceof Error ? error : undefined,
                    metadata,
                });
            }
            throw error;
        }
        this.logger.log({
            message: `Runtime trigger: ${outcome.action}`,
            context: RuntimePullRequestTriggerUseCase.name,
            metadata: { ...metadata, ...(reply ? { reply } : {}) },
        });
        return outcome;
    }

    /**
     * The answer on the PR to a `@kody runtime` that started no Run: the reason
     * of the only environment, or the first answered one when every environment
     * skipped. Only someone who may ask hears why; a stranger gets silence.
     */
    private async answerSkipped(ev: RuntimePullRequestObserved, outcome: TriggerOutcome, facts: DecisionFacts): Promise<SkippedTriggerReplyOutcome['outcome'] | 'not_posted' | undefined> {
        if (!this.skipReplies) return undefined;
        const skipped = answeredSkipOf(outcome);
        if (!skipped) return 'silent';
        const orgTeam = facts.orgTeam ?? { organizationId: ev.organizationId, teamId: ev.teamId };
        const repo = facts.repo ?? { repositoryId: ev.repository.id, repositoryName: ev.repository.name };
        const settings = facts.settingsRead ? facts.repoSettings : (await this.settings.listRepositories(ev.organizationId)).find((r) => r.repositoryId === ev.repository.id);
        const allowed = facts.commenterAllowed ?? (await this.askPermission(settings, ev, orgTeam, repo));
        // The connection is broken: when it cannot even tell who asked, or cannot post, nothing reaches the PR.
        // One warning, and the event is done: a retry meets the same connection.
        const broken = isAccessProblem(skipped.reason);
        if (broken && allowed === undefined) return this.notPosted(ev, skipped.reason, 'commenter_permission');
        if (allowed !== true) return 'silent';
        const request = {
            organizationId: ev.organizationId,
            teamId: orgTeam.teamId,
            repositoryId: ev.repository.id,
            prNumber: ev.prNumber,
            headSha: facts.head?.headSha ?? ev.headSha,
            reason: skipped.reason,
            ...(skipped.setup ? { setup: skipped.setup } : {}),
        };
        try {
            return (await this.skipReplies.answer(request)).outcome;
        } catch (error) {
            // Any other answer is retried by the broker (execute); a broken connection's is not.
            if (!broken) throw error;
            return this.notPosted(ev, skipped.reason, 'post', error);
        }
    }

    /** The one log of an answer the broken Git connection could not carry; never the platform's message. */
    private notPosted(ev: RuntimePullRequestObserved, reason: string, step: 'commenter_permission' | 'post', error?: unknown): 'not_posted' {
        this.logger.warn({
            message: 'Runtime trigger: the Git connection cannot serve this repository and the comment is not answered; an admin must fix the connection',
            context: RuntimePullRequestTriggerUseCase.name,
            metadata: {
                organizationId: ev.organizationId,
                repositoryId: ev.repository.id,
                prNumber: ev.prNumber,
                reason,
                step,
                ...(error !== undefined ? { errorName: error instanceof Error ? error.name : 'error' } : {}),
            },
        });
        return 'not_posted';
    }

    /**
     * A PR event whose PR read came back empty: when the connection no longer
     * reads the repository, an operator must see it, since nothing is answered
     * on a PR event. The provider is asked at most once per window per
     * repository, and the warning carries ids and the reason only.
     */
    private async warnIfUnreadable(ev: RuntimePullRequestObserved, facts: DecisionFacts): Promise<void> {
        if (facts.head !== null || !facts.orgTeam || !facts.repo) return;
        const key = `${ev.organizationId}:${ev.repository.id}`;
        const now = Date.now();
        const asked = this.unreadableAsked.get(key);
        if (asked !== undefined && now - asked < UNREADABLE_REPOSITORY_WARNING_WINDOW_MS) return;
        if (this.unreadableAsked.size >= UNREADABLE_REPOSITORY_KEYS_MAX) {
            for (const [k, at] of this.unreadableAsked) if (now - at >= UNREADABLE_REPOSITORY_WARNING_WINDOW_MS) this.unreadableAsked.delete(k);
            // Still full inside the window: the oldest one is forgotten, at worst asked once more.
            if (this.unreadableAsked.size >= UNREADABLE_REPOSITORY_KEYS_MAX) this.unreadableAsked.delete(this.unreadableAsked.keys().next().value as string);
        }
        this.unreadableAsked.set(key, now);
        if ((await this.readAccessOf(facts.orgTeam, facts.repo)) !== 'denied') return;
        this.logger.warn({
            message: 'Runtime trigger: the Git connection cannot read this repository; its PR events end as pr_not_found until an admin fixes the connection',
            context: RuntimePullRequestTriggerUseCase.name,
            metadata: {
                organizationId: ev.organizationId,
                repositoryId: ev.repository.id,
                prNumber: ev.prNumber,
                event: ev.event,
                reason: 'repository_unreachable' satisfies RepositoryAccessProblem,
            },
        });
    }

    private async decide(ev: RuntimePullRequestObserved, facts: DecisionFacts, closeOnlyWhenConfirmed = false): Promise<TriggerOutcome> {
        const key = { organizationId: ev.organizationId, repositoryId: ev.repository.id, prNumber: ev.prNumber };
        // Every environment the repository is part of, the one it is the primary of first (membership).
        const memberships = await membersOr(this.members, this.environments).environmentsOf(ev.organizationId, ev.repository.id);
        const first = memberships[0];
        const orgTeam: OrgTeam | undefined = first ? { organizationId: ev.organizationId, teamId: first.env.teamId } : undefined;
        const repo: Repo | undefined = first ? { repositoryId: ev.repository.id, repositoryName: first.member.repositoryName } : undefined;
        const head = orgTeam && repo ? await this.git.getPullRequestHead({ ...orgTeam, ...repo, prNumber: ev.prNumber }) : null;
        Object.assign(facts, { orgTeam, repo, head });
        // Someone asked and the PR read came back empty: a connection that cannot read the repository at all
        // is what the admin must fix, before anything the settings or the environment would say.
        if (!head && ev.event === 'comment' && orgTeam && repo && (await this.readAccessOf(orgTeam, repo)) === 'denied') {
            return { action: 'skipped', reason: 'repository_unreachable' satisfies RepositoryAccessProblem };
        }

        // Cancellation does not depend on the mode: a Run asked by hand stops with its PR too.
        // The PR's state and head come from the Git API, never from the event.
        const live = await this.runs.findLive(key);
        if (head?.state && head.state !== 'open') {
            if (!live.length) {
                // Nothing to stop, but its Runs' previews end with it (docs/runtime/preview-urls.md §5.2), and the
                // sessions that hold its code are removed from their cells (pr-sessions.ts).
                if (ev.event === 'closed') await this.enqueuer.cancel({ ...key, reason: 'pr_closed' });
                return { action: 'skipped', reason: ev.event === 'closed' ? 'nothing_live' : 'pr_not_open' };
            }
            await this.enqueuer.cancel({ ...key, reason: 'pr_closed' });
            return { action: 'cancelled', reason: 'pr_closed' };
        }
        if (ev.event === 'closed') {
            // The API says the PR is open again: a late `closed` cancels nothing.
            if (head) return { action: 'skipped', reason: 'pr_still_open' };
            // A close nobody sent (the sweep) acts only on the API's word: an unread PR may well be open.
            if (closeOnlyWhenConfirmed) return { action: 'skipped', reason: 'pr_state_unknown' };
            // The platform sent the close and the API could not say: stopping machines on a PR that may be
            // closed is the safe side (previews too).
            if (!live.length) {
                await this.enqueuer.cancel({ ...key, reason: 'pr_closed' });
                return { action: 'skipped', reason: 'nothing_live' };
            }
            await this.enqueuer.cancel({ ...key, reason: 'pr_closed' });
            return { action: 'cancelled', reason: 'pr_closed' };
        }
        if (head && live.some((r) => r.headSha !== head.headSha)) {
            await this.enqueuer.cancel({ ...key, reason: 'superseded', headSha: head.headSha });
        }

        const settingsRows = await this.settings.listRepositories(ev.organizationId);
        const settingsOf = (repositoryId: string) => settingsRows.find((r) => r.repositoryId === repositoryId);
        const repoSettings = settingsOf(ev.repository.id);
        Object.assign(facts, { repoSettings, settingsRead: true });
        if (!orgTeam || !repo) return { action: 'skipped', reason: triggerSettings(repoSettings).mode === 'off' ? 'off' : 'no_environment' };
        // One Run per environment whose membership of this repository triggers.
        const triggering = memberships.filter((m) => m.member.triggers);
        if (!triggering.length) return { action: 'skipped', reason: 'not_triggering' };

        // The diff is the PR's, the same for every environment: read once.
        let diff: PullRequestDiff | undefined;
        const diffOf = async (o: OrgTeam, h: PullRequestHead) =>
            (diff ??= await this.git.getPullRequestDiff({ ...o, ...repo, prNumber: ev.prNumber, headSha: h.headSha }));
        const outcomes: Array<EnvironmentOutcome & { environmentId: string }> = [];
        for (const membership of triggering) {
            // When an environment runs is its primary's settings: a member's own row governs only the environment it is the primary of.
            const outcome = await this.decideFor(ev, membership, head, settingsOf(membership.env.repositoryId), diffOf, facts);
            outcomes.push({ ...outcome, environmentId: membership.env.environmentId });
        }
        if (outcomes.length === 1) {
            const { environmentId: _id, ...only } = outcomes[0];
            return only as EnvironmentOutcome;
        }
        return { action: 'per_environment', outcomes };
    }

    /** Whether this environment runs on the PR's head, and its Run when it does. */
    private async decideFor(
        ev: RuntimePullRequestObserved,
        { env, member }: EnvironmentMembership,
        head: PullRequestHead | null,
        envSettings: RuntimeRepositorySettingsRecord | undefined,
        diffOf: (orgTeam: OrgTeam, head: PullRequestHead) => Promise<PullRequestDiff>,
        facts: DecisionFacts,
    ): Promise<EnvironmentOutcome> {
        const trigger = triggerSettings(envSettings);
        // A member's PR in an environment whose primary is off: the environment is off, not the member.
        if (trigger.mode === 'off') return { action: 'skipped', reason: member.role === 'primary' ? 'off' : 'environment_off' };
        const key = { organizationId: ev.organizationId, repositoryId: ev.repository.id, prNumber: ev.prNumber };
        const orgTeam: OrgTeam = { organizationId: ev.organizationId, teamId: env.teamId };
        const repo: Repo = { repositoryId: ev.repository.id, repositoryName: member.repositoryName };
        const ofThis = <T extends { environmentId: string }>(runs: T[]) => runs.filter((r) => r.environmentId === env.environmentId);
        // A store that cannot be read is not an environment that is not ready: the event fails and is
        // retried (the broker's backoff, or the reconciler's ledger), and the head is never settled on it.
        const setup = await this.setups.get(ev.organizationId, env.environmentId).catch((error: unknown) => {
            throw new TriggerReadFailure(
                'Runtime trigger: the environment setup could not be read; the event is retried',
                { organizationId: ev.organizationId, environmentId: env.environmentId, repositoryId: ev.repository.id, prNumber: ev.prNumber },
                error,
            );
        });
        if (setup?.state !== 'active') return { action: 'skipped', reason: 'environment_not_ready', setup: setupStateOf(setup) };
        // An open PR's event restarts the pool's warm-up (domain/pool.ts onPullRequest). A pool
        // failure never stops the Run: the scheduler catches up within its tick. A fork's
        // event never warms machines: forks run on the fork budget, without the pool (ADR-030).
        if (head?.fork !== true) {
            await this.pool?.onPullRequest(env).catch((error: unknown) =>
                this.logger.error({ message: 'Runtime trigger: pool warm-up failed', context: RuntimePullRequestTriggerUseCase.name, error: error instanceof Error ? error : undefined }),
            );
        }
        if (!head) return { action: 'skipped', reason: 'pr_not_found' };
        // A fork's code runs per the environment's policy (ADR-030): skipped, held for a
        // maintainer's approval of this head (the worker's gate; the approval mints fresh
        // tokens), or started at once. `head.fork` compares the Git API's repo ids (ADR-057).
        const fork = decideForkRun(env.forkPullRequests, head);
        if (fork.start === false) return { action: 'skipped', reason: fork.reason };

        let diff: PullRequestDiff | undefined;
        if (ev.event === 'comment') {
            const allowed = (await this.askPermission(envSettings, ev, orgTeam, repo)) === true;
            facts.commenterAllowed ??= allowed;
            if (!allowed) return { action: 'skipped', reason: 'commenter_not_allowed' };
            // One count with the Runs asked from Kodus (Run again, Run on this PR).
            if (await askedRunsReached(this.runs, key, env.environmentId)) {
                return { action: 'skipped', reason: 'comment_runs_per_day_reached', detail: ASKED_RUNS_REACHED_DETAIL };
            }
        } else {
            if (head.draft === true) return { action: 'skipped', reason: 'draft' };
            const before = ofThis(await this.runs.list({ ...key, limit: 50 }));
            if (before.some((r) => r.headSha === head.headSha)) return { action: 'skipped', reason: 'already_ran_on_head' };
            diff = await diffOf(orgTeam, head);
            const decision = decideRun(trigger, {
                changedPaths: diff.files.map((d) => d.path),
                changedPathsTruncated: diff.truncated,
                labels: head.labels ?? [],
                authorIsAgent: isAgentAuthor(head),
                // The Runtime already ran on another head of this PR.
                isNewPush: before.some((r) => r.headSha !== head.headSha),
            });
            if (decision.run === false) return { action: 'skipped', reason: decision.reason };
        }

        if (ofThis(await this.runs.findLive(key)).some((r) => r.headSha === head.headSha)) return { action: 'skipped', reason: 'already_running' };

        const triggerKind = ev.event === 'comment' ? 'comment' : 'pull_request';
        // The environment the repository is the primary of keeps the id it always had; another one adds its own id.
        const scope = member.role === 'primary' ? [] : [env.environmentId];
        const runId =
            triggerKind === 'pull_request'
                ? deterministicUuid('pull_request', ev.organizationId, ev.repository.id, ev.prNumber, head.headSha, ...scope)
                : deterministicUuid('comment', ev.organizationId, ev.repository.id, ev.prNumber, head.headSha, ev.commentId ?? `${ev.observedAt}:${ev.commenter?.id ?? ev.commenter?.login ?? ''}`, ...scope);
        let request;
        try {
            request = await this.requests.build({
                env,
                ...(member.role === 'member' ? { repository: { repositoryId: member.repositoryId, repositoryName: member.repositoryName, fullName: member.fullName } } : {}),
                prNumber: ev.prNumber,
                head,
                trigger: triggerKind,
                diff,
                runId,
                ...(fork.fork ? { forkApprovalRequired: fork.approvalRequired } : {}),
                ...(ev.traceparent ? { traceparent: ev.traceparent } : {}),
            });
        } catch (e) {
            // A repository of the environment Kodus cannot pin never becomes valid on a retry of this event.
            if (e instanceof ConflictException) return { action: 'skipped', reason: 'workspace_unresolved', detail: e.message };
            // Nor does a Git connection that cannot give the Runtime its download token (a PAT, no App installation).
            const problem = repositoryAccessProblemOf(e);
            if (problem) return { action: 'skipped', reason: problem };
            throw e;
        }
        await this.enqueuer.enqueue(request);
        return { action: 'enqueued', runId: request.runId, trigger: triggerKind };
    }

    /**
     * `@kody runtime`: who may ask (screen 2). Writers and maintainers are
     * checked on the Git API; "anyone in the org" is checked as membership of
     * the integration's org. undefined when the platform could not say (an
     * unknown answer, or a failed call), which denies.
     */
    private async askPermission(settings: RuntimeRepositorySettingsRecord | undefined, ev: RuntimePullRequestObserved, orgTeam: OrgTeam, repo: Repo): Promise<boolean | undefined> {
        const who = settings?.whoCanAsk ?? 'writers';
        if (!ev.commenter?.id && !ev.commenter?.login) return false;
        const identity = { id: ev.commenter.id, login: ev.commenter.login };
        // Denied either way; logged by class only, never the platform's message.
        const failed = (check: string) => (error: unknown) => {
            this.logger.warn({
                message: 'Runtime trigger: the Git API did not answer who may ask; the comment is denied',
                context: RuntimePullRequestTriggerUseCase.name,
                metadata: { organizationId: ev.organizationId, repositoryId: repo.repositoryId, prNumber: ev.prNumber, check, errorName: error instanceof Error ? error.name : 'error' },
            });
            return undefined;
        };
        if (who === 'anyone_in_org') {
            return this.git.isOrganizationMember({ ...orgTeam, identity }).catch(failed('organization_member'));
        }
        return this.git.userCanWrite({ ...orgTeam, ...repo, identity }).catch(failed('can_write'));
    }

    /** What the integration's own credential can do on the repository; unknown when the port cannot say or fails. */
    private async readAccessOf(orgTeam: OrgTeam, repo: Repo): Promise<'ok' | 'denied' | 'unknown'> {
        if (!this.git.repositoryReadAccess) return 'unknown';
        return this.git.repositoryReadAccess({ ...orgTeam, ...repo }).catch(() => 'unknown' as const);
    }
}

type SkippedOutcome = Extract<TriggerOutcome, { action: 'skipped' }>;

const ACCESS_PROBLEMS: ReadonlySet<string> = new Set<RepositoryAccessProblem>(['repository_unreachable', 'pat_connection']);

/** Whether a skip reason is the Git connection itself, which no retry fixes. */
const isAccessProblem = (reason: string) => ACCESS_PROBLEMS.has(reason);

/** Whether the outcome, or any environment's, is skipped for that reason. */
function hasSkipReason(outcome: TriggerOutcome, reason: string): boolean {
    if (outcome.action === 'skipped') return outcome.reason === reason;
    return outcome.action === 'per_environment' && outcome.outcomes.some((o) => o.action === 'skipped' && o.reason === reason);
}

/** The skip a comment is answered with: the only environment's, or the first answered one when no environment started a Run. */
function answeredSkipOf(outcome: TriggerOutcome): SkippedOutcome | undefined {
    if (outcome.action === 'skipped') return isAnsweredSkip(outcome.reason) ? outcome : undefined;
    if (outcome.action !== 'per_environment' || outcome.outcomes.some((o) => o.action !== 'skipped')) return undefined;
    return outcome.outcomes.find((o): o is SkippedOutcome & { environmentId: string } => o.action === 'skipped' && isAnsweredSkip(o.reason));
}

/** A store the decision could not read: thrown so the event is retried, never decided on a guess. */
export class TriggerReadFailure extends Error {
    override readonly name = 'TriggerReadFailure';

    constructor(
        message: string,
        readonly metadata: Record<string, string | number>,
        cause: unknown,
    ) {
        super(message);
        this.cause = cause;
    }
}

/** Where a setup that is not active stands, as the answer to a skipped comment words it. */
function setupStateOf(setup: { state: string } | null): SkippedSetupState {
    if (setup === null) return 'not_set_up';
    return setup.state === 'blocked' ? 'blocked' : setup.state === 'setting_up' ? 'setting_up' : 'unknown';
}

/** Settings rows written before the mode existed: in the pilot means on request. */
function triggerSettings(r: RuntimeRepositorySettingsRecord | undefined): RepositoryTriggerSettings {
    return {
        mode: r?.mode ?? (r?.pilot ? 'on_request' : 'off'),
        rules: r?.rules ?? [],
        runOnAgentPullRequests: r?.runOnAgentPullRequests ?? false,
        runOnNewPushes: r?.runOnNewPushes ?? false,
    };
}
