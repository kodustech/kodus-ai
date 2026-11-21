import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';

import { Action, ResourceType } from '@libs/identity/domain/permissions/enums/permissions.enum';
import type { IUser } from '@libs/identity/domain/user/interfaces/user.interface';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';

import {
    RUNTIME_PRODUCT_ENVIRONMENT_STORE,
    RUNTIME_SETTINGS_STORE,
    type ProductEnvironment,
    type ProductEnvironmentStore,
    type RuntimeRepositorySettingsRecord,
    type RuntimeSettingsStore,
} from '../../domain/ports';
import {
    MAX_COMMITS_PER_PULL_REQUEST,
    MAX_PULL_REQUESTS_PER_READ,
    RUNTIME_PULL_REQUEST_RUNS_READER,
    groupPullRequestRuns,
    pullRequestKey,
    type PullRequestEnvironmentView,
    type PullRequestRef,
    type PullRequestRunRecord,
    type PullRequestRunsReader,
    type PullRequestRunsView,
} from '../../domain/pull-request-runs';
import { primaryOf, RuntimeEnvironmentMembers, type EnvironmentMembership } from '../environment-members.service';
import type { RuntimeAuthorization } from '../run-access.service';
import { repositoryModeOf as modeOf } from '../../domain/trigger-rules';

const ID_MAX = 128;

/** The PRs asked for, checked and deduplicated, in the order they came. */
export function pullRequestsOf(body: unknown): PullRequestRef[] {
    const list = (body as { pullRequests?: unknown } | null)?.pullRequests;
    if (!Array.isArray(list) || list.length < 1 || list.length > MAX_PULL_REQUESTS_PER_READ) {
        throw new BadRequestException(`pullRequests must list 1 to ${MAX_PULL_REQUESTS_PER_READ} pull requests`);
    }
    const seen = new Set<string>();
    const out: PullRequestRef[] = [];
    for (const item of list) {
        const { repositoryId, prNumber } = (item ?? {}) as { repositoryId?: unknown; prNumber?: unknown };
        if (typeof repositoryId !== 'string' || repositoryId === '' || repositoryId.length > ID_MAX) {
            throw new BadRequestException('Each pull request needs a repositoryId');
        }
        if (typeof prNumber !== 'number' || !Number.isSafeInteger(prNumber) || prNumber < 1) {
            throw new BadRequestException('Each pull request needs a positive integer prNumber');
        }
        const key = pullRequestKey(repositoryId, prNumber);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ repositoryId, prNumber });
    }
    return out;
}

/** A single environment reads as it did before membership, without its role; `triggers` stays, as "Run on this PR" reads it. */
const stripMembership = ({ role: _role, ...view }: PullRequestEnvironmentView): PullRequestEnvironmentView => view;

/** Settings rows written before the mode existed: in the pilot means on request. */
const isOn = (settings: RuntimeRepositorySettingsRecord | undefined) => modeOf(settings) !== 'off';

/**
 * POST /runtime/pull-request-runs — the Runtime state of a page of pull
 * requests in one call: per PR its environment, its latest Run and the latest
 * Run of each commit. Org-scoped, and cut to the repositories where the caller
 * may read Runs; a PR of another repository is left out of the answer.
 */
@Injectable()
export class ListPullRequestRunsUseCase {
    constructor(
        @Inject(RUNTIME_PULL_REQUEST_RUNS_READER)
        private readonly runs: PullRequestRunsReader,
        @Inject(RUNTIME_PRODUCT_ENVIRONMENT_STORE)
        private readonly environments: Pick<ProductEnvironmentStore, 'listByOrganization'>,
        @Inject(RUNTIME_SETTINGS_STORE)
        private readonly settings: Pick<RuntimeSettingsStore, 'listRepositories'>,
        @Inject(AuthorizationService)
        private readonly authorization: RuntimeAuthorization,
        // Required by Nest; made without it (the older tests), a repository's environment is the one it is the primary of.
        @Inject(RuntimeEnvironmentMembers)
        private readonly members?: RuntimeEnvironmentMembers,
    ) {}

    /**
     * The environments each repository is part of whose every repository the
     * caller may read (the machine holds all their code), the one it is the
     * primary of first. A constant number of reads for the whole page.
     */
    private async environmentsByRepository(organizationId: string, repositoryIds: Set<string>, scope: string[] | null) {
        const found: Map<string, EnvironmentMembership[]> = this.members
            ? await this.members.environmentsOfMany(organizationId, [...repositoryIds])
            : await this.primaryEnvironments(organizationId, repositoryIds);
        const envs = new Map<string, ProductEnvironment>();
        for (const list of found.values()) for (const m of list) if (m.env.organizationId === organizationId) envs.set(m.env.environmentId, m.env);
        // Every repository each environment holds, the primary first.
        const held: Map<string, string[]> = this.members
            ? await this.members.repositoryIdsOfMany([...envs.values()])
            : new Map([...envs.values()].map((e) => [e.environmentId, [e.repositoryId]]));
        const readable = new Map<string, boolean>(
            [...envs.keys()].map((id) => [id, scope === null || (held.get(id) ?? []).every((r) => scope.includes(r))]),
        );
        const out = new Map<string, EnvironmentMembership[]>();
        for (const repositoryId of repositoryIds) {
            out.set(
                repositoryId,
                (found.get(repositoryId) ?? []).filter((m) => m.env.organizationId === organizationId && readable.get(m.env.environmentId)),
            );
        }
        return { byRepository: out, readable, held };
    }

    /** Without a members reader (the older tests): a repository's environment is the one it is the primary of. */
    private async primaryEnvironments(organizationId: string, repositoryIds: Set<string>) {
        const all = (await this.environments.listByOrganization(organizationId)).filter((e) => e.organizationId === organizationId);
        return new Map([...repositoryIds].map((id) => [id, all.filter((e) => e.repositoryId === id).map((env) => ({ env, member: primaryOf(env) }))]));
    }

    /**
     * The Runs whose environment the caller may read whole, judged by the
     * environment's repositories as they are now: a Run of an environment the
     * PR's repository has since left is not among the environments listed for
     * it, and is checked here, all such environments in one read.
     */
    private async readableRuns(organizationId: string, runs: PullRequestRunRecord[], scope: string[] | null, readable: Map<string, boolean>) {
        if (scope === null || !this.members) return runs;
        const unknown = new Map<string, string[]>();
        for (const r of runs) if (!readable.has(r.environmentId) && !unknown.has(r.environmentId)) unknown.set(r.environmentId, [r.repositoryId]);
        if (unknown.size) {
            const ids = await this.members.repositoryIdsOfEnvironments(organizationId, unknown);
            for (const [environmentId, repos] of ids) readable.set(environmentId, repos.every((id) => scope.includes(id)));
        }
        return runs.filter((r) => readable.get(r.environmentId));
    }

    async execute(input: { user: Partial<IUser>; body: unknown }): Promise<{ pullRequests: PullRequestRunsView[] }> {
        const organizationId = input.user?.organization?.uuid;
        if (!organizationId) throw new NotFoundException('Organization not found');
        const asked = pullRequestsOf(input.body);

        const scope = await this.authorization.getRepositoryScope({
            user: input.user,
            action: Action.Read,
            resource: ResourceType.RuntimeRun,
        });
        const allowed = scope === null ? asked : asked.filter((pr) => scope.includes(pr.repositoryId));
        if (allowed.length === 0) return { pullRequests: [] };

        const repositoryIds = new Set(allowed.map((pr) => pr.repositoryId));
        const [records, { byRepository, readable, held }, repositorySettings] = await Promise.all([
            this.runs.listForPullRequests({ organizationId, pullRequests: allowed, perPullRequest: MAX_COMMITS_PER_PULL_REQUEST }),
            this.environmentsByRepository(organizationId, repositoryIds, scope),
            this.settings.listRepositories(organizationId),
        ]);
        const environmentIds = [...new Set([...byRepository.values()].flat().map((m) => m.env.environmentId))];
        const setups = await this.runs.setupStates(organizationId, environmentIds);
        const settingsByRepository = new Map(repositorySettings.map((s) => [s.repositoryId, s]));
        // A Run of another org never reaches the answer, even if a store returned it; nor one of an environment the caller cannot read whole.
        const grouped = groupPullRequestRuns(
            await this.readableRuns(
                organizationId,
                records.filter((r) => r.organizationId === organizationId && repositoryIds.has(r.repositoryId)),
                scope,
                readable,
            ),
        );

        return {
            pullRequests: allowed.map((pr) => {
                const memberships = byRepository.get(pr.repositoryId) ?? [];
                const views: PullRequestEnvironmentView[] = memberships.map(({ env, member }) => ({
                    environmentId: env.environmentId,
                    name: env.repositoryName,
                    ready: setups.get(env.environmentId) === 'active',
                    // On by the environment's primary: a member's own mode governs only the environment it is the primary of.
                    on: isOn(settingsByRepository.get(env.repositoryId)),
                    role: member.role,
                    triggers: member.triggers,
                    repositoryIds: held.get(env.environmentId) ?? [env.repositoryId],
                }));
                // What "Run on this PR" (no environment named) checks before it starts anything: an environment that
                // triggers on the repository, is ready, and is on.
                const canRequestRun = views.some((v) => v.triggers === true && v.ready && v.on);
                // The one the repository is the primary of first; else the first that triggers on it.
                const main = views.find((v) => v.role === 'primary') ?? views.find((v) => v.triggers) ?? views[0];
                const environment: PullRequestEnvironmentView | null = main ? (views.length > 1 ? main : stripMembership(main)) : null;
                const runs = grouped.get(pullRequestKey(pr.repositoryId, pr.prNumber));
                return {
                    ...pr,
                    environment,
                    // Only a repository in several environments lists them all: a single one reads as before.
                    ...(views.length > 1 ? { environments: views } : {}),
                    canRequestRun,
                    latest: runs?.latest ?? null,
                    commits: runs?.commits ?? [],
                };
            }),
        };
    }
}
