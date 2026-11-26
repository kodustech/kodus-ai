import { ConflictException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { Action, Role } from '@libs/identity/domain/permissions/enums/permissions.enum';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';
import { RuntimeRunRequestedSchema, type RuntimePullRequestObserved } from '@libs/runtime/run';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { RuntimeRunAccessService } from '../application/run-access.service';
import { RuntimeRunRequestBuilder } from '../application/run-request-builder.service';
import { RuntimeRunEnqueuer } from '../application/runtime-run-enqueuer.service';
import { RuntimeSetupRequester } from '../application/runtime-setup-requester.service';
import { CreateRuntimeEnvironmentUseCase } from '../application/use-cases/create-environment.use-case';
import { membershipBlockerGroups } from '../application/use-cases/environment-blockers';
import { EnvironmentRepositoriesUseCase } from '../application/use-cases/environment-repositories.use-cases';
import { ListEnvironmentBlockersUseCase } from '../application/use-cases/list-environment-blockers.use-case';
import { RuntimePullRequestTriggerUseCase } from '../application/use-cases/pull-request-trigger.use-case';
import { ListPullRequestRunsUseCase } from '../application/use-cases/pull-request-runs.use-case';
import { RequestPullRequestRunUseCase } from '../application/use-cases/request-pull-request-run.use-case';
import { SimulateRuntimeRunUseCase } from '../application/use-cases/simulate.use-case';
import { deterministicUuid } from '../domain/deterministic-id';
import type { ProductEnvironment, ProductEnvironmentStore, PullRequestHead, RuntimeGitPort, RuntimeRepositorySettingsRecord } from '../domain/ports';
import { MembershipPullRequestGate } from '../infrastructure/membership-pull-request.gate';
import {
    BASE_SHA,
    clock,
    config,
    FakeOutbox,
    InMemoryEnvironmentRepositories,
    NOW,
    openSealed,
    ORG,
    OTHER_ORG,
    realAuthorization,
    REPO,
    run,
    SECRET,
    SHA,
    storeWith,
    TEAM,
    user,
    runtimeReleaseGate,
} from './fixtures';
import { InMemoryRunTargetStore } from '@libs/runtime-publish/testing';

// Environments of several repositories, product side
// (docs/runtime/multi-repo.md): membership
// lookups, the commits pinned at enqueue, the setup's workspace, access over
// every repository, and the repositories routes.

const BILLING = 'repo-billing';
const ADMIN = 'repo-admin';
const BILLING_HEAD = 'e'.repeat(40);
const ADMIN_HEAD = 'f'.repeat(40);
const PAIRED_HEAD = '1'.repeat(40);
const PAIRED_BASE = '2'.repeat(40);

const env = (patch: Partial<ProductEnvironment> = {}): ProductEnvironment => ({
    environmentId: 'env-1',
    organizationId: ORG,
    teamId: TEAM,
    repositoryId: REPO,
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...patch,
});

class Environments implements ProductEnvironmentStore {
    constructor(readonly rows: ProductEnvironment[] = []) {}
    async listByOrganization(org: string) {
        return this.rows.filter((e) => e.organizationId === org);
    }
    async get(org: string, id: string) {
        return this.rows.find((e) => e.organizationId === org && e.environmentId === id) ?? null;
    }
    async findByRepository(org: string, repo: string) {
        return this.rows.find((e) => e.organizationId === org && e.repositoryId === repo) ?? null;
    }
    async create(input: Parameters<ProductEnvironmentStore['create']>[0]) {
        const e = env({ ...input, environmentId: `env-${this.rows.length + 1}`, state: 'setup_requested' });
        this.rows.push(e);
        return e;
    }
    async markSetupRequested() {}
    async setSubmittedRecipe() {}
    async updateSettings() {}
    async markPoolActivity() {}
    async setPoolApplied() {}
    async listPoolManagedAcrossOrganizations() {
        return [];
    }
}

const member = (environmentId: string, repositoryId: string, name: string, patch: { alias?: string; triggers?: boolean; pairBranches?: boolean; role?: 'primary' | 'member' } = {}) => ({
    environmentId,
    organizationId: ORG,
    repositoryId,
    repositoryName: name,
    fullName: name,
    role: patch.role ?? ('member' as const),
    alias: patch.alias ?? name.split('/')[1],
    triggers: patch.triggers ?? true,
    pairBranches: patch.pairBranches ?? false,
});

/** env-1: acme/shop with acme/billing beside it. env-2: acme/admin, with acme/shop as a member. */
async function world(opts: { pairBilling?: boolean; shopTriggersEnv2?: boolean } = {}) {
    const environments = new Environments([env(), env({ environmentId: 'env-2', repositoryId: ADMIN, repositoryName: 'acme/admin' })]);
    const rows = new InMemoryEnvironmentRepositories(environments.rows);
    await rows.add(member('env-1', REPO, 'acme/shop', { role: 'primary' }));
    await rows.add(member('env-1', BILLING, 'acme/billing', { pairBranches: opts.pairBilling }));
    await rows.add(member('env-2', ADMIN, 'acme/admin', { role: 'primary' }));
    await rows.add(member('env-2', REPO, 'acme/shop', { triggers: opts.shopTriggersEnv2 ?? true }));
    const members = new RuntimeEnvironmentMembers(environments, rows);
    return { environments, rows, members };
}

function fakeGit(head: Partial<PullRequestHead> = {}) {
    const defaultHeads: Record<string, string> = { [REPO]: BASE_SHA, [BILLING]: BILLING_HEAD, [ADMIN]: ADMIN_HEAD };
    const git = {
        heads: { ...defaultHeads },
        paired: null as { number: number; headSha: string; baseSha: string } | null,
        getPullRequestHead: jest.fn(async () => ({ headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open' as const, headBranch: 'feat/cart', ...head })),
        getPullRequestDiff: jest.fn(async () => ({ files: [{ path: 'src/orders.ts', patch: '@@ -1 +1 @@\n-a\n+b' }], truncated: false })),
        getDefaultBranchHead: jest.fn(async (i: { repositoryId: string }) =>
            git.heads[i.repositoryId] ? { status: 'ok' as const, branch: 'main', sha: git.heads[i.repositoryId] } : { status: 'not_found' as const },
        ),
        findOpenPullRequestByBranch: jest.fn(async () => git.paired),
        readFileAtCommit: jest.fn(async (i: { path: string }) => (i.path === '.kodus/workspace.yaml' ? 'version: 1\nservices:\n  expose:\n    - { service: app, port: 3000, kind: http }\n' : null)),
        userCanWrite: async () => true,
        isOrganizationMember: async () => true,
        resolveGitIdentity: async () => null,
    };
    return git;
}

const tokens = () => {
    let n = 0;
    const issued: string[] = [];
    return {
        issued,
        issue: jest.fn(async (i: { repositoryId: string }) => {
            issued.push(i.repositoryId);
            return `ghs_${i.repositoryId}_${++n}`;
        }),
    };
};

const imageReader = { get: async (_org: string, id: string) => ({ environmentId: id, organizationId: ORG, teamId: TEAM, repositoryId: REPO, imageId: `img-${id}`, expose: [] }) };

describe('membership lookups', () => {
    it('lists the primary first; an environment without rows reads as its primary alone, with the alias the cell derives', async () => {
        const w = await world();
        expect((await w.members.list(env())).map((m) => [m.repositoryId, m.role, m.alias])).toEqual([
            [REPO, 'primary', 'shop'],
            [BILLING, 'member', 'billing'],
        ]);
        const bare = env({ environmentId: 'env-9', repositoryName: 'Acme/My Shop!' });
        expect(await w.members.list(bare)).toEqual([expect.objectContaining({ repositoryId: REPO, role: 'primary', alias: 'my-shop-' })]);
    });

    it('finds every environment of a repository, the one it is the primary of first, and only those that trigger', async () => {
        const w = await world({ shopTriggersEnv2: false });
        expect((await w.members.environmentsOf(ORG, REPO)).map((m) => [m.env.environmentId, m.member.role])).toEqual([
            ['env-1', 'primary'],
            ['env-2', 'member'],
        ]);
        expect((await w.members.triggeredBy(ORG, REPO)).map((m) => m.env.environmentId)).toEqual(['env-1']);
        expect(await w.members.environmentsOf(OTHER_ORG, REPO)).toEqual([]);
        // A member that is the primary of nothing still resolves to its environment.
        expect((await w.members.environmentsOf(ORG, BILLING)).map((m) => m.env.environmentId)).toEqual(['env-1']);
    });

    it("create() writes the environment's primary row, once", async () => {
        const environments = new Environments();
        const rows = new InMemoryEnvironmentRepositories(environments.rows);
        const members = new RuntimeEnvironmentMembers(environments, rows);
        const requester = { request: jest.fn(async (e: ProductEnvironment) => e) };
        const orgRepos = { list: async () => ({ teamId: TEAM, repositories: [{ repositoryId: REPO, repositoryName: 'acme/shop' }] }) };
        const create = new CreateRuntimeEnvironmentUseCase(environments, orgRepos, realAuthorization(), requester as any, members);
        const created = await create.execute({ user: user(Role.OWNER), repositoryId: REPO });
        await create.execute({ user: user(Role.OWNER), repositoryId: REPO });
        expect(rows.rows).toEqual([expect.objectContaining({ environmentId: created.environmentId, repositoryId: REPO, role: 'primary', alias: 'shop', triggers: true, pairBranches: false })]);
        expect(requester.request).toHaveBeenCalledTimes(1);
    });

    it('the webhook gate records a member repository too, and caches the answer', async () => {
        const memberships = { exists: jest.fn(async ({ where }: any) => where.repositoryId === BILLING) };
        const environments = { exists: jest.fn(async ({ where }: any) => where.repositoryId === REPO) };
        const gate = new MembershipPullRequestGate(memberships as any, environments as any, () => 0);
        expect(await gate.shouldRecord({ organizationId: ORG, repositoryId: BILLING })).toBe(true);
        expect(await gate.shouldRecord({ organizationId: ORG, repositoryId: REPO })).toBe(true);
        expect(await gate.shouldRecord({ organizationId: ORG, repositoryId: 'nothing' })).toBe(false);
        await gate.shouldRecord({ organizationId: ORG, repositoryId: BILLING });
        expect(memberships.exists).toHaveBeenCalledTimes(3);
    });
});

describe('the commits a Run pins at enqueue', () => {
    const builderOf = async (opts: { pairBilling?: boolean } = {}) => {
        const w = await world(opts);
        const git = fakeGit();
        const repoTokens = tokens();
        const builder = new RuntimeRunRequestBuilder(git as unknown as RuntimeGitPort, repoTokens, imageReader, config({ runTokenSecret: SECRET }), clock, w.members);
        return { ...w, git, repoTokens, builder };
    };
    const head: PullRequestHead = { headSha: SHA, baseSha: BASE_SHA, fork: false, state: 'open', headBranch: 'feat/cart' };

    it('a single-repository environment carries no workspace: the request is as before', async () => {
        const w = await builderOf();
        await w.rows.remove(ORG, 'env-1', BILLING);
        const req = await w.builder.build({ env: env(), prNumber: 7, head, trigger: 'pull_request', runId: deterministicUuid('t', 1) });
        expect('workspace' in req).toBe(false);
        expect(w.repoTokens.issued).toEqual([REPO, REPO]);
    });

    it("the PR's repository at the PR, another at its default-branch head on both sides, each with its own two sealed tokens", async () => {
        const w = await builderOf();
        const runId = deterministicUuid('t', 2);
        const req = await w.builder.build({ env: env(), prNumber: 7, head, trigger: 'pull_request', runId });
        expect(RuntimeRunRequestedSchema.safeParse(req).success).toBe(true);
        expect(req.workspace!.map(({ sealedRepoToken: _a, sealedPrRepoToken: _b, ...r }) => r)).toEqual([
            { repositoryId: REPO, fullName: 'acme/shop', alias: 'shop', role: 'primary', baseSha: BASE_SHA, headSha: SHA, source: 'pull_request', branch: 'feat/cart' },
            { repositoryId: BILLING, fullName: 'acme/billing', alias: 'billing', role: 'member', baseSha: BILLING_HEAD, headSha: BILLING_HEAD, source: 'default_branch', branch: 'main' },
        ]);
        const billing = req.workspace![1];
        // One token per side, for that repository only, sealed for this Run.
        expect(openSealed(billing.sealedRepoToken!, runId)).toMatch(/^ghs_repo-billing_/);
        expect(openSealed(billing.sealedPrRepoToken!, runId)).toMatch(/^ghs_repo-billing_/);
        expect(openSealed(billing.sealedRepoToken!, runId)).not.toBe(openSealed(billing.sealedPrRepoToken!, runId));
        expect(req.workspace![0].sealedRepoToken).toBeUndefined();
        expect(w.repoTokens.issued.sort()).toEqual([REPO, REPO, BILLING, BILLING].sort());
    });

    it('with pair_branches, a member with an open PR of the same branch name runs that PR on the two sides', async () => {
        const w = await builderOf({ pairBilling: true });
        w.git.paired = { number: 42, headSha: PAIRED_HEAD, baseSha: PAIRED_BASE };
        const req = await w.builder.build({ env: env(), prNumber: 7, head, trigger: 'pull_request' });
        expect(req.workspace![1]).toMatchObject({ repositoryId: BILLING, source: 'paired', pairedPrNumber: 42, baseSha: PAIRED_BASE, headSha: PAIRED_HEAD, branch: 'feat/cart' });
        expect(w.git.findOpenPullRequestByBranch).toHaveBeenCalledWith(expect.objectContaining({ repositoryId: BILLING, branch: 'feat/cart' }));
        // No PR of that name: the default branch.
        w.git.paired = null;
        const plain = await w.builder.build({ env: env(), prNumber: 7, head, trigger: 'pull_request' });
        expect(plain.workspace![1]).toMatchObject({ source: 'default_branch', baseSha: BILLING_HEAD });
    });

    it('Run again reuses the commits the previous Run pinned, and stores them in the target', async () => {
        const w = await builderOf();
        const first = await w.builder.build({ env: env(), prNumber: 7, head, trigger: 'pull_request' });
        const targets = new InMemoryRunTargetStore();
        const enqueuer = new RuntimeRunEnqueuer(targets, new FakeOutbox() as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        await enqueuer.enqueue(first);
        const stored = (await targets.get(first.runId))!;
        expect(stored.workspace).toEqual([
            { repositoryId: REPO, alias: 'shop', baseSha: BASE_SHA, headSha: SHA, source: 'pull_request', branch: 'feat/cart' },
            { repositoryId: BILLING, alias: 'billing', baseSha: BILLING_HEAD, headSha: BILLING_HEAD, source: 'default_branch', branch: 'main' },
        ]);
        // billing's default branch moved since: Run again still boots the commit the first Run booted.
        w.git.heads[BILLING] = '9'.repeat(40);
        const again = await w.builder.build({ env: env(), prNumber: 7, head, trigger: 'run_again', workspace: stored.workspace });
        expect(again.workspace![1]).toMatchObject({ baseSha: BILLING_HEAD, headSha: BILLING_HEAD, source: 'default_branch', branch: 'main' });
    });

    it('a fork PR set to run starts at once only in an environment of one repository; with several it waits for a maintainer', async () => {
        const fork: PullRequestHead = { ...head, fork: true };
        const several = await builderOf();
        const held = await several.builder.build({ env: env(), prNumber: 7, head: fork, trigger: 'pull_request', forkApprovalRequired: false });
        expect(held.pullRequest).toMatchObject({ fork: true });
        expect(held.pullRequest.forkApprovalRequired).toBeUndefined();

        const one = await builderOf();
        await one.rows.remove(ORG, 'env-1', BILLING);
        const open = await one.builder.build({ env: env(), prNumber: 7, head: fork, trigger: 'pull_request', forkApprovalRequired: false });
        expect(open.pullRequest).toMatchObject({ fork: true, forkApprovalRequired: false });
    });

    it('a member PR runs as the request repository; a repository outside the environment is refused', async () => {
        const w = await builderOf();
        const req = await w.builder.build({ env: env(), repository: { repositoryId: BILLING, repositoryName: 'acme/billing' }, prNumber: 3, head, trigger: 'simulate' });
        expect(req.repository).toEqual({ id: BILLING, name: 'acme/billing', fullName: 'acme/billing' });
        expect(req.workspace!.map((r) => [r.repositoryId, r.source])).toEqual([
            [REPO, 'default_branch'],
            [BILLING, 'pull_request'],
        ]);
        await expect(
            w.builder.build({ env: env(), repository: { repositoryId: 'stranger', repositoryName: 'acme/stranger' }, prNumber: 3, head, trigger: 'simulate' }),
        ).rejects.toBeInstanceOf(ConflictException);
    });
});

describe('the PR trigger through membership', () => {
    const event = (patch: Partial<RuntimePullRequestObserved> = {}): RuntimePullRequestObserved => ({
        organizationId: ORG,
        teamId: TEAM,
        repository: { id: REPO, name: 'acme/shop' },
        prNumber: 7,
        event: 'opened',
        headSha: SHA,
        labels: [],
        author: { login: 'dev', isBot: false },
        observedAt: NOW.toISOString(),
        ...patch,
    });

    const onRules = (repositoryId: string): RuntimeRepositorySettingsRecord => ({
        repositoryId,
        pilot: true,
        whoCanAsk: 'writers',
        mode: 'rules',
        rules: [{ conditions: [{ field: 'changed_paths', matches: 'src/**' }] }],
    });

    const triggerOf = async (opts: { shopTriggersEnv2?: boolean; settings?: RuntimeRepositorySettingsRecord[] } = {}) => {
        const w = await world(opts);
        const git = fakeGit();
        const outbox = new FakeOutbox();
        const targets = new InMemoryRunTargetStore();
        const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        const builder = new RuntimeRunRequestBuilder(git as unknown as RuntimeGitPort, tokens(), imageReader, config({ runTokenSecret: SECRET }), clock, w.members);
        const useCase = new RuntimePullRequestTriggerUseCase(
            { listRepositories: async () => opts.settings ?? [REPO, BILLING, ADMIN].map(onRules) },
            w.environments,
            await storeWith(),
            git as unknown as RuntimeGitPort,
            builder,
            enqueuer,
            { get: async () => ({ state: 'active', organizationId: ORG }) as any },
            undefined,
            w.members,
            undefined,
            runtimeReleaseGate(),
        );
        const strip = ({ workflowType: _t, ...rest }: any) => rest;
        const requested = () => outbox.rows.filter((r) => r.payload.event_name === 'runtime.run.requested').map((r) => RuntimeRunRequestedSchema.parse(strip(r.payload.payload)));
        return { ...w, useCase, requested, targets };
    };

    it('starts one Run per environment that triggers on the repository; the primary keeps its runId', async () => {
        const t = await triggerOf();
        const outcome = await t.useCase.execute(event());
        expect(outcome).toMatchObject({ action: 'per_environment', outcomes: [{ environmentId: 'env-1', action: 'enqueued' }, { environmentId: 'env-2', action: 'enqueued' }] });
        const [own, other] = t.requested();
        expect([own.environment.environmentId, other.environment.environmentId]).toEqual(['env-1', 'env-2']);
        expect('workspace' in own).toBe(true);
        expect(own.runId).toBe(deterministicUuid('pull_request', ORG, REPO, 7, SHA));
        expect(other.runId).toBe(deterministicUuid('pull_request', ORG, REPO, 7, SHA, 'env-2'));
        expect(other.repository.id).toBe(REPO);
        expect(other.workspace!.map((r) => [r.repositoryId, r.role, r.source])).toEqual([
            [ADMIN, 'primary', 'default_branch'],
            [REPO, 'member', 'pull_request'],
        ]);
        expect((await t.targets.get(other.runId))!.workspace).toHaveLength(2);
    });

    it('a membership without triggers starts nothing in that environment', async () => {
        const t = await triggerOf({ shopTriggersEnv2: false });
        expect(await t.useCase.execute(event())).toMatchObject({ action: 'enqueued' });
        expect(t.requested().map((r) => r.environment.environmentId)).toEqual(['env-1']);
    });

    it("a member repository's PR starts a Run of its environment", async () => {
        const t = await triggerOf();
        await t.useCase.execute(event({ repository: { id: BILLING, name: 'acme/billing' } }));
        const [req] = t.requested();
        expect(req).toMatchObject({ repository: { id: BILLING }, environment: { environmentId: 'env-1' } });
        expect(req.runId).toBe(deterministicUuid('pull_request', ORG, BILLING, 7, SHA, 'env-1'));
    });

    it("a member repository with no Runtime settings of its own runs its PRs in the environment it is a member of, by that environment's mode", async () => {
        // demo-shop-billing on 2026-11-13: a member of demo-shop's environment with no settings row was answered "off for this repository".
        const t = await triggerOf({ settings: [onRules(REPO)] });
        const billing = { repository: { id: BILLING, name: 'acme/billing' } };
        expect(await t.useCase.execute(event(billing))).toMatchObject({ action: 'enqueued' });
        expect(await t.useCase.execute(event({ ...billing, event: 'comment', commentId: 'c-1', commenter: { id: 'u-1', login: 'dev' } }))).toMatchObject({ action: 'enqueued', trigger: 'comment' });
        expect(t.requested().map((r) => [r.repository.id, r.environment.environmentId])).toEqual([
            [BILLING, 'env-1'],
            [BILLING, 'env-1'],
        ]);
    });

    it("a member's own mode governs only the environment it is the primary of", async () => {
        // acme/shop is off for itself (env-1, its own) but a member of env-2, whose primary runs on rules.
        const t = await triggerOf({ settings: [{ ...onRules(REPO), pilot: false, mode: 'off' }, onRules(ADMIN)] });
        expect(await t.useCase.execute(event())).toMatchObject({
            action: 'per_environment',
            outcomes: [
                { environmentId: 'env-1', action: 'skipped', reason: 'off' },
                { environmentId: 'env-2', action: 'enqueued' },
            ],
        });
        expect(t.requested().map((r) => r.environment.environmentId)).toEqual(['env-2']);
    });

    it("an environment whose primary is off runs none of its members' PRs, and says it is the environment that is off", async () => {
        const t = await triggerOf({ settings: [{ ...onRules(REPO), pilot: false, mode: 'off' }, onRules(BILLING)] });
        expect(await t.useCase.execute(event({ repository: { id: BILLING, name: 'acme/billing' } }))).toEqual({ action: 'skipped', reason: 'environment_off' });
        expect(t.requested()).toHaveLength(0);
    });
});

describe('the setup of several repositories', () => {
    it("carries every repository at its default-branch head with its own token; one repository stays as before", async () => {
        const w = await world();
        const git = fakeGit();
        const repoTokens = tokens();
        const outbox = new FakeOutbox();
        const requester = new RuntimeSetupRequester(w.environments, git as unknown as RuntimeGitPort, repoTokens, outbox as any, clock, config(), undefined, w.members);
        await requester.request(env(), user(Role.OWNER));
        const command = outbox.rows[0].payload.payload;
        expect(outbox.rows[0].payload.event_name).toBe(RuntimeCommandName.EnvironmentSetupRequested);
        const key = command.key;
        expect(command.workspace.map(({ sealedRepoToken: _t, ...r }: any) => r)).toEqual([
            { repositoryId: REPO, fullName: 'acme/shop', alias: 'shop', role: 'primary', sha: BASE_SHA, branch: 'main' },
            { repositoryId: BILLING, fullName: 'acme/billing', alias: 'billing', role: 'member', sha: BILLING_HEAD, branch: 'main' },
        ]);
        expect(command.workspace[0].sealedRepoToken).toBe(command.repoToken);
        expect(openSealed(command.workspace[1].sealedRepoToken, key)).toMatch(/^ghs_repo-billing_/);

        const single = new FakeOutbox();
        await new RuntimeSetupRequester(w.environments, git as unknown as RuntimeGitPort, tokens(), single as any, clock, config(), undefined, w.members).request(
            env({ environmentId: 'env-solo', repositoryId: 'repo-solo', repositoryName: 'acme/solo' }),
            user(Role.OWNER),
        );
        expect('workspace' in single.rows[0].payload.payload).toBe(false);
    });

    it('a member Kodus cannot read stops the setup with a blocker naming it', async () => {
        const w = await world();
        const git = fakeGit();
        delete git.heads[BILLING];
        const outbox = new FakeOutbox();
        await new RuntimeSetupRequester(w.environments, git as unknown as RuntimeGitPort, tokens(), outbox as any, clock, config(), undefined, w.members).request(env(), user(Role.OWNER));
        expect(outbox.rows[0].payload.payload.blocker).toEqual({ kind: 'no_ref', message: expect.stringContaining('acme/billing') });
        expect(outbox.rows[0].payload.payload.workspace).toBeUndefined();
    });
});

describe('access over every repository', () => {
    it("reading a Run of an environment needs every repository of it, for a user and for a team key", async () => {
        const w = await world();
        const r = run({ environmentId: 'env-1' });
        const store = await storeWith(r);
        // Create (Run again) is repo-scoped for a repo admin: the primary alone is not enough.
        const onlyShop = new RuntimeRunAccessService(store, realAuthorization([REPO]), w.members);
        await expect(onlyShop.load({ kind: 'user', user: user(Role.REPO_ADMIN) }, r.runId, Action.Create)).rejects.toBeInstanceOf(ForbiddenException);
        const both = new RuntimeRunAccessService(store, realAuthorization([REPO, BILLING]), w.members);
        await expect(both.load({ kind: 'user', user: user(Role.REPO_ADMIN) }, r.runId, Action.Create)).resolves.toMatchObject({ runId: r.runId });
        const key = (repositoryIds: string[]) => ({ kind: 'team_key' as const, keyId: 'k', organizationId: ORG, teamId: TEAM, capabilities: ['runs:read'], repositoryIds });
        await expect(both.load(key([REPO]), r.runId)).rejects.toBeInstanceOf(ForbiddenException);
        await expect(both.load(key([REPO, BILLING]), r.runId)).resolves.toMatchObject({ runId: r.runId });
    });

    it('simulating needs every repository of the environment, and a repository outside it is never simulated there', async () => {
        const w = await world();
        const git = fakeGit();
        const outbox = new FakeOutbox();
        const enqueuer = new RuntimeRunEnqueuer(new InMemoryRunTargetStore(), outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        const builder = new RuntimeRunRequestBuilder(git as unknown as RuntimeGitPort, tokens(), imageReader, config({ runTokenSecret: SECRET }), clock, w.members);
        const simulate = async (assigned: string[]) => new SimulateRuntimeRunUseCase(w.environments, realAuthorization(assigned), await storeWith(), git as any, builder, enqueuer, w.members);

        await expect((await simulate([REPO])).execute({ user: user(Role.REPO_ADMIN), environmentId: 'env-1', body: { prNumber: 3, repositoryId: REPO } })).rejects.toBeInstanceOf(ForbiddenException);
        // acme/admin is env-2's: naming it on env-1 simulates nothing.
        await expect((await simulate([REPO])).execute({ user: user(Role.OWNER), environmentId: 'env-1', body: { prNumber: 3, repositoryId: ADMIN } })).rejects.toBeInstanceOf(NotFoundException);
        expect(git.getPullRequestHead).not.toHaveBeenCalled();
        expect(outbox.rows).toHaveLength(0);

        await expect((await simulate([REPO, BILLING])).execute({ user: user(Role.REPO_ADMIN), environmentId: 'env-1', body: { prNumber: 3, repositoryId: BILLING } })).resolves.toMatchObject({ state: 'queued' });
    });
});

describe('the repositories of an environment (routes)', () => {
    const routesOf = async (assigned = [REPO, BILLING, ADMIN, 'repo-web']) => {
        const w = await world();
        const setups = { request: jest.fn(async (e: ProductEnvironment) => ({ ...e, state: 'setup_requested' as const, setupRequestedAt: NOW.toISOString() })) };
        const orgRepos = {
            list: async () => ({
                teamId: TEAM,
                repositories: [
                    { repositoryId: REPO, repositoryName: 'acme/shop' },
                    { repositoryId: BILLING, repositoryName: 'acme/billing' },
                    { repositoryId: ADMIN, repositoryName: 'acme/admin' },
                    { repositoryId: 'repo-web', repositoryName: 'acme/web' },
                    { repositoryId: 'repo-shop2', repositoryName: 'other/shop' },
                ],
            }),
        };
        const uc = new EnvironmentRepositoriesUseCase(w.environments, w.rows, orgRepos, realAuthorization(assigned), w.members, setups as any);
        return { ...w, uc, setups };
    };
    const owner = user(Role.OWNER);

    it('adds a connected repository with its alias and asks for a setup; the same one again changes nothing', async () => {
        const t = await routesOf();
        const res = await t.uc.add({ user: owner, environmentId: 'env-1', body: { repositoryId: 'repo-web', alias: 'front', pairBranches: true } });
        expect(res).toMatchObject({ setupRequested: true, repository: { repositoryId: 'repo-web', alias: 'front', role: 'member', triggers: true, pairBranches: true } });
        expect(res.repositories.map((r) => r.alias)).toEqual(['shop', 'billing', 'front']);
        const again = await t.uc.add({ user: owner, environmentId: 'env-1', body: { repositoryId: 'repo-web' } });
        expect(again).toMatchObject({ setupRequested: false, repository: { alias: 'front' } });
        expect(t.setups.request).toHaveBeenCalledTimes(1);
    });

    it("409: an alias taken, the primary's alias, the primary itself; 404: a repository not connected", async () => {
        const t = await routesOf();
        await expect(t.uc.add({ user: owner, environmentId: 'env-1', body: { repositoryId: 'repo-web', alias: 'billing' } })).rejects.toBeInstanceOf(ConflictException);
        await expect(t.uc.add({ user: owner, environmentId: 'env-1', body: { repositoryId: 'repo-web', alias: 'shop' } })).rejects.toBeInstanceOf(ConflictException);
        // other/shop defaults to the primary's alias: it needs one of its own.
        await expect(t.uc.add({ user: owner, environmentId: 'env-1', body: { repositoryId: 'repo-shop2' } })).rejects.toThrow(/default alias \(shop\) is the primary's/);
        await expect(t.uc.add({ user: owner, environmentId: 'env-1', body: { repositoryId: REPO } })).rejects.toBeInstanceOf(ConflictException);
        await expect(t.uc.add({ user: owner, environmentId: 'env-1', body: { repositoryId: 'unknown' } })).rejects.toBeInstanceOf(NotFoundException);
        await expect(t.uc.add({ user: user(Role.OWNER, { org: OTHER_ORG }), environmentId: 'env-1', body: { repositoryId: 'repo-web' } })).rejects.toBeInstanceOf(NotFoundException);
    });

    it("changes triggers and pair branches; a member's new alias asks for a setup; the primary's alias is fixed", async () => {
        const t = await routesOf();
        const res = await t.uc.update({ user: owner, environmentId: 'env-1', repositoryId: BILLING, body: { triggers: false } });
        expect(res).toMatchObject({ setupRequested: false, repository: { triggers: false } });
        const moved = await t.uc.update({ user: owner, environmentId: 'env-1', repositoryId: BILLING, body: { alias: 'payments' } });
        expect(moved).toMatchObject({ setupRequested: true, repository: { alias: 'payments' } });
        await expect(t.uc.update({ user: owner, environmentId: 'env-1', repositoryId: BILLING, body: { alias: 'shop' } })).rejects.toBeInstanceOf(ConflictException);
        await expect(t.uc.update({ user: owner, environmentId: 'env-1', repositoryId: REPO, body: { alias: 'main-app' } })).rejects.toThrow(/alias is fixed/);
        await expect(t.uc.update({ user: owner, environmentId: 'env-1', repositoryId: REPO, body: { triggers: false } })).resolves.toMatchObject({ repository: { role: 'primary', triggers: false } });
        await expect(t.uc.update({ user: owner, environmentId: 'env-1', repositoryId: 'repo-web', body: { triggers: false } })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('removes a member and asks for a setup; the primary leaves only with its environment', async () => {
        const t = await routesOf();
        const res = await t.uc.remove({ user: owner, environmentId: 'env-1', repositoryId: BILLING });
        expect(res).toMatchObject({ setupRequested: true, repositories: [{ repositoryId: REPO }] });
        await expect(t.uc.remove({ user: owner, environmentId: 'env-1', repositoryId: REPO })).rejects.toBeInstanceOf(ConflictException);
        await expect(t.uc.remove({ user: owner, environmentId: 'env-1', repositoryId: BILLING })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a write is the org admin\'s (Manage on the environment); reading needs every repository of it', async () => {
        const t = await routesOf([REPO, BILLING, 'repo-web']);
        await expect(t.uc.add({ user: user(Role.REPO_ADMIN), environmentId: 'env-1', body: { repositoryId: 'repo-web' } })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(t.uc.remove({ user: user(Role.CONTRIBUTOR), environmentId: 'env-1', repositoryId: BILLING })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(t.uc.list({ user: user(Role.CONTRIBUTOR), environmentId: 'env-1' })).resolves.toHaveLength(2);
        await expect(t.uc.list({ user: user(Role.BILLING_MANAGER), environmentId: 'env-1' })).rejects.toBeInstanceOf(ForbiddenException);
    });
});

describe("services.needs against the environment's repositories", () => {
    const setupWith = (content: string, origin?: 'inferred') =>
        ({
            environmentId: 'env-1',
            organizationId: ORG,
            repositoryId: REPO,
            key: 'k',
            state: 'blocked',
            steps: [],
            blockers: [],
            requestedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
            recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content, ...(origin ? { origin } : {}) },
        }) as any;
    const RECIPE = [
        'version: 1',
        'services:',
        '  compose:',
        '    files: [docker-compose.yml]',
        '    public: app',
        '  needs:',
        '    - { repo: acme/billing, alias: billing }',
        '    - { repo: acme/web, alias: web }',
        '    - { repo: acme/ledger }',
        '  expose:',
        '    - { service: app, port: 3000, kind: http }',
        '',
    ].join('\n');
    const members = [member('env-1', REPO, 'acme/shop', { role: 'primary' }), member('env-1', BILLING, 'acme/billing')];
    const connected = [
        { repositoryId: BILLING, repositoryName: 'acme/billing' },
        { repositoryId: 'repo-web', repositoryName: 'Acme/Web' },
    ];

    it('a connected repository that is not a member: "Add <repo> to this environment"; one not connected: connect it', () => {
        const groups = membershipBlockerGroups(setupWith(RECIPE), members, connected);
        expect(groups.map((g) => [g.signature, g.fixes[0].action, g.fixes[0].label])).toEqual([
            ['needs_member:acme/web', 'add_repository', 'Add acme/web to this environment'],
            ['needs_connection:acme/ledger', 'connect_repository', 'Connect acme/ledger to Kodus'],
        ]);
        expect(groups[0].fixes[0]).toMatchObject({ repositoryId: 'repo-web', alias: 'web', who: 'one_click' });
    });

    it('answers unavailable when the connected repositories cannot be read, never "not connected to Kodus"', async () => {
        const env = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
        const blockers = new ListEnvironmentBlockersUseCase(
            { load: async () => ({ env, runs: [] }), setup: async () => setupWith(RECIPE) } as any,
            undefined,
            { list: async () => members } as any,
            { list: async () => Promise.reject(new Error('integration store down')) },
        );
        await expect(blockers.execute({ user: user(Role.OWNER), environmentId: 'env-1' })).rejects.toBeInstanceOf(ServiceUnavailableException);
    });

    it('says nothing of a recipe that is not committed, or that needs only members', () => {
        expect(membershipBlockerGroups(setupWith(RECIPE, 'inferred'), members, connected)).toEqual([]);
        const onlyBilling = RECIPE.replace('    - { repo: acme/web, alias: web }\n', '').replace('    - { repo: acme/ledger }\n', '');
        expect(membershipBlockerGroups(setupWith(onlyBilling), members, connected)).toEqual([]);
    });
});

describe('the pull requests screens through membership', () => {
    const onRequest = (repositoryId: string): RuntimeRepositorySettingsRecord => ({ repositoryId, pilot: true, whoCanAsk: 'writers', mode: 'on_request' });
    const settings = { listRepositories: async () => [REPO, BILLING, ADMIN].map(onRequest) };

    it('lists every environment of a repository in several, the one it is the primary of as `environment`', async () => {
        const w = await world();
        const reader = {
            listForPullRequests: async () => [run({ environmentId: 'env-2', runId: 'run-env-2' })],
            setupStates: async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, 'active' as const])),
        };
        const list = new ListPullRequestRunsUseCase(reader, w.environments, settings, realAuthorization(), w.members);
        const res = await list.execute({ user: user(Role.OWNER), body: { pullRequests: [{ repositoryId: REPO, prNumber: 7 }, { repositoryId: BILLING, prNumber: 3 }] } });
        expect(res.pullRequests[0].environment).toMatchObject({ environmentId: 'env-1', role: 'primary' });
        expect(res.pullRequests[0].environments!.map((e) => [e.environmentId, e.role])).toEqual([
            ['env-1', 'primary'],
            ['env-2', 'member'],
        ]);
        // A repository in one environment reads as before, no list and no role, with what Run on this PR reads beside it.
        expect(res.pullRequests[1].environment).toEqual({ environmentId: 'env-1', name: 'acme/shop', ready: true, on: true, triggers: true, repositoryIds: [REPO, BILLING] });
        expect(res.pullRequests[1]).not.toHaveProperty('environments');
    });

    it('lists, for each environment, every repository it holds: what Run on this PR needs Create over', async () => {
        const w = await world();
        const reader = { listForPullRequests: async () => [], setupStates: async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, 'active' as const])) };
        const list = new ListPullRequestRunsUseCase(reader, w.environments, settings, realAuthorization(), w.members);
        const res = await list.execute({ user: user(Role.OWNER), body: { pullRequests: [{ repositoryId: REPO, prNumber: 7 }, { repositoryId: BILLING, prNumber: 3 }] } });
        expect(res.pullRequests[0].environments!.map((e) => [e.environmentId, e.repositoryIds])).toEqual([
            ['env-1', [REPO, BILLING]],
            ['env-2', [ADMIN, REPO]],
        ]);
        expect(res.pullRequests[1].environment!.repositoryIds).toEqual([REPO, BILLING]);
    });

    it("a member that does not trigger in its only environment: the batch says Run on this PR starts nothing, and asking answers 409 with why", async () => {
        const w = await world();
        await w.rows.update(ORG, 'env-1', BILLING, { triggers: false });
        const reader = { listForPullRequests: async () => [], setupStates: async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, 'active' as const])) };
        const list = new ListPullRequestRunsUseCase(reader, w.environments, settings, realAuthorization(), w.members);
        const res = await list.execute({ user: user(Role.OWNER), body: { pullRequests: [{ repositoryId: BILLING, prNumber: 3 }, { repositoryId: REPO, prNumber: 7 }] } });
        expect(res.pullRequests[0]).toMatchObject({ environment: { environmentId: 'env-1', triggers: false }, canRequestRun: false });
        expect(res.pullRequests[1]).toMatchObject({ canRequestRun: true });

        const git = fakeGit();
        const outbox = new FakeOutbox();
        const enqueuer = new RuntimeRunEnqueuer(new InMemoryRunTargetStore(), outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        const builder = new RuntimeRunRequestBuilder(git as unknown as RuntimeGitPort, tokens(), imageReader, config({ runTokenSecret: SECRET }), clock, w.members);
        const uc = new RequestPullRequestRunUseCase(realAuthorization(), w.environments, { get: async () => ({ state: 'active' }) as any }, settings, await storeWith(), git as any, builder, enqueuer, config(), w.members);
        await expect(uc.execute({ user: user(Role.OWNER), body: { repositoryId: BILLING, prNumber: 3 } })).rejects.toThrow(
            new ConflictException("No environment runs this repository's pull requests: turn on triggers for it in one of its environments"),
        );
        expect(outbox.rows).toHaveLength(0);
    });

    it("never shows a Run of an environment holding a repository the caller cannot read, even once the PR's repository left it", async () => {
        const w = await world();
        await w.rows.remove(ORG, 'env-2', REPO);
        const reader = {
            listForPullRequests: async () => [run({ environmentId: 'env-2', runId: 'run-env-2' })],
            setupStates: async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, 'active' as const])),
        };
        const onlyShop = { ensure: async () => undefined, getRepositoryScope: async () => [REPO] };
        const list = new ListPullRequestRunsUseCase(reader, w.environments, settings, onlyShop, w.members);
        const res = await list.execute({ user: user(Role.CONTRIBUTOR), body: { pullRequests: [{ repositoryId: REPO, prNumber: 7 }] } });
        expect(res.pullRequests[0].latest).toBeNull();
    });

    const requestOf = async (assigned?: string[], repoSettings: { listRepositories: () => Promise<RuntimeRepositorySettingsRecord[]> } = settings) => {
        const w = await world();
        const git = fakeGit();
        const outbox = new FakeOutbox();
        const targets = new InMemoryRunTargetStore();
        const enqueuer = new RuntimeRunEnqueuer(targets, outbox as any, { getTypeIntegration: async () => PlatformType.GITHUB });
        const builder = new RuntimeRunRequestBuilder(git as unknown as RuntimeGitPort, tokens(), imageReader, config({ runTokenSecret: SECRET }), clock, w.members);
        const runs = await storeWith();
        const uc = new RequestPullRequestRunUseCase(realAuthorization(assigned), w.environments, { get: async () => ({ state: 'active' }) as any }, repoSettings, runs, git as any, builder, enqueuer, config(), w.members);
        return { ...w, git, outbox, targets, runs, uc };
    };

    it("Run on this PR needs every repository of the environment: a repo admin of the PR's repository alone starts nothing", async () => {
        const body = { repositoryId: REPO, prNumber: 7, environmentId: 'env-1' };
        const onlyShop = await requestOf([REPO]);
        await expect(onlyShop.uc.execute({ user: user(Role.REPO_ADMIN), body })).rejects.toBeInstanceOf(ForbiddenException);
        expect(onlyShop.outbox.rows).toHaveLength(0);
        const both = await requestOf([REPO, BILLING]);
        await expect(both.uc.execute({ user: user(Role.REPO_ADMIN), body })).resolves.toMatchObject({ state: 'queued' });
    });

    it('runs in every environment that triggers on the repository, or in the one named', async () => {
        const t = await requestOf();
        const res = await t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7 } });
        expect(res.runs!.map((r) => r.environmentId)).toEqual(['env-1', 'env-2']);
        expect(res.runId).toBe(res.runs![0].runId);
        const named = await (await requestOf()).uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7, environmentId: 'env-2' } });
        expect(named).toEqual({ runId: deterministicUuid('dashboard', ORG, REPO, 7, SHA, 1, 'env-2'), attempt: 1, state: 'queued' });
        await expect((await requestOf()).uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7, environmentId: 'env-9' } })).rejects.toBeInstanceOf(NotFoundException);
    });

    it("Run on this PR in an environment follows that environment's mode (its primary's), never a member's own", async () => {
        // acme/billing off for itself (or with no settings at all) still runs in acme/shop's environment.
        for (const billing of [[{ ...onRequest(BILLING), pilot: false, mode: 'off' as const }], []]) {
            const t = await requestOf(undefined, { listRepositories: async () => [onRequest(REPO), onRequest(ADMIN), ...billing] });
            await expect(t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: BILLING, prNumber: 3 } })).resolves.toMatchObject({ state: 'queued' });
            await expect(t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7, environmentId: 'env-1' } })).resolves.toMatchObject({ state: 'queued' });
        }
        // acme/shop off: its own environment runs nothing, a member's PR there included; env-2, where it is a member, still runs it.
        const shopOff = { listRepositories: async () => [{ ...onRequest(REPO), pilot: false, mode: 'off' as const }, onRequest(BILLING), onRequest(ADMIN)] };
        const t = await requestOf(undefined, shopOff);
        await expect(t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: BILLING, prNumber: 3 } })).rejects.toThrow(new ConflictException('Kody Runtime is off for this environment'));
        await expect(t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7, environmentId: 'env-1' } })).rejects.toThrow(
            new ConflictException('Kody Runtime is off for this repository'),
        );
        expect(t.outbox.rows).toHaveLength(0);
        const every = await t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7 } });
        expect(every).toEqual({ runId: deterministicUuid('dashboard', ORG, REPO, 7, SHA, 1, 'env-2'), attempt: 1, state: 'queued' });
    });

    it("the batch says an environment is on by its primary's mode: a member with no settings of its own can be run", async () => {
        const w = await world();
        const reader = { listForPullRequests: async () => [], setupStates: async (_org: string, ids: string[]) => new Map(ids.map((id) => [id, 'active' as const])) };
        const noBilling = { listRepositories: async () => [onRequest(REPO), onRequest(ADMIN)] };
        const list = new ListPullRequestRunsUseCase(reader, w.environments, noBilling, realAuthorization(), w.members);
        const res = await list.execute({ user: user(Role.OWNER), body: { pullRequests: [{ repositoryId: BILLING, prNumber: 3 }] } });
        expect(res.pullRequests[0]).toMatchObject({ environment: { environmentId: 'env-1', on: true }, canRequestRun: true });
        const shopOff = { listRepositories: async () => [{ ...onRequest(REPO), pilot: false, mode: 'off' as const }, onRequest(ADMIN)] };
        const off = await new ListPullRequestRunsUseCase(reader, w.environments, shopOff, realAuthorization(), w.members).execute({
            user: user(Role.OWNER),
            body: { pullRequests: [{ repositoryId: BILLING, prNumber: 3 }, { repositoryId: REPO, prNumber: 7 }] },
        });
        expect(off.pullRequests[0]).toMatchObject({ environment: { on: false }, canRequestRun: false });
        // acme/shop's own environment is off; env-2, where it is a member, is on.
        expect(off.pullRequests[1].environments!.map((e) => [e.environmentId, e.on])).toEqual([
            ['env-1', false],
            ['env-2', true],
        ]);
        expect(off.pullRequests[1].canRequestRun).toBe(true);
    });

    it('asked again on a head that ran, the other repositories boot the commits that Run pinned, with fresh tokens', async () => {
        const t = await requestOf();
        const first = await t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7, environmentId: 'env-1' } });
        const pinned = (await t.targets.get(first.runId))!.workspace!;
        await (t.runs as any).upsert(first.runId, run({ runId: first.runId, environmentId: 'env-1', state: 'regression', attempt: 1 }));
        t.git.heads[BILLING] = '9'.repeat(40);
        const again = await t.uc.execute({ user: user(Role.OWNER), body: { repositoryId: REPO, prNumber: 7, environmentId: 'env-1' } });
        expect(again.attempt).toBe(2);
        expect((await t.targets.get(again.runId))!.workspace).toEqual(pinned);
        const [, second] = t.outbox.rows.map((r) => r.payload.payload);
        expect(second.workspace[1].sealedRepoToken).not.toBe(t.outbox.rows[0].payload.payload.workspace[1].sealedRepoToken);
    });
});
