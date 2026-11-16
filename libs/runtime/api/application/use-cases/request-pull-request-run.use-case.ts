import {
    BadRequestException,
    ConflictException,
    Inject,
    Injectable,
    NotFoundException,
    ServiceUnavailableException,
} from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import { deterministicUuid } from '../../domain/deterministic-id';
import { decideForkRun } from '../../domain/fork-policy';
import {
    RUNTIME_API_CONFIG,
    RUNTIME_ENVIRONMENT_SETUP_READER,
    RUNTIME_GIT_PORT,
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_RUN_PROJECTION_STORE,
    RUNTIME_SETTINGS_STORE,
    type ProductEnvironmentStore,
    type RunProjectionReader,
    type RuntimeApiConfig,
    type RuntimeEnvironmentSetupReader,
    type RuntimeGitPort,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import { repositoryModeOf as modeOf } from '../../domain/trigger-rules';
import { askedRunsReached, askedRunsReachedError } from '../asked-runs';
import { membersOr, RuntimeEnvironmentMembers, type EnvironmentMembership } from '../environment-members.service';
import type { RuntimeAuthorization } from '../run-access.service';
import { RuntimeRunRequestBuilder } from '../run-request-builder.service';
import { RuntimeRunEnqueuer } from '../runtime-run-enqueuer.service';

const ID_MAX = 128;

/** What "Run on this PR" answers when every environment of the repository holds it without running its PRs. */
export const NO_TRIGGERING_ENVIRONMENT = "No environment runs this repository's pull requests: turn on triggers for it in one of its environments";

type PullRequestRunQueued = { runId: string; attempt: number; state: 'queued' };

/**
 * POST /runtime/pull-request-runs/request — "Run on this PR" from the pull
 * requests screens: a Run on the PR's current head, asked by hand. The head,
 * its state and the fork come from the Git API, never from the caller. It
 * needs Create on RuntimeRun for every repository of the environment, an
 * environment whose setup finished (and that triggers on the repository when
 * none is named: 409 otherwise), Kody Runtime not `off` for the environment
 * (its primary's mode; a member's own mode does not count), and the PR under its daily count
 * of Runs asked by hand (shared with `@kody runtime` and Run again: 429). One
 * live Run per head: a second click while it runs is refused; the runId is
 * derived from the head and the attempt, so a repeated request is the same Run.
 */
@Injectable()
export class RequestPullRequestRunUseCase {
    constructor(
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'findByRepository'>,
        @Inject(RUNTIME_ENVIRONMENT_SETUP_READER)
        private readonly setups: RuntimeEnvironmentSetupReader,
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: Pick<RuntimeSettingsStore, 'listRepositories'>,
        @Inject(RUNTIME_RUN_PROJECTION_STORE)
        private readonly runs: Pick<RunProjectionReader, 'findLive' | 'list'>,
        @Inject(RUNTIME_GIT_PORT)
        private readonly git: Pick<RuntimeGitPort, 'getPullRequestHead' | 'getPullRequestDiff'>,
        private readonly requests: RuntimeRunRequestBuilder,
        private readonly enqueuer: RuntimeRunEnqueuer,
        @Inject(RUNTIME_API_CONFIG)
        private readonly config: Pick<RuntimeApiConfig, 'runTokenSecret'>,
        // Required by Nest; made without it (the older tests), a repository's environment is the one it is the primary of.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
    ) {}

    async execute(input: { user: Partial<IUser>; body: unknown }): Promise<PullRequestRunQueued & { runs?: Array<PullRequestRunQueued & { environmentId: string }> }> {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId) throw new NotFoundException('Organization not found');
        const { repositoryId, prNumber, environmentId } = (input.body ?? {}) as { repositoryId?: unknown; prNumber?: unknown; environmentId?: unknown };
        if (typeof repositoryId !== 'string' || repositoryId === '' || repositoryId.length > ID_MAX) {
            throw new BadRequestException('repositoryId is required');
        }
        if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber < 1) {
            throw new BadRequestException('prNumber must be a positive integer');
        }
        if (environmentId !== undefined && (typeof environmentId !== 'string' || environmentId === '' || environmentId.length > ID_MAX)) {
            throw new BadRequestException('environmentId must be an environment id');
        }
        await this.authorization.ensure({ user: input.user, action: Action.Create, resource: ResourceType.RuntimeRun, repoIds: [repositoryId] });
        if (!this.config.runTokenSecret) throw new ServiceUnavailableException('Runtime run token secret is not configured');

        // The environments the repository is part of (membership): the one named, or every one that triggers on its PRs.
        const members = membersOr(this.members, this.environments);
        const found = (await members.environmentsOf(organizationId, repositoryId)).filter((m) => m.env.organizationId === organizationId);
        if (environmentId === undefined && !found.length) throw new NotFoundException('This repository has no Runtime environment');
        const chosen = environmentId === undefined ? found.filter((m) => m.member.triggers) : found.filter((m) => m.env.environmentId === environmentId);
        if (!chosen.length) {
            // The batch says so too (canRequestRun false): every environment holds the repository without running its PRs.
            if (environmentId === undefined) throw new ConflictException(NO_TRIGGERING_ENVIRONMENT);
            throw new NotFoundException('Environment not found');
        }
        // A Run's machine holds the code of every repository of its environment: the caller needs all of them.
        const held = new Map(await Promise.all(chosen.map(async (m) => [m.env.environmentId, await members.list(m.env)] as const)));
        const repoIds = [...new Set([...held.values()].flat().map((r) => r.repositoryId))];
        await this.authorization.ensure({ user: input.user, action: Action.Create, resource: ResourceType.RuntimeRun, repoIds });

        // An environment runs by its primary's mode; a member's own settings govern only the environment it is the primary of.
        const settingsOf = new Map((await this.settings.listRepositories(organizationId)).map((s) => [s.repositoryId, s]));
        const allowed = chosen.filter((m) => modeOf(settingsOf.get(m.env.repositoryId)) !== 'off');
        if (!allowed.length) {
            throw new ConflictException(chosen[0].member.role === 'primary' ? 'Kody Runtime is off for this repository' : 'Kody Runtime is off for this environment');
        }
        const ready: EnvironmentMembership[] = [];
        for (const m of allowed) {
            // A store that cannot be read is not an environment that is not ready: the ask fails as unavailable.
            const setup = await this.setups.get(organizationId, m.env.environmentId).catch(() => {
                throw new ServiceUnavailableException('The environment setup could not be read. Try again.');
            });
            if (setup?.state === 'active') ready.push(m);
        }
        if (!ready.length) throw new ConflictException('The environment is not ready yet');

        const orgTeam = { organizationId, teamId: ready[0].env.teamId };
        const repo = { repositoryId, repositoryName: ready[0].member.repositoryName };
        const head = await this.git.getPullRequestHead({ ...orgTeam, ...repo, prNumber });
        if (!head) throw new NotFoundException('Pull request not found');
        if (head.state && head.state !== 'open') throw new ConflictException('The pull request is not open');

        const key = { organizationId, repositoryId, prNumber };
        const plans: Array<{ m: EnvironmentMembership; fork: Extract<ReturnType<typeof decideForkRun>, { start: true }>; attempt: number; previousRunId?: string }> = [];
        for (const m of ready) {
            const fork = decideForkRun(m.env.forkPullRequests, head);
            if (fork.start === false) {
                if (ready.length === 1) throw new ConflictException("This environment's fork policy skips pull requests from forks");
                continue;
            }
            const ofThis = <T extends { environmentId: string; headSha: string }>(runs: T[]) =>
                runs.filter((r) => r.headSha === head.headSha && (!this.members || r.environmentId === m.env.environmentId));
            const live = ofThis(await this.runs.findLive(key));
            if (live.length > 0) {
                if (ready.length === 1) throw new ConflictException(`Run ${live[0].runId} is still running for this commit`);
                continue;
            }
            // One daily count with `@kody runtime` and Run again, per pull request and environment.
            if (await askedRunsReached(this.runs, key, m.env.environmentId)) {
                if (ready.length === 1) throw askedRunsReachedError();
                continue;
            }
            const sameSha = ofThis(await this.runs.list({ ...key, limit: 200 }));
            const previous = [...sameSha].sort((a, b) => b.attempt - a.attempt)[0];
            plans.push({ m, fork, attempt: Math.max(0, ...sameSha.map((r) => r.attempt)) + 1, ...(previous ? { previousRunId: previous.runId } : {}) });
        }
        if (!plans.length) throw new ConflictException('Every environment of this repository is already running this commit, skips it, or had the Runs asked by hand for today');

        const queued: Array<PullRequestRunQueued & { environmentId: string }> = [];
        for (const { m, fork, attempt, previousRunId } of plans) {
            // Asked again on a head that already ran: the other repositories boot the commits that Run pinned, with fresh tokens.
            const stored = previousRunId ? await this.enqueuer.storedTarget(previousRunId) : null;
            const pinned = stored && stored.organizationId === organizationId && stored.repositoryId === repositoryId ? stored.workspace : undefined;
            const request = await this.requests.build({
                env: m.env,
                ...(pinned?.length ? { workspace: pinned } : {}),
                ...(m.member.role === 'member' ? { repository: { repositoryId, repositoryName: m.member.repositoryName, fullName: m.member.fullName } } : {}),
                prNumber,
                head,
                // Asked by hand from Kodus, like Run again: it publishes, and it does not count against `@kody runtime`.
                trigger: 'run_again',
                // The environment the repository is the primary of keeps the id it always had; another one adds its own id.
                runId: deterministicUuid('dashboard', organizationId, repositoryId, prNumber, head.headSha, attempt, ...(m.member.role === 'member' ? [m.env.environmentId] : [])),
                attempt,
                ...(fork.fork ? { forkApprovalRequired: fork.approvalRequired } : {}),
            });
            await this.enqueuer.enqueue(request);
            queued.push({ environmentId: m.env.environmentId, runId: request.runId, attempt, state: 'queued' });
        }
        const [first] = queued;
        return { runId: first.runId, attempt: first.attempt, state: 'queued', ...(queued.length > 1 ? { runs: queued } : {}) };
    }
}
