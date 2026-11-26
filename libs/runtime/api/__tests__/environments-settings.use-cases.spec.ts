import { randomUUID } from 'crypto';

import { BadRequestException, ForbiddenException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { Role } from '@libs/identity/domain/permissions/enums/permissions.enum';

import {
    CreateRuntimeEnvironmentUseCase,
    GetRuntimeEnvironmentUseCase,
    ListEnvironmentBlockersUseCase,
    ListRuntimeEnvironmentsUseCase,
    percentile,
    RequestEnvironmentSetupUseCase,
    RuntimeEnvironmentsReader,
    UpdateEnvironmentSettingsUseCase,
} from '../application/use-cases/environments.use-cases';
import {
    GetRuntimeSettingsUseCase,
    UpdateRuntimeOrgSettingsUseCase,
    UpdateRuntimeRepositorySettingsUseCase,
} from '../application/use-cases/settings.use-cases';
import { ClearRuntimeStopUseCase } from '../application/use-cases/stop-runtime.use-case';
import { RuntimeSetupRequester } from '../application/runtime-setup-requester.service';
import type {
    DefaultBranchHead,
    ProductEnvironment,
    ProductEnvironmentSettings,
    ProductEnvironmentStore,
    RuntimeApiConfig,
    RuntimeEgressReader,
    RuntimeGitPort,
    RuntimeOrgRepositories,
    RuntimeRepoTokenIssuer,
    RuntimeRepositorySettingsRecord,
    RuntimeSettingsStore,
} from '../domain/ports';
import { RuntimeCommandName } from '@libs/runtime/contracts/runtime-commands';
import { effectivePoolSize, type PoolUsage } from '../domain/pool';
import { RuntimePoolController } from '../application/pool-controller.service';
import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { RuntimeSuiteSelection } from '../application/suite-selection.service';
import { clock, config, FakeOutbox, InMemoryEnvironmentRepositories, NOW, ORG, OTHER_ORG, OTHER_REPO, REPO, realAuthorization, run, storeWith, TEAM, user, openSealed } from './fixtures';

class InMemoryEnvironments implements ProductEnvironmentStore {
    readonly rows: ProductEnvironment[] = [];
    async listByOrganization(organizationId: string) {
        return this.rows.filter((e) => e.organizationId === organizationId);
    }
    async get(organizationId: string, environmentId: string) {
        return (
            this.rows.find((e) => e.organizationId === organizationId && e.environmentId === environmentId) ?? null
        );
    }
    async findByRepository(organizationId: string, repositoryId: string) {
        return (
            this.rows.find((e) => e.organizationId === organizationId && e.repositoryId === repositoryId) ?? null
        );
    }
    async create(input: Omit<ProductEnvironment,
            | 'environmentId' | 'createdAt' | 'updatedAt' | 'state' | 'setupRequestedAt'>) {
        const env: ProductEnvironment = { ...input, environmentId: randomUUID(), state: 'active', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString() };
        this.rows.push(env);
        return env;
    }
    async markSetupRequested(organizationId: string, environmentId: string, at: Date) {
        const e = this.rows.find((x) => x.organizationId === organizationId && x.environmentId === environmentId);
        if (!e) return;
        e.state = 'setup_requested';
        e.setupRequestedAt = at.toISOString();
    }
    async setSubmittedRecipe(organizationId: string, environmentId: string, recipe: NonNullable<ProductEnvironment['submittedRecipe']>) {
        const e = this.rows.find((x) => x.organizationId === organizationId && x.environmentId === environmentId);
        if (e) e.submittedRecipe = recipe;
    }
    readonly settingsWrites: ProductEnvironmentSettings[] = [];
    async updateSettings(organizationId: string, environmentId: string, settings: ProductEnvironmentSettings) {
        this.settingsWrites.push(settings);
        const e = this.rows.find((x) => x.organizationId === organizationId && x.environmentId === environmentId);
        if (e) Object.assign(e, settings);
    }
    async markPoolActivity(organizationId: string, environmentId: string, at: Date) {
        const e = this.rows.find((x) => x.organizationId === organizationId && x.environmentId === environmentId);
        if (e) e.poolActivityAt = at.toISOString();
    }
    async setPoolApplied(organizationId: string, environmentId: string, size: number, usage: PoolUsage) {
        const e = this.rows.find((x) => x.organizationId === organizationId && x.environmentId === environmentId);
        if (e) Object.assign(e, { poolAppliedSize: size, poolUsage: usage });
    }
    async listPoolManagedAcrossOrganizations(limit: number) {
        return this.rows.filter((e) => e.poolPolicy || (e.poolAppliedSize ?? 0) > 0).slice(0, limit);
    }
}

class InMemorySettings implements RuntimeSettingsStore {
    budgets = new Map<string, number | null>();
    thresholds = new Map<string, number | null>();
    hostPrices = new Map<string, number | null>();
    partlyTested = new Map<string, 'action_required' | 'neutral' | null>();
    repos: Array<RuntimeRepositorySettingsRecord & { organizationId: string }> = [];
    async getOrganization(o: string) {
        if (!this.budgets.has(o) && !this.thresholds.has(o) && !this.hostPrices.has(o) && !this.partlyTested.has(o)) return null;
        return {
            tokenBudgetPerDay: this.budgets.get(o) ?? null,
            exercisedLinesThresholdPercent: this.thresholds.get(o) ?? null,
            machineUsdPerHostHour: this.hostPrices.get(o) ?? null,
            partlyTestedCheck: this.partlyTested.get(o) ?? null,
        };
    }
    async setPartlyTestedCheck(o: string, v: 'action_required' | 'neutral' | null) {
        this.partlyTested.set(o, v);
    }
    async setTokenBudget(o: string, v: number | null) {
        this.budgets.set(o, v);
    }
    async setExercisedLinesThreshold(o: string, v: number | null) {
        this.thresholds.set(o, v);
    }
    async setMachineUsdPerHostHour(o: string, v: number | null) {
        this.hostPrices.set(o, v);
    }
    async listRepositories(o: string) {
        return this.repos.filter((r) => r.organizationId === o).map(({ organizationId: _o, ...r }) => r);
    }
    async upsertRepository(o: string, s: RuntimeRepositorySettingsRecord) {
        this.repos = [...this.repos.filter((r) => !(r.organizationId === o && r.repositoryId === s.repositoryId)), { ...s, organizationId: o }];
    }
}

const orgRepos: RuntimeOrgRepositories = {
    list: async (o) =>
        o === ORG
            ? { teamId: TEAM, repositories: [{ repositoryId: REPO, repositoryName: 'acme/shop' }, { repositoryId: OTHER_REPO, repositoryName: 'acme/api' }] }
            : { teamId: 'team-b', repositories: [{ repositoryId: 'repo-b', repositoryName: 'other/repo' }] },
};

const egress: RuntimeEgressReader = {
    blockedForRuns: async (_o, runIds) =>
        runIds.length ? [{ host: 'registry.example.test', port: 443, phase: 'build', count: 3, lastAt: NOW.toISOString() }] : [],
    approvals: async () => [{ host: 'cdn.example.test', approvedBy: 'user-owner', approvedAt: NOW.toISOString() }],
};

const HEAD = 'd'.repeat(40);
const RECIPE = 'version: 1\nservices:\n  expose:\n    - { service: app, port: 3000, kind: http }\n';

/** The Git API as the product reads it for a setup (default-branch head and the recipe at that commit). */
class FakeSetupGit implements Pick<RuntimeGitPort, 'getDefaultBranchHead' | 'readFileAtCommit'> {
    head: DefaultBranchHead | Error = { status: 'ok', branch: 'main', sha: HEAD };
    recipe: string | null | 'unsupported_platform' | Error = RECIPE;
    /** .kodus/workspace.runtime.yaml, read first; none by default. */
    runtimeRecipe: string | null = null;
    /** Other root files (compose, Dockerfile, package.json) the recipe inference reads. */
    files: Record<string, string | Error> = {};
    reads: Array<{ path: string; sha: string }> = [];
    async getDefaultBranchHead() {
        if (this.head instanceof Error) throw this.head;
        return this.head;
    }
    async readFileAtCommit(input: { path: string; sha: string }) {
        this.reads.push({ path: input.path, sha: input.sha });
        if (input.path === '.kodus/workspace.runtime.yaml') return this.runtimeRecipe;
        if (input.path !== '.kodus/workspace.yaml') {
            const file = this.files[input.path];
            if (file instanceof Error) throw file;
            return file ?? null;
        }
        if (this.recipe instanceof Error) throw this.recipe;
        return this.recipe;
    }
}

class FakeTokens implements RuntimeRepoTokenIssuer {
    issued = 0;
    fail?: Error;
    async issue() {
        if (this.fail) throw this.fail;
        this.issued += 1;
        return `ghs_download_${this.issued}`;
    }
}
const OFF = { pilot: false, mode: 'off', rules: [], runOnAgentPullRequests: false, runOnNewPushes: false } as const;

const owner = user(Role.OWNER);
const repoAdmin = user(Role.REPO_ADMIN);
const contributor = user(Role.CONTRIBUTOR);
const outsider = user(Role.OWNER, { org: OTHER_ORG, uuid: 'outsider' });

async function setup(cfg: RuntimeApiConfig = config()) {
    const runs = await storeWith(
        run({ environmentId: 'env-1', state: 'regression', requestedAt: '2026-10-29T10:00:00.000Z', bootMs: 90_000 }),
        run({ environmentId: 'env-1', state: 'could_not_boot', reason: 'npm ci: ENOTFOUND registry', prNumber: 8, requestedAt: '2026-10-29T09:00:00.000Z', finishedAt: '2026-10-29T09:05:00.000Z' }),
        run({ environmentId: 'env-1', state: 'could_not_boot', reason: 'npm ci: ENOTFOUND registry', prNumber: 9, requestedAt: '2026-10-29T08:00:00.000Z', finishedAt: '2026-10-29T08:05:00.000Z' }),
        run({ environmentId: 'env-1', state: 'no_regressions', requestedAt: '2026-10-01T08:00:00.000Z', bootMs: 10_000 }),
        run({ environmentId: 'env-2', repositoryId: OTHER_REPO, repositoryName: 'acme/api', state: 'cancelled' }),
        run({ environmentId: 'env-x', organizationId: OTHER_ORG, repositoryId: 'repo-b' }),
    );
    const environments = new InMemoryEnvironments();
    const settings = new InMemorySettings();
    const outbox = new FakeOutbox();
    const authorization = realAuthorization([REPO]);
    const git = new FakeSetupGit();
    const tokens = new FakeTokens();
    const requester = new RuntimeSetupRequester(environments, git as unknown as RuntimeGitPort, tokens, outbox as any, clock, cfg);
    const reader = new RuntimeEnvironmentsReader(environments, runs, egress, clock, undefined, config());
    const get = new GetRuntimeEnvironmentUseCase(reader, authorization);
    const create = new CreateRuntimeEnvironmentUseCase(environments, orgRepos, authorization, requester, undefined, settings);
    const readSettings = new GetRuntimeSettingsUseCase(settings, orgRepos, cfg);
    return {
        environments,
        settings,
        outbox,
        git,
        tokens,
        list: new ListRuntimeEnvironmentsUseCase(reader, authorization),
        get,
        blockers: new ListEnvironmentBlockersUseCase(get),
        create,
        setupEnv: new RequestEnvironmentSetupUseCase(environments, authorization, requester),
        readSettings,
        updateOrg: new UpdateRuntimeOrgSettingsUseCase(settings, readSettings),
        updateRepo: new UpdateRuntimeRepositorySettingsUseCase(settings, orgRepos, authorization, create),
    };
}

describe('Runtime environments', () => {
    it('lists the org environments from the projection with 7-day metrics, never another org', async () => {
        const s = await setup();
        const envs = await s.list.execute({ user: contributor });
        expect(envs.map((e) => e.environmentId).sort()).toEqual(['env-1', 'env-2']);
        const env1 = envs.find((e) => e.environmentId === 'env-1')!;
        // 3 Runs this week reached the boot gate, 1 booted (in 90 s); the October Run is out of the window.
        expect(env1.metrics).toEqual({ bootRate7d: 1 / 3, readyP50Ms: 90_000, readyP90Ms: 90_000, runs7d: 3, egressBlocked: [] });
        // An environment with no finished boot this week shows no time to ready, not a zero.
        expect(envs.find((e) => e.environmentId === 'env-2')!.metrics).not.toHaveProperty('readyP50Ms');
        expect(env1).toMatchObject({ repositoryId: REPO, repositoryName: 'acme/shop', egressApprovals: [] });
        expect((await s.list.execute({ user: outsider })).map((e) => e.environmentId)).toEqual(['env-x']);
    });

    it('detail carries blocked egress and approvals; another org is 404', async () => {
        const s = await setup();
        const env = await s.get.execute({ user: contributor, environmentId: 'env-1' });
        expect(env.metrics.egressBlocked).toEqual([{ host: 'registry.example.test', port: 443, phase: 'build', count: 3, lastAt: NOW.toISOString() }]);
        expect(env.egressApprovals).toEqual([{ host: 'cdn.example.test', approvedBy: 'user-owner', approvedAt: NOW.toISOString() }]);
        await expect(s.get.execute({ user: outsider, environmentId: 'env-1' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(s.get.execute({ user: owner, environmentId: 'env-x' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(s.get.execute({ user: owner, environmentId: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('blockers group the could_not_boot reasons by signature, [] when there are none', async () => {
        const s = await setup();
        const groups = await s.blockers.execute({ user: contributor, environmentId: 'env-1' });
        expect(groups).toEqual([
            {
                signature: 'npm ci: ENOTFOUND registry',
                kind: 'unknown',
                title: 'npm ci: ENOTFOUND registry',
                count: 2,
                lastAt: '2026-10-29T09:05:00.000Z',
                lastPr: 8,
                state: 'open',
                evidence: { lines: ['npm ci: ENOTFOUND registry'] },
                fixes: [expect.objectContaining({ id: 'retry_setup', who: 'one_click' })],
            },
        ]);
        expect(await s.blockers.execute({ user: contributor, environmentId: 'env-2' })).toEqual([]);
        await expect(s.blockers.execute({ user: outsider, environmentId: 'env-1' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it('creating an environment is idempotent per repo and sends one setup command', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: repoAdmin, repositoryId: REPO });
        expect(env).toMatchObject({ organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop', state: 'setup_requested' });
        expect((await s.create.execute({ user: repoAdmin, repositoryId: REPO })).environmentId).toBe(env.environmentId);
        expect(s.outbox.events).toEqual([RuntimeCommandName.EnvironmentSetupRequested]);
        expect(s.outbox.rows[0].payload.payload).toMatchObject({
            environmentId: env.environmentId,
            organizationId: ORG,
            teamId: TEAM,
            repositoryId: REPO,
            requestedBy: { userId: repoAdmin.uuid },
            key: `${env.environmentId}:${NOW.toISOString()}`,
        });
        // A repo of another org is 404; an unassigned repo is 403 for a repo admin.
        await expect(s.create.execute({ user: owner, repositoryId: 'repo-b' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(s.create.execute({ user: repoAdmin, repositoryId: OTHER_REPO })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(s.create.execute({ user: owner, repositoryId: 7 })).rejects.toBeInstanceOf(BadRequestException);

        // The product row shows in the list next to the projection-only ones.
        expect((await s.list.execute({ user: owner })).map((e) => e.environmentId)).toContain(env.environmentId);
    });

    it('reads the Runtime-only recipe first, so a dev recipe (Runo, files.copy) can stay in workspace.yaml', async () => {
        const s = await setup();
        s.git.runtimeRecipe = 'version: 1\nservices: {compose: {public: app}}\n';
        await s.create.execute({ user: owner, repositoryId: REPO });
        expect(s.outbox.rows[0].payload.payload.recipe).toMatchObject({ path: '.kodus/workspace.runtime.yaml', content: s.git.runtimeRecipe });
        expect(s.git.reads.map((r) => r.path)).toEqual(['.kodus/workspace.runtime.yaml']);
    });

    it('the setup command carries the default-branch head, the recipe at that commit and a download token', async () => {
        const s = await setup();
        await s.create.execute({ user: owner, repositoryId: REPO });
        const cmd = s.outbox.rows[0].payload.payload;
        expect(cmd).toMatchObject({
            ref: { sha: HEAD, branch: 'main' },
            repositoryFullName: 'acme/shop',
            recipe: { path: '.kodus/workspace.yaml', sha: HEAD, content: RECIPE },
        });
        // Sealed to the setup's key: the outbox never holds the plain token.
        expect(JSON.stringify(s.outbox.rows)).not.toContain('ghs_download_1');
        expect(openSealed(cmd.repoToken, cmd.key)).toBe('ghs_download_1');
        expect(cmd.blocker).toBeUndefined();
        // The recipe is read at the head SHA, never at a branch name or a PR.
        expect(s.git.reads).toEqual([
            { path: '.kodus/workspace.runtime.yaml', sha: HEAD },
            { path: '.kodus/workspace.yaml', sha: HEAD },
        ]);
    });

    it('a default branch without a recipe or anything to infer one from still sets up, with content null and why', async () => {
        const s = await setup();
        s.git.recipe = null;
        await s.create.execute({ user: owner, repositoryId: REPO });
        const cmd = s.outbox.rows[0].payload.payload;
        expect(cmd.recipe).toEqual({
            path: '.kodus/workspace.yaml',
            sha: HEAD,
            content: null,
            inference: {
                reason: 'no_build_files',
                message: 'There is no compose file and no Dockerfile at the repository root, so Kodus has nothing to infer a recipe from.',
            },
        });
        expect(openSealed(cmd.repoToken, cmd.key)).toBe('ghs_download_1');
        // Fixed paths at the head, compose files in the cell's order, and no package.json without a Dockerfile.
        expect(s.git.reads.map((r) => `${r.path}@${r.sha.slice(0, 4)}`)).toEqual(
            ['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml', 'compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml', 'Dockerfile'].map((p) => `${p}@dddd`),
        );
    });

    it('without a recipe, the setup boots one Kodus inferred from the compose file, marked inferred', async () => {
        const s = await setup();
        s.git.recipe = null;
        s.git.files = { 'compose.yml': 'services:\n  web: { build: ., ports: ["8080:3000"] }\n  db: { image: postgres:16 }\n' };
        await s.create.execute({ user: owner, repositoryId: REPO });
        const cmd = s.outbox.rows[0].payload.payload;
        expect(cmd.recipe).toMatchObject({ path: '.kodus/workspace.yaml', sha: HEAD, origin: 'inferred' });
        expect(cmd.recipe.content).toContain('    files: [compose.yml]\n    public: web\n');
        expect(cmd.recipe.inference).toBeUndefined();
        // The first compose file found stops the probing; the Dockerfile is read for a built service's ports.
        expect(s.git.reads.map((r) => r.path)).toEqual(['.kodus/workspace.runtime.yaml', '.kodus/workspace.yaml', 'compose.yaml', 'compose.yml', 'Dockerfile']);
        expect(cmd.blocker).toBeUndefined();
    });

    it('a Dockerfile and package.json give a one-service recipe; a Git failure while inferring leaves the setup as without inference', async () => {
        const s = await setup();
        s.git.recipe = null;
        s.git.files = {
            'Dockerfile': 'FROM node:22\nCMD ["npm", "start"]\n', 'package.json': '{"dependencies":{"next":"15.0.0"}}' };
        await s.create.execute({ user: owner, repositoryId: REPO });
        expect(s.outbox.rows[0].payload.payload.recipe.content).toContain('- { service: app, port: 3000, kind: http }');

        const down = await setup();
        down.git.recipe = null;
        down.git.files = { 'compose.yaml': new Error('socket hang up') };
        await down.create.execute({ user: owner, repositoryId: REPO });
        const cmd = down.outbox.rows[0].payload.payload;
        expect(cmd.recipe).toEqual({ path: '.kodus/workspace.yaml', sha: HEAD, content: null });
        expect(cmd.blocker).toBeUndefined();
        expect(JSON.stringify(cmd)).not.toContain('socket hang up');
    });

    it('what the product cannot resolve travels as a typed blocker, and no token is minted for it', async () => {
        const cases: Array<[string, (s: Awaited<ReturnType<typeof setup>>) => void, string]> = [
            ['unsupported platform', (s) => (s.git.head = { status: 'unsupported_platform', platform: 'GITLAB' }), 'unsupported_platform'],
            ['empty repo', (s) => (s.git.head = { status: 'not_found' }), 'no_ref'],
            ['Git API down', (s) => (s.git.head = new Error('socket hang up')), 'git_unavailable'],
            ['recipe too big', (s) => (s.git.recipe = new Error('too big')), 'recipe_unreadable'],
            ['recipe on a platform that cannot read it', (s) => (s.git.recipe = 'unsupported_platform'), 'unsupported_platform'],
        ];
        for (const [name, arrange, kind] of cases) {
            const s = await setup();
            arrange(s);
            await s.create.execute({ user: owner, repositoryId: REPO });
            const cmd = s.outbox.rows[0].payload.payload;
            expect([name, cmd.blocker?.kind]).toEqual([name, kind]);
            expect([name, cmd.repoToken, s.tokens.issued]).toEqual([name, undefined, 0]);
            // The platform error text never reaches the command.
            expect(JSON.stringify(cmd)).not.toContain('socket hang up');
        }
    });

    it('a token the platform refuses is token_unavailable, with the head and recipe kept', async () => {
        const s = await setup();
        s.tokens.fail = new ServiceUnavailableException('A repository download token needs a GitHub App installation');
        await s.create.execute({ user: owner, repositoryId: REPO });
        const cmd = s.outbox.rows[0].payload.payload;
        expect(cmd.blocker).toEqual({ kind: 'token_unavailable', message: 'A repository download token needs a GitHub App installation' });
        expect(cmd.ref.sha).toBe(HEAD);
        expect(cmd.recipe.content).toBe(RECIPE);
        expect(cmd.repoToken).toBeUndefined();
    });

    it("the environment shows the worker's setup with which recipe it recorded, never the recipe text", async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const record = {
            environmentId: env.environmentId,
            organizationId: ORG,
            repositoryId: REPO,
            key: 'k',
            state: 'active' as const,
            steps: [],
            blockers: [],
            sha: HEAD,
            branch: 'main',
            refSource: 'default_branch' as const,
            recipe: { path: '.kodus/workspace.yaml', sha: HEAD, state: 'found' as const, digest: 'sha256:abc', content: RECIPE, health: '/health' },
            expose: [{ service: 'app', port: 3000, kind: 'http' as const }],
            requestedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
        };
        const reader = new RuntimeEnvironmentsReader(s.environments, await storeWith(), egress, clock, { get: async () => record });
        const view = await new GetRuntimeEnvironmentUseCase(reader, realAuthorization([REPO])).execute({ user: owner, environmentId: env.environmentId });
        expect(view.setup).toMatchObject({ state: 'active', sha: HEAD, branch: 'main', refSource: 'default_branch', expose: record.expose });
        expect(view.setup?.recipe).toEqual({ path: '.kodus/workspace.yaml', sha: HEAD, state: 'found', digest: 'sha256:abc' });
        expect(JSON.stringify(view)).not.toContain('services:');
    });

    it('an inferred recipe is shown with its text and clean boots: Kodus wrote it, so it is not repository text', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const record = {
            environmentId: env.environmentId,
            organizationId: ORG,
            repositoryId: REPO,
            key: 'k',
            state: 'active' as const,
            steps: [],
            blockers: [],
            sha: HEAD,
            recipe: { path: '.kodus/workspace.yaml', sha: HEAD, state: 'found' as const, digest: 'sha256:abc', content: RECIPE, origin: 'inferred' as const, cleanBoots: 1 },
            requestedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
        };
        const reader = new RuntimeEnvironmentsReader(s.environments, await storeWith(), egress, clock, { get: async () => record });
        const view = await new GetRuntimeEnvironmentUseCase(reader, realAuthorization([REPO])).execute({ user: owner, environmentId: env.environmentId });
        expect(view.setup?.recipe).toEqual({ path: '.kodus/workspace.yaml', sha: HEAD, state: 'found', digest: 'sha256:abc', origin: 'inferred', cleanBoots: 1, content: RECIPE });
    });

    it("a recipe Kody wrote is shown with its text, clean boots and Kody's notes", async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const record = {
            environmentId: env.environmentId,
            organizationId: ORG,
            repositoryId: REPO,
            key: 'k',
            state: 'active' as const,
            steps: [],
            blockers: [],
            sha: HEAD,
            recipe: {
                path: '.kodus/workspace.yaml',
                sha: HEAD,
                state: 'found' as const,
                digest: 'sha256:abc',
                content: RECIPE,
                origin: 'authored' as const,
                cleanBoots: 1,
                notes: 'The root compose file.',
            },
            requestedAt: NOW.toISOString(),
            updatedAt: NOW.toISOString(),
        };
        const reader = new RuntimeEnvironmentsReader(s.environments, await storeWith(), egress, clock, { get: async () => record });
        const view = await new GetRuntimeEnvironmentUseCase(reader, realAuthorization([REPO])).execute({ user: owner, environmentId: env.environmentId });
        expect(view.setup?.recipe).toEqual({
            path: '.kodus/workspace.yaml',
            sha: HEAD,
            state: 'found',
            digest: 'sha256:abc',
            origin: 'authored',
            cleanBoots: 1,
            content: RECIPE,
            notes: 'The root compose file.',
        });
    });

    it('setup again is org-scoped', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        await s.setupEnv.execute({ user: owner, environmentId: env.environmentId });
        expect(s.outbox.events).toHaveLength(2);
        await expect(s.setupEnv.execute({ user: outsider, environmentId: env.environmentId })).rejects.toBeInstanceOf(NotFoundException);
        await expect(s.setupEnv.execute({ user: contributor, environmentId: env.environmentId })).rejects.toBeInstanceOf(ForbiddenException);
    });
});

describe('Diagnostic hold', () => {
    it('only the org admin turns the hold on; the next setup request carries it and the view shows it', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock));
        await expect(update.execute({ user: repoAdmin, environmentId: env.environmentId, body: { diagnosticHold: true } })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(update.execute({ user: outsider, environmentId: env.environmentId, body: { diagnosticHold: true } })).rejects.toBeInstanceOf(NotFoundException);
        for (const bad of [{}, { diagnosticHold: 'yes' }, { diagnosticHold: true, other: 1 }, null]) {
            await expect(update.execute({ user: owner, environmentId: env.environmentId, body: bad })).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(await update.execute({ user: owner, environmentId: env.environmentId, body: { diagnosticHold: true } })).toMatchObject({ diagnosticHold: true });
        await s.setupEnv.execute({ user: owner, environmentId: env.environmentId });
        expect(s.outbox.rows[1].payload.payload).toMatchObject({ diagnosticHold: true });
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ diagnosticHold: true });
    });
});

describe('Machine size', () => {
    it("defaults to the cell's own size: no size in the setup request, null in the view", async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const setupPayload = s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.setup_requested').at(-1)!.payload.payload;
        expect(setupPayload).not.toHaveProperty('machineSize');
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ machineSize: null });
    });

    it("only the org admin picks a preset; the next setup asks its memory and CPUs, and null brings back the cell's default", async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const setupPayload = () => s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.setup_requested').at(-1)!.payload.payload;
        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock));
        for (const bad of [{ machineSize: 'huge' }, { machineSize: 16 }, { machineSize: { memoryMb: 65_536, cpus: 32 } }, { machineSize: 'Large' }]) {
            await expect(update.execute({ user: owner, environmentId: env.environmentId, body: bad })).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(update.execute({ user: repoAdmin, environmentId: env.environmentId, body: { machineSize: 'large' } })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(update.execute({ user: outsider, environmentId: env.environmentId, body: { machineSize: 'large' } })).rejects.toBeInstanceOf(NotFoundException);

        expect(await update.execute({ user: owner, environmentId: env.environmentId, body: { machineSize: 'large' } })).toMatchObject({ machineSize: 'large' });
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ machineSize: 'large' });
        await s.setupEnv.execute({ user: owner, environmentId: env.environmentId });
        expect(setupPayload()).toMatchObject({ machineSize: { memoryMb: 16_384, cpus: 8 } });
        // The size alone sends no pool request.
        expect(s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.pool_requested')).toHaveLength(0);

        await update.execute({ user: owner, environmentId: env.environmentId, body: { machineSize: 'medium' } });
        await s.setupEnv.execute({ user: owner, environmentId: env.environmentId });
        expect(setupPayload()).toMatchObject({ machineSize: { memoryMb: 8_192, cpus: 4 } });

        await update.execute({ user: owner, environmentId: env.environmentId, body: { machineSize: null } });
        await s.setupEnv.execute({ user: owner, environmentId: env.environmentId });
        expect(setupPayload()).not.toHaveProperty('machineSize');
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ machineSize: null });
    });

    it('refuses a preset above the plan ceiling and blocks a saved size after the plan is lowered', async () => {
        const plan = config({ machineSize: { maxPreset: 'medium' } });
        const s = await setup(plan);
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const setupPayload = () => s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.setup_requested').at(-1)!.payload.payload;
        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), plan, new RuntimePoolController(s.environments, plan, s.outbox, clock));
        await expect(update.execute({ user: owner, environmentId: env.environmentId, body: { machineSize: 'large' } })).rejects.toThrow(
            new BadRequestException('machineSize is at most medium on this plan'),
        );
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ machineSize: null });
        expect(await update.execute({ user: owner, environmentId: env.environmentId, body: { machineSize: 'medium' } })).toMatchObject({ machineSize: 'medium' });

        // Saved under an earlier plan: do not silently clamp the declared size.
        await s.environments.updateSettings(ORG, env.environmentId, { machineSize: 'large' });
        await s.setupEnv.execute({ user: owner, environmentId: env.environmentId });
        expect(setupPayload()).toMatchObject({
            blocker: { kind: 'resources' },
        });
        expect(setupPayload()).not.toHaveProperty('machineSize');
        expect(setupPayload()).not.toHaveProperty('repoToken');
    });
    });

describe('an invalid base recipe', () => {
    const blockerOf = (s: Awaited<ReturnType<typeof setup>>) =>
        s.outbox.rows
            .filter((r: any) => r.payload.event_name === 'runtime.environment.setup_requested')
            .at(-1)!.payload.payload.blocker;

    it("names the file and the rule it breaks, and the Runtime-only file that wins over a Runo recipe", async () => {
        const s = await setup();
        s.git.recipe = RECIPE + 'files:\n  copy: [.env]\n';
        await s.create.execute({ user: owner, repositoryId: REPO });
        const blocker = blockerOf(s);
        expect(blocker.kind).toBe('recipe_invalid');
        expect(blocker.message).toContain('.kodus/workspace.yaml');
        expect(blocker.message).toContain('files.copy is refused in a cell');
        expect(blocker.message).toContain('.kodus/workspace.runtime.yaml');
        expect(s.tokens.issued).toBe(0);
    });

    it('does not point a broken .kodus/workspace.runtime.yaml at itself', async () => {
        const s = await setup();
        s.git.runtimeRecipe = 'version: 2\n';
        await s.create.execute({ user: owner, repositoryId: REPO });
        const blocker = blockerOf(s);
        expect(blocker.kind).toBe('recipe_invalid');
        expect(blocker.message).toMatch(/^\.kodus\/workspace\.runtime\.yaml is invalid: /);
        expect(blocker.message).not.toContain('reads first');
    });
});

describe('recipe resources are resolved before the setup command', () => {
    it('puts the base recipe size into the exact command that admission will reserve', async () => {
        const s = await setup();
        s.git.recipe = RECIPE + 'size: { cpu: 4, memory: 8gb }\n';
        await s.create.execute({ user: owner, repositoryId: REPO });
        const payload = s.outbox.rows
            .filter(
                (r: any) =>
                    r.payload.event_name ===
                    'runtime.environment.setup_requested',
            )
            .at(-1)!.payload.payload;
        expect(payload.machineSize).toEqual({ cpus: 4, memoryMb: 8192 });
        expect(payload).not.toHaveProperty('blocker');
    });
    it('uses an explicit admin setting before recipe sizing', async () => {
        const s = await setup();
        s.git.recipe = RECIPE + 'size: { cpu: 4, memory: 8gb }\n';
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        await s.environments.updateSettings(ORG, env.environmentId, { machineSize: 'small' });
        await s.setupEnv.execute({
            user: owner,
            environmentId: env.environmentId,
        });
        const payload = s.outbox.rows
            .filter(
                (r: any) =>
                    r.payload.event_name ===
                    'runtime.environment.setup_requested',
            )
            .at(-1)!.payload.payload;
        expect(payload.machineSize).toEqual({ cpus: 2, memoryMb: 4096 });
    });
    it.each([
        'size: { cpu: 16, memory: 32gb }',
        'size: { cpu: 4, memory: 8gb, disk: 100gb }',
    ])(
        'blocks %s before issuing a download token or reserving a machine',
        async (size) => {
            const s = await setup();
            s.git.recipe = RECIPE + size + '\n';
            await s.create.execute({ user: owner, repositoryId: REPO });
            const payload = s.outbox.rows
                .filter(
                    (r: any) =>
                        r.payload.event_name ===
                        'runtime.environment.setup_requested',
                )
                .at(-1)!.payload.payload;
            expect(payload.blocker).toMatchObject({ kind: 'resources' });
            expect(payload).not.toHaveProperty('machineSize');
            expect(payload).not.toHaveProperty('repoToken');
            expect(s.tokens.issued).toBe(0);
    });
});

describe("Secrets in an environment's previews (docs/runtime/preview-urls.md §7)", () => {
    it('are none by default; only an owner sets them to the same as the Run, and to nothing else', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ previewSecrets: 'none' });
        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock));
        for (const bad of [{ previewSecrets: 'all' }, { previewSecrets: true }, { previewSecrets: null }]) {
            await expect(update.execute({ user: owner, environmentId: env.environmentId, body: bad })).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(update.execute({ user: repoAdmin, environmentId: env.environmentId, body: { previewSecrets: 'run' } })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(update.execute({ user: owner, environmentId: env.environmentId, body: { previewSecrets: 'run' } })).resolves.toMatchObject({ previewSecrets: 'run' });
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ previewSecrets: 'run' });
    });
});

describe("The e2e suite's settings (docs/runtime/e2e-suites.md section 13)", () => {
    const updateOf = (s: Awaited<ReturnType<typeof setup>>) =>
        new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock), undefined, new RuntimeSuiteSelection(s.outbox as any, clock));

    it('"run on every push" is the environment\'s own switch: true, false, or null for the deployment\'s default, and nothing else', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const update = updateOf(s);
        await expect(update.execute({ user: owner, environmentId: env.environmentId, body: { suiteCi: true } })).resolves.toMatchObject({ suiteCi: true });
        expect(s.environments.settingsWrites.at(-1)).toEqual({ suiteCi: true });
        await expect(update.execute({ user: owner, environmentId: env.environmentId, body: { suiteCi: null } })).resolves.toMatchObject({ suiteCi: null });
        for (const bad of [{ suiteCi: 'yes' }, { suiteCi: 1 }]) await expect(update.execute({ user: owner, environmentId: env.environmentId, body: bad })).rejects.toBeInstanceOf(BadRequestException);
        await expect(update.execute({ user: contributor, environmentId: env.environmentId, body: { suiteCi: true } })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('"run only the specs the change reaches" is the Runtime\'s state: the switch asks the worker through the outbox and writes no product column', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const before = s.outbox.rows.length;
        const update = updateOf(s);
        await update.execute({ user: owner, environmentId: env.environmentId, body: { suiteSelection: false } });
        const rows = s.outbox.rows.slice(before).filter((r: any) => r.payload.event_name === 'runtime.suite.selection_changed');
        expect(rows).toHaveLength(1);
        expect(rows[0].payload.payload).toMatchObject({ organizationId: ORG, environmentId: env.environmentId, selection: 'off', requestedBy: { userId: owner.uuid } });
        // Nothing of it in the product's settings row.
        expect(s.environments.settingsWrites.every((w) => !('suiteSelection' in w))).toBe(true);
        await update.execute({ user: owner, environmentId: env.environmentId, body: { suiteSelection: true } });
        expect(s.outbox.rows.at(-1)!.payload.payload.selection).toBe('on');
        await expect(update.execute({ user: owner, environmentId: env.environmentId, body: { suiteSelection: 'off' } })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a refused change asks the Runtime for nothing', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const before = s.outbox.rows.length;
        await expect(updateOf(s).execute({ user: contributor, environmentId: env.environmentId, body: { suiteSelection: false } })).rejects.toBeInstanceOf(ForbiddenException);
        expect(s.outbox.rows.length).toBe(before);
    });
});

describe('Pull requests from forks (ADR-030)', () => {
    it('defaults to require_approval; only the org admin changes it, to one of the three policies', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ forkPullRequests: 'require_approval' });
        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock));
        for (const bad of [{ forkPullRequests: 'always' }, { forkPullRequests: null }, { forkPullRequests: true }, { forkPullRequests: 'Run' }]) {
            await expect(update.execute({ user: owner, environmentId: env.environmentId, body: bad })).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(update.execute({ user: repoAdmin, environmentId: env.environmentId, body: { forkPullRequests: 'run' } })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(update.execute({ user: outsider, environmentId: env.environmentId, body: { forkPullRequests: 'run' } })).rejects.toBeInstanceOf(NotFoundException);
        expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ forkPullRequests: 'require_approval' });

        for (const policy of ['skip', 'run', 'require_approval'] as const) {
            expect(await update.execute({ user: owner, environmentId: env.environmentId, body: { forkPullRequests: policy } })).toMatchObject({ forkPullRequests: policy });
            expect(await s.get.execute({ user: owner, environmentId: env.environmentId })).toMatchObject({ forkPullRequests: policy });
        }
        // The policy alone sends nothing to the Runtime.
        expect(s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.pool_requested')).toHaveLength(0);
    });

    it('the environment view says a fork waits for a maintainer once the environment holds several repositories, whatever its policy says', async () => {
        const s = await setup();
        const { environmentId } = await s.create.execute({ user: owner, repositoryId: REPO });
        await s.environments.updateSettings(ORG, environmentId, { forkPullRequests: 'run' });
        const rows = new InMemoryEnvironmentRepositories(s.environments.rows);
        const reader = new RuntimeEnvironmentsReader(s.environments, await storeWith(), egress, clock, undefined, config(), undefined, new RuntimeEnvironmentMembers(s.environments, rows));
        const get = new GetRuntimeEnvironmentUseCase(reader, realAuthorization([REPO, OTHER_REPO]));
        expect(await get.execute({ user: owner, environmentId })).toMatchObject({ forkPullRequests: 'run', effectiveForkPullRequests: 'run' });

        await rows.add({ environmentId, organizationId: ORG, repositoryId: OTHER_REPO, repositoryName: 'acme/api', fullName: 'acme/api', role: 'member', alias: 'api', triggers: true, pairBranches: false });
        expect(await get.execute({ user: owner, environmentId })).toMatchObject({ forkPullRequests: 'run', effectiveForkPullRequests: 'require_approval' });
    });
});

describe('Warm pool size', () => {
    it("the plan's default goes with every setup, an admin's choice under the ceiling replaces it, null brings it back", async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const setupPayload = () => s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.setup_requested').at(-1)!.payload.payload;
        // config(): default 1, ceiling 3.
        expect(setupPayload()).toMatchObject({ poolSize: 1 });

        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock));
        for (const bad of [{ poolSize: 4 }, { poolSize: -1 }, { poolSize: 1.5 }, { poolSize: '2' }]) {
            await expect(update.execute({ user: owner, environmentId: env.environmentId, body: bad })).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(update.execute({ user: repoAdmin, environmentId: env.environmentId, body: { poolSize: 2 } })).rejects.toBeInstanceOf(ForbiddenException);

        // The validated DTO used to reach here with diagnosticHold: undefined and be refused (400).
        expect(await update.execute({ user: owner, environmentId: env.environmentId, body: { diagnosticHold: undefined, poolSize: 3 } })).toMatchObject({ poolSize: 3 });
        const pool = s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.pool_requested');
        expect(pool).toHaveLength(1);
        expect(pool[0].payload.payload).toMatchObject({ environmentId: env.environmentId, organizationId: ORG, size: 3 });
        await s.setupEnv.execute({ user: owner, environmentId: env.environmentId });
        expect(setupPayload()).toMatchObject({ poolSize: 3 });

        // Zero turns it off; null is the plan's default again.
        await update.execute({ user: owner, environmentId: env.environmentId, body: { poolSize: 0 } });
        await update.execute({ user: owner, environmentId: env.environmentId, body: { poolSize: null } });
        const sizes = s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.pool_requested').map((r: any) => r.payload.payload.size);
        expect(sizes).toEqual([3, 0, 1]);
        // The view shows the size the cell is asked for, the choice and the plan's bounds.
        expect((await s.get.execute({ user: owner, environmentId: env.environmentId })).pool).toEqual({ size: 1, setting: null, defaultSize: 1, maxSize: 3, policy: null });
        await update.execute({ user: owner, environmentId: env.environmentId, body: { poolSize: 2 } });
        expect((await s.get.execute({ user: owner, environmentId: env.environmentId })).pool).toEqual({ size: 2, setting: 2, defaultSize: 1, maxSize: 3, policy: null });
        await update.execute({ user: owner, environmentId: env.environmentId, body: { poolSize: null } });
        // The diagnostic hold alone sends no pool request.
        await update.execute({ user: owner, environmentId: env.environmentId, body: { diagnosticHold: true } });
        expect(s.outbox.rows.filter((r: any) => r.payload.event_name === 'runtime.environment.pool_requested')).toHaveLength(5);
    });

    it('a saved pool policy comes back in the view, and a bad one is a 400', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock));
        const policy = { schedule: { timezone: 'America/Sao_Paulo', days: ['mon', 'fri'], start: '08:00', end: '19:00' }, monthlyBudgetUsd: 100 };
        await update.execute({ user: owner, environmentId: env.environmentId, body: { poolSize: 2, poolPolicy: policy } });
        expect((await s.get.execute({ user: owner, environmentId: env.environmentId })).pool).toMatchObject({ size: 2, setting: 2, policy });
        await expect(update.execute({ user: owner, environmentId: env.environmentId, body: { poolPolicy: { schedule: { timezone: 'Mars/Base' } } } })).rejects.toBeInstanceOf(BadRequestException);
        await update.execute({ user: owner, environmentId: env.environmentId, body: { poolPolicy: null } });
        expect((await s.get.execute({ user: owner, environmentId: env.environmentId })).pool).toMatchObject({ policy: null });
    });

    it('a PATCH of several fields is one write of all of them', async () => {
        const s = await setup();
        const env = await s.create.execute({ user: owner, repositoryId: REPO });
        const update = new UpdateEnvironmentSettingsUseCase(s.environments, realAuthorization([REPO]), config(), new RuntimePoolController(s.environments, config(), s.outbox, clock));
        const policy = { schedule: { timezone: 'America/Sao_Paulo', days: ['mon'], start: '08:00', end: '19:00' }, monthlyBudgetUsd: 50 };
        s.environments.settingsWrites.length = 0;
        const out = await update.execute({
            user: owner,
            environmentId: env.environmentId,
            body: { diagnosticHold: true, machineSize: 'medium', forkPullRequests: 'skip', poolSize: 2, poolPolicy: policy },
        });
        expect(s.environments.settingsWrites).toEqual([{ diagnosticHold: true, machineSize: 'medium', forkPullRequests: 'skip', poolSize: 2, poolPolicy: expect.objectContaining({ monthlyBudgetUsd: 50 }) }]);
        expect(out).toMatchObject({ diagnosticHold: true, machineSize: 'medium', forkPullRequests: 'skip', poolSize: 2 });
    });

    it("the plan's ceiling bounds the default too", () => {
        expect(effectivePoolSize({ defaultSize: 5, maxSize: 2 }, null)).toBe(2);
        expect(effectivePoolSize({ defaultSize: 0, maxSize: 2 }, undefined)).toBe(0);
        expect(effectivePoolSize({ defaultSize: 1, maxSize: 2 }, 2)).toBe(2);
    });
});

describe('Set up turns a repository on', () => {
    // A developer who pressed Set up and saw the environment ready, then got
    // "Kody Runtime is off for this repository" on @kody runtime, had asked
    // for it twice. Set up is the opt-in; On request runs only when asked.
    it('Set up of a repository with no Runtime settings turns it on, on request', async () => {
        const s = await setup();
        await s.create.execute({ user: owner, repositoryId: REPO });
        const [row] = await s.settings.listRepositories(ORG);
        expect(row).toMatchObject({ repositoryId: REPO, mode: 'on_request', pilot: true, whoCanAsk: 'writers' });
    });

    it('Set up leaves a repository someone turned off as it is', async () => {
        const s = await setup();
        await s.settings.upsertRepository(ORG, { repositoryId: REPO, pilot: false, whoCanAsk: 'maintainers', mode: 'off' });
        await s.create.execute({ user: owner, repositoryId: REPO });
        expect((await s.settings.listRepositories(ORG))[0]).toMatchObject({ mode: 'off', whoCanAsk: 'maintainers' });
    });
});

describe('Runtime settings', () => {
    it('GET lists every connected repo with defaults and the budget', async () => {
        const s = await setup();
        expect(await s.readSettings.execute({ user: contributor })).toEqual({
            tokenBudgetPerDay: null,
            exercisedLinesThresholdPercent: null,
            exercisedLinesThresholdDefaultPercent: 50,
            machineUsdPerHostHour: null,
            partlyTestedCheck: null,
            repositories: [
                { repositoryId: REPO, repositoryName: 'acme/shop', ...OFF, whoCanAsk: 'writers' },
                { repositoryId: OTHER_REPO, repositoryName: 'acme/api', ...OFF, whoCanAsk: 'writers' },
            ],
        });
    });

    it('PATCH takes a positive integer or null', async () => {
        const s = await setup();
        expect((await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: 50_000 } })).tokenBudgetPerDay).toBe(50_000);
        expect((await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: null } })).tokenBudgetPerDay).toBeNull();
        for (const bad of [0, -1, 1.5, '100', undefined]) {
            await expect(s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: bad } })).rejects.toBeInstanceOf(BadRequestException);
        }
        await expect(s.updateOrg.execute({ user: owner, body: {} })).rejects.toBeInstanceOf(BadRequestException);
        expect(s.settings.budgets.get(OTHER_ORG)).toBeUndefined();
    });

    it("shows the deployment's exercised-lines threshold as the default when the org set none", async () => {
        const s = await setup(config({ exercisedLinesThresholdPercent: 70 }));
        expect(await s.readSettings.execute({ user: contributor })).toMatchObject({ exercisedLinesThresholdPercent: null, exercisedLinesThresholdDefaultPercent: 70 });
    });

    it("PATCH sets the org's exercised-lines threshold to a whole percent from 0 to 100, or null for the default, and keeps the token budget", async () => {
        const s = await setup();
        await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: 50_000 } });
        const set = await s.updateOrg.execute({ user: owner, body: { exercisedLinesThresholdPercent: 30 } });
        expect(set).toMatchObject({ tokenBudgetPerDay: 50_000, exercisedLinesThresholdPercent: 30 });
        expect((await s.updateOrg.execute({ user: owner, body: { exercisedLinesThresholdPercent: 0 } })).exercisedLinesThresholdPercent).toBe(0);
        expect((await s.updateOrg.execute({ user: owner, body: { exercisedLinesThresholdPercent: 100 } })).exercisedLinesThresholdPercent).toBe(100);
        // A token budget change keeps the threshold.
        expect(await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: 60_000 } })).toMatchObject({ tokenBudgetPerDay: 60_000, exercisedLinesThresholdPercent: 100 });
        expect((await s.updateOrg.execute({ user: owner, body: { exercisedLinesThresholdPercent: null } })).exercisedLinesThresholdPercent).toBeNull();
        for (const bad of [-1, 101, 12.5, '50', undefined]) {
            await expect(s.updateOrg.execute({ user: owner, body: { exercisedLinesThresholdPercent: bad } })).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(s.settings.thresholds.get(OTHER_ORG)).toBeUndefined();
    });

    it("PATCH sets the org's price per host-hour to a positive US$ up to 1,000, or null for none, and keeps the other settings", async () => {
        const s = await setup();
        await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: 50_000, exercisedLinesThresholdPercent: 30 } });
        const set = await s.updateOrg.execute({ user: owner, body: { machineUsdPerHostHour: 0.1344 } });
        expect(set).toMatchObject({ tokenBudgetPerDay: 50_000, exercisedLinesThresholdPercent: 30, machineUsdPerHostHour: 0.1344 });
        expect((await s.updateOrg.execute({ user: owner, body: { machineUsdPerHostHour: 1_000 } })).machineUsdPerHostHour).toBe(1_000);
        // Another setting's change keeps the price.
        expect(await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: 60_000 } })).toMatchObject({ machineUsdPerHostHour: 1_000 });
        expect((await s.updateOrg.execute({ user: owner, body: { machineUsdPerHostHour: null } })).machineUsdPerHostHour).toBeNull();
        for (const bad of [0, -0.5, 1_000.01, Number.NaN, Number.POSITIVE_INFINITY, '0.2', undefined]) {
            await expect(s.updateOrg.execute({ user: owner, body: { machineUsdPerHostHour: bad } })).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(s.settings.hostPrices.get(OTHER_ORG)).toBeUndefined();
    });

    it("PATCH sets what a partly tested check concludes, neutral or action_required, or null for the default, and keeps the other settings", async () => {
        const s = await setup();
        await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: 50_000 } });
        expect(await s.updateOrg.execute({ user: owner, body: { partlyTestedCheck: 'neutral' } })).toMatchObject({ tokenBudgetPerDay: 50_000, partlyTestedCheck: 'neutral' });
        expect(await s.updateOrg.execute({ user: owner, body: { tokenBudgetPerDay: 60_000 } })).toMatchObject({ partlyTestedCheck: 'neutral' });
        expect((await s.updateOrg.execute({ user: owner, body: { partlyTestedCheck: 'action_required' } })).partlyTestedCheck).toBe('action_required');
        expect((await s.updateOrg.execute({ user: owner, body: { partlyTestedCheck: null } })).partlyTestedCheck).toBeNull();
        for (const bad of ['success', 'failure', '', 1, undefined]) {
            await expect(s.updateOrg.execute({ user: owner, body: { partlyTestedCheck: bad } })).rejects.toBeInstanceOf(BadRequestException);
        }
        expect(s.settings.partlyTested.get(OTHER_ORG)).toBeUndefined();
    });

    it('PUT repo validates, checks the repo belongs to the org and joining the pilot creates the environment', async () => {
        const s = await setup();
        const out = await s.updateRepo.execute({ user: repoAdmin, repositoryId: REPO, body: { whoCanAsk: 'maintainers' } });
        expect(out).toEqual({ repositoryId: REPO, repositoryName: 'acme/shop', ...OFF, whoCanAsk: 'maintainers' });
        expect(s.outbox.rows).toHaveLength(0);

        const pilot = await s.updateRepo.execute({ user: repoAdmin, repositoryId: REPO, body: { pilot: true } });
        expect(pilot).toEqual({ repositoryId: REPO, repositoryName: 'acme/shop', ...OFF, pilot: true, mode: 'on_request', whoCanAsk: 'maintainers' });
        expect(s.environments.rows).toHaveLength(1);
        expect(s.outbox.events).toEqual([RuntimeCommandName.EnvironmentSetupRequested]);
        // Saving the pilot again does not ask for another setup.
        await s.updateRepo.execute({ user: repoAdmin, repositoryId: REPO, body: { pilot: true } });
        expect(s.outbox.rows).toHaveLength(1);

        await expect(s.updateRepo.execute({ user: owner, repositoryId: 'repo-b', body: { pilot: true } })).rejects.toBeInstanceOf(NotFoundException);
        await expect(s.updateRepo.execute({ user: repoAdmin, repositoryId: OTHER_REPO, body: { pilot: true } })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(s.updateRepo.execute({ user: owner, repositoryId: REPO, body: { whoCanAsk: 'everyone' } })).rejects.toBeInstanceOf(BadRequestException);
        await expect(s.updateRepo.execute({ user: owner, repositoryId: REPO, body: { pilot: 'yes' } })).rejects.toBeInstanceOf(BadRequestException);
        await expect(s.updateRepo.execute({ user: owner, repositoryId: REPO, body: {} })).rejects.toBeInstanceOf(BadRequestException);
    });
});

describe('Runtime settings: when it runs (screen 2)', () => {
    it('mode, rules and the two switches are saved; leaving off creates the environment once', async () => {
        const s = await setup();
        const rules = [{ conditions: [{ field: 'changed_paths', matches: 'db/migrations/**' }] }];
        const out = await s.updateRepo.execute({
            user: repoAdmin,
            repositoryId: REPO,
            body: { mode: 'rules', rules, runOnAgentPullRequests: true, runOnNewPushes: false },
        });
        expect(out).toMatchObject({ pilot: true, mode: 'rules', rules, runOnAgentPullRequests: true, runOnNewPushes: false });
        expect(s.outbox.events).toEqual([RuntimeCommandName.EnvironmentSetupRequested]);

        // The old pilot switch keeps the mode; switching it off is `off`, and the rules stay for later.
        expect(await s.updateRepo.execute({ user: repoAdmin, repositoryId: REPO, body: { pilot: true } })).toMatchObject({ mode: 'rules' });
        expect(await s.updateRepo.execute({ user: repoAdmin, repositoryId: REPO, body: { pilot: false } })).toMatchObject({ pilot: false, mode: 'off', rules });
        await s.updateRepo.execute({ user: repoAdmin, repositoryId: REPO, body: { mode: 'on_request' } });
        // Re-joining asks the idempotent create again; the environment already exists, so no second setup.
        expect(s.outbox.rows).toHaveLength(1);
        expect((await s.readSettings.execute({ user: contributor })).repositories[0]).toMatchObject({ mode: 'on_request', rules });
    });

    it('refuses an unknown mode, a malformed rule, mode with pilot and non-boolean switches', async () => {
        const s = await setup();
        for (const body of [
            { mode: 'auto' },
            { rules: [{ conditions: [{ field: 'author', is: 'bot' }] }] },
            { mode: 'rules', pilot: true },
            { runOnNewPushes: 'yes' },
        ]) {
            await expect(s.updateRepo.execute({ user: owner, repositoryId: REPO, body })).rejects.toBeInstanceOf(BadRequestException);
        }
    });

    it('a row written before the mode existed reads as on request when it was in the pilot', async () => {
        const s = await setup();
        s.settings.repos.push({ organizationId: ORG, repositoryId: REPO, pilot: true, whoCanAsk: 'writers' });
        expect((await s.readSettings.execute({ user: contributor })).repositories[0]).toMatchObject({ pilot: true, mode: 'on_request', rules: [] });
    });
});

describe('ClearRuntimeStopUseCase', () => {
    it('writes runtime.stop.cleared for the org; global only for the on-call', async () => {
        const outbox = new FakeOutbox();
        const clear = new ClearRuntimeStopUseCase(outbox as any, config(), clock);
        const res = await clear.execute({ user: owner, scope: 'org' });
        expect(res).toMatchObject({ scope: 'org', clearedAt: NOW.toISOString() });
        expect(outbox.events).toEqual([RuntimeCommandName.StopCleared]);
        expect(outbox.rows[0].payload.payload).toMatchObject({
            scope: 'org',
            organizationId: ORG,
            clearedBy: { userId: owner.uuid, email: owner.email },
            clearedAt: NOW.toISOString(),
        });

        await expect(clear.execute({ user: owner, scope: 'global' })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(clear.execute({ user: owner, scope: 'team' })).rejects.toBeInstanceOf(BadRequestException);
        await clear.execute({ user: user(Role.OWNER, { uuid: 'oncall-1' }), scope: 'global' });
        expect(outbox.rows[1].payload.payload.organizationId).toBeUndefined();
        expect(outbox.rows[1].payload.payload.scope).toBe('global');
    });
});

describe('percentile', () => {
    it.each([
        { values: [], p: 50, want: undefined },
        { values: [7], p: 90, want: 7 },
        { values: [30, 10, 20], p: 50, want: 20 },
        // Nearest rank: with three boots the p90 is the slowest one, a boot that happened.
        { values: [30, 10, 20], p: 90, want: 30 },
        { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], p: 90, want: 9 },
        { values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], p: 50, want: 5 },
    ])('p$p of $values is $want', ({ values, p, want }) => {
        expect(percentile(values, p)).toBe(want);
    });
});
