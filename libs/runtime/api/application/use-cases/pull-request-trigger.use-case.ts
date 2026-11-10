import { Inject, Injectable, Optional } from '@nestjs/common';

import { createLogger } from '@libs/core/log/logger';
import { RuntimePullRequestObservedSchema, type RuntimePullRequestObserved } from '@libs/runtime/run';

import { deterministicUuid } from '../../domain/deterministic-id';
import { decideForkRun } from '../../domain/fork-policy';
import { decideRun, type RepositoryTriggerSettings } from '../../domain/trigger-rules';
import type { RuntimePoolController } from '../pool-controller.service';
import {
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_SETTINGS_STORE,
    type ProductEnvironmentStore,
    type PullRequestHead,
    type RunProjectionReader,
    type RuntimeEnvironmentSetupReader,
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
    | { action: 'skipped'; reason: string };

type Repo = { repositoryId: string; repositoryName: string };
type OrgTeam = { organizationId: string; teamId: string };

/**
 * PR 2: a pull request event becomes a Run, or not. The webhook event only
 * says that something happened; every fact the decision reads (the head, its
 * state, draft, labels, author, the diff, the commenter's permission) comes
 * from the Git API (ADR-057), so a late or out-of-order event can neither
 * cancel the Run of the real head nor start one on a stale fact. A closed PR
 * and a moved head cancel the Runs still live on an older head. A Run starts
 * only on an environment whose setup is ready, once per head unless someone
 * asks again with `@kody runtime`. The runId is derived from what the Run is
 * for, so a redelivered event enqueues the same Run.
 */
@Injectable()
export class RuntimePullRequestTriggerUseCase {
    private readonly logger = createLogger(RuntimePullRequestTriggerUseCase.name);

    constructor(
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: Pick<RuntimeSettingsStore, 'listRepositories'>,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'findByRepository'>,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: Pick<RunProjectionReader, 'findLive' | 'list'>,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: Pick<RuntimeGitPort, 'getPullRequestHead' | 'getPullRequestDiff' | 'userCanWrite' | 'isOrganizationMember'>,
        private readonly requests: RuntimeRunRequestBuilder,
        private readonly enqueuer: RuntimeRunEnqueuer,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups: RuntimeEnvironmentSetupReader,
        @Optional()
        private readonly pool?: Pick<RuntimePoolController, 'onPullRequest'>,
    ) {}

    /** The message as RabbitMQ hands it (the outbox envelope) or the bare payload. */
    async execute(message: unknown): Promise<TriggerOutcome> {
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
        const outcome = await this.decide(ev);
        this.logger.log({
            message: `Runtime trigger: ${outcome.action}`,
            context: RuntimePullRequestTriggerUseCase.name,
            metadata: { organizationId: ev.organizationId, repositoryId: ev.repository.id, prNumber: ev.prNumber, event: ev.event, ...outcome },
        });
        return outcome;
    }

    private async decide(ev: RuntimePullRequestObserved): Promise<TriggerOutcome> {
        const key = { organizationId: ev.organizationId, repositoryId: ev.repository.id, prNumber: ev.prNumber };
        const env = await this.environments.findByRepository(ev.organizationId, ev.repository.id);
        const orgTeam: OrgTeam | undefined = env ? { organizationId: ev.organizationId, teamId: env.teamId } : undefined;
        const repo: Repo | undefined = env ? { repositoryId: env.repositoryId, repositoryName: env.repositoryName } : undefined;
        const head = orgTeam && repo ? await this.git.getPullRequestHead({ ...orgTeam, ...repo, prNumber: ev.prNumber }) : null;

        // Cancellation does not depend on the mode: a Run asked by hand stops with its PR too.
        // The PR's state and head come from the Git API, never from the event.
        const live = await this.runs.findLive(key);
        if (head?.state && head.state !== 'open') {
            if (!live.length) return { action: 'skipped', reason: ev.event === 'closed' ? 'nothing_live' : 'pr_not_open' };
            await this.enqueuer.cancel({ ...key, reason: 'pr_closed' });
            return { action: 'cancelled', reason: 'pr_closed' };
        }
        if (ev.event === 'closed') {
            // The API says the PR is open again: a late `closed` cancels nothing.
            if (head) return { action: 'skipped', reason: 'pr_still_open' };
            // The API could not say: stopping machines on a PR that may be closed is the safe side.
            if (!live.length) return { action: 'skipped', reason: 'nothing_live' };
            await this.enqueuer.cancel({ ...key, reason: 'pr_closed' });
            return { action: 'cancelled', reason: 'pr_closed' };
        }
        if (head && live.some((r) => r.headSha !== head.headSha)) {
            await this.enqueuer.cancel({ ...key, reason: 'superseded', headSha: head.headSha });
        }

        const repoSettings = (await this.settings.listRepositories(ev.organizationId)).find((r) => r.repositoryId === ev.repository.id);
        const trigger = triggerSettings(repoSettings);
        if (trigger.mode === 'off') return { action: 'skipped', reason: 'off' };
        if (!env || !orgTeam || !repo) return { action: 'skipped', reason: 'no_environment' };
        const setup = await this.setups.get(ev.organizationId, env.environmentId).catch(() => null);
        if (setup?.state !== 'active') return { action: 'skipped', reason: 'environment_not_ready' };
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

        let diff: Awaited<ReturnType<RuntimeGitPort['getPullRequestDiff']>> | undefined;
        if (ev.event === 'comment') {
            if (!(await this.mayAsk(repoSettings, ev, orgTeam, repo))) return { action: 'skipped', reason: 'commenter_not_allowed' };
        } else {
            if (head.draft === true) return { action: 'skipped', reason: 'draft' };
            const before = await this.runs.list({ ...key, limit: 50 });
            if (before.some((r) => r.headSha === head.headSha)) return { action: 'skipped', reason: 'already_ran_on_head' };
            diff = await this.git.getPullRequestDiff({ ...orgTeam, ...repo, prNumber: ev.prNumber, headSha: head.headSha });
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

        if ((await this.runs.findLive(key)).some((r) => r.headSha === head.headSha)) return { action: 'skipped', reason: 'already_running' };

        const triggerKind = ev.event === 'comment' ? 'comment' : 'pull_request';
        const runId =
            triggerKind === 'pull_request'
                ? deterministicUuid('pull_request', ev.organizationId, ev.repository.id, ev.prNumber, head.headSha)
                : deterministicUuid('comment', ev.organizationId, ev.repository.id, ev.prNumber, head.headSha, ev.commentId ?? `${ev.observedAt}:${ev.commenter?.id ?? ev.commenter?.login ?? ''}`);
        const request = await this.requests.build({
            env,
            prNumber: ev.prNumber,
            head,
            trigger: triggerKind,
            diff,
            runId,
            ...(fork.fork ? { forkApprovalRequired: fork.approvalRequired } : {}),
        });
        await this.enqueuer.enqueue(request);
        return { action: 'enqueued', runId: request.runId, trigger: triggerKind };
    }

    /**
     * `@kody runtime`: who may ask (screen 2). Writers and maintainers are
     * checked on the Git API; "anyone in the org" is checked as membership of
     * the integration's org. An unknown answer, or a failed call, denies.
     */
    private async mayAsk(settings: RuntimeRepositorySettingsRecord | undefined, ev: RuntimePullRequestObserved, orgTeam: OrgTeam, repo: Repo): Promise<boolean> {
        const who = settings?.whoCanAsk ?? 'writers';
        if (!ev.commenter?.id && !ev.commenter?.login) return false;
        const identity = { id: ev.commenter.id, login: ev.commenter.login };
        if (who === 'anyone_in_org') {
            return (await this.git.isOrganizationMember({ ...orgTeam, identity }).catch(() => undefined)) === true;
        }
        return (await this.git.userCanWrite({ ...orgTeam, ...repo, identity }).catch(() => undefined)) === true;
    }
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
