import { FakeEnvironmentRuntime, type AcquireRequest } from '@libs/runtime/environment';
import type { RuntimeRunRequested } from '@libs/runtime/run';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { HmacCanaryVault } from '../canary/canary';
import { inMemoryRunDeps } from './testing';
import { buildReport } from './report';
import { memberPullRequestAliasOf } from '@libs/runtime/run';
import { recipeChangedInPr } from './recipe-change';
import { awaitForkApproval, runRuntimeRun } from './run-orchestrator';

// A Run of a multi-repository environment: its claims are of the primary at
// the primary's commit of each side (the PR's own when the PR is in the
// primary), and a boot blocker about one repository reaches the report with
// that repository's alias.

const C = 'c'.repeat(40);
const vault = new HmacCanaryVault();

const seed = async (h: ReturnType<typeof inMemoryRunDeps>, req: RuntimeRunRequested) =>
    h.projection.upsert(req.runId, {
        attempt: req.attempt,
        correlationId: req.correlationId,
        organizationId: req.organizationId,
        teamId: req.teamId,
        repositoryId: req.repository.id,
        repositoryName: req.repository.name,
        prNumber: req.pullRequest.number,
        headSha: req.pullRequest.headSha,
        baseSha: req.pullRequest.baseSha,
        environmentId: req.environment.environmentId,
        imageId: req.environment.imageId,
        state: 'queued',
        requestedAt: req.requestedAt,
    });

/** The shop Run with its PR in `billing`, a member, beside the primary `shop` at its default-branch head. */
const prInMember = (over: Partial<RuntimeRunRequested> = {}): RuntimeRunRequested => {
    const base = shopRunRequest(over);
    return {
        ...base,
        workspace: [
            { repositoryId: 'repo-shop-app', fullName: 'demo/shop-app', alias: 'shop-app', role: 'primary', baseSha: C, headSha: C, source: 'default_branch', sealedRepoToken: base.repoToken },
            { repositoryId: base.repository.id, fullName: 'demo/shop', alias: 'shop', role: 'member', baseSha: base.pullRequest.baseSha, headSha: base.pullRequest.headSha, source: 'pull_request' },
        ],
    };
};

describe('a Run of a multi-repository environment', () => {
    it("a PR in a member: both sides' claims boot the primary at its pinned commit", async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const refs: AcquireRequest['ref'][] = [];
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) => (refs.push(r.ref), acquire(r));
        const h = inMemoryRunDeps({ env, canaries: vault });
        const req = prInMember();
        await seed(h, req);
        await runRuntimeRun(req, h.deps);
        expect(refs.slice(0, 2).sort((a, b) => a.side.localeCompare(b.side))).toEqual([
            { side: 'base', sha: C },
            { side: 'pr', sha: C },
        ]);
    });

    it('a PR in the primary: the claims boot the pull request shas, as a Run of one repository does', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const refs: AcquireRequest['ref'][] = [];
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) => (refs.push(r.ref), acquire(r));
        const h = inMemoryRunDeps({ env, canaries: vault });
        const base = shopRunRequest();
        const req: RuntimeRunRequested = {
            ...base,
            workspace: [
                { repositoryId: base.repository.id, fullName: 'demo/shop', alias: 'shop', role: 'primary', baseSha: base.pullRequest.baseSha, headSha: base.pullRequest.headSha, source: 'pull_request' },
                { repositoryId: 'repo-billing', fullName: 'demo/billing', alias: 'billing', role: 'member', baseSha: C, headSha: C, source: 'default_branch', sealedRepoToken: base.repoToken },
            ],
        };
        await seed(h, req);
        await runRuntimeRun(req, h.deps);
        expect(refs.slice(0, 2).sort((a, b) => a.side.localeCompare(b.side))).toEqual([
            { side: 'base', sha: base.pullRequest.baseSha },
            { side: 'pr', sha: base.pullRequest.headSha },
        ]);
    });

    it("a base that does not boot because of one repository: the projection and the report name that repository's alias", async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        env.acquire = async () =>
            ({
                status: 'blocked',
                blockers: [{ kind: 'other_repo', signature: 'recipe_needs', message: 'billing cannot boot beside this repository', alias: 'billing' }],
            }) as never;
        const h = inMemoryRunDeps({ env, canaries: vault });
        const req = prInMember();
        await seed(h, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result.state).toBe('could_not_boot');
        expect((await h.projection.get(req.runId))?.bootFailure).toMatchObject({ side: 'base', kind: 'other_repo', alias: 'billing' });
        const comment = h.published.find((m) => m.kind === 'comment' && m.report);
        expect(comment?.report?.bootFailure).toEqual({ failsOnBase: true, kind: 'other_repo', alias: 'billing' });
    });
});

describe("a PR in a member the environment's recipe does not boot", () => {
    // kr-shop-billing on 2026-11-13: main's recipe had no services.needs, so billing never booted, and every probe of
    // `POST /invoices/preview` hit kr-shop's app: 404 on both sides, reported as "the same failure on both versions".
    const RECIPE = 'version: 1\nservices:\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
    const withRecipe = (content: string) => {
        const req = prInMember();
        return { ...req, environment: { ...req.environment, recipe: { path: '.kodus/workspace.yaml', content } } };
    };

    it('boots nothing and leaves every path untested, naming the member and how to boot it', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = jest.spyOn(env, 'acquire');
        const h = inMemoryRunDeps({ env, canaries: vault });
        const req = withRecipe(RECIPE);
        await seed(h, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result.state).toBe('partly_tested');
        expect(acquire).not.toHaveBeenCalled();
        const uncovered = (await h.projection.get(req.runId))?.uncovered ?? [];
        expect(uncovered.length).toBeGreaterThan(0);
        expect(uncovered.every((u) => u.reason === 'blocker' && u.blocker?.kind === 'other_repo' && u.blocker.alias === 'shop')).toBe(true);
        const report = h.published.find((m) => m.kind === 'comment' && m.report)?.report;
        expect(report).toMatchObject({ state: 'partly_tested', paths: [] });
        expect(report?.uncovered.every((u) => u.blocker?.alias === 'shop')).toBe(true);
        expect(report?.uncovered.some((u) => u.reason === 'pre_existing')).toBe(false);
    });

    it('a recipe that boots the member, by services.needs or a path to it, runs as before', async () => {
        for (const content of [
            `${RECIPE}  needs:\n    - { repo: demo/shop, alias: shop }\n`,
            `${RECIPE}  compose: [docker-compose.yml, ../shop/docker-compose.yml]\n`,
        ]) {
            const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
            const acquire = jest.spyOn(env, 'acquire');
            const h = inMemoryRunDeps({ env, canaries: vault });
            const req = withRecipe(content);
            await seed(h, req);
            await runRuntimeRun(req, h.deps);
            expect(acquire).toHaveBeenCalled();
        }
    });
});

describe("a PR in a member repository that changes its `.kodus/`", () => {
    it('reports every `.kodus/` file it changes as not applied, naming the member', () => {
        const req = prInMember({ diff: [{ path: '.kodus/workspace.yaml', patch: '+x' }, { path: '.kodus/Dockerfile', patch: '+y' }, { path: 'src/a.ts', patch: '+z' }] });
        expect(memberPullRequestAliasOf(req)).toBe('shop');
        // The primary's recipe boots: a member's own recipe and build files are never applied.
        expect(recipeChangedInPr({ ...req, environment: { ...req.environment, recipe: { path: '.kodus/workspace.yaml', content: 'version: 1\n' } } })).toEqual(['.kodus/workspace.yaml', '.kodus/Dockerfile']);
        const report = buildReport({
            req: { requestedAt: req.requestedAt, trigger: req.trigger, headSha: req.pullRequest.headSha },
            state: 'no_regressions',
            probes: [],
            steps: [],
            uncovered: [],
            recipeChangedInPr: ['.kodus/workspace.yaml'],
            recipeChangedInMember: 'shop',
        });
        expect(report).toMatchObject({ recipeChangedInPr: ['.kodus/workspace.yaml'], recipeChangedInMember: 'shop' });
    });

    it('a PR in the primary, or a Run of one repository, keeps the rule of the base recipe', () => {
        const req = shopRunRequest({ diff: [{ path: '.kodus/Dockerfile', patch: '+y' }] });
        expect(memberPullRequestAliasOf(req)).toBeUndefined();
        expect(recipeChangedInPr({ ...req, environment: { ...req.environment, recipe: { path: '.kodus/workspace.yaml', content: 'version: 1\n' } } })).toEqual([]);
        expect(buildReport({ req: { requestedAt: req.requestedAt, trigger: req.trigger, headSha: req.pullRequest.headSha }, state: 'no_regressions', probes: [], steps: [], uncovered: [], recipeChangedInMember: 'shop' })).not.toHaveProperty('recipeChangedInMember');
    });
});

describe('a fork approval of a multi-repository Run', () => {
    it("refreshes every member's tokens with the PR's, so none boots with one that expired", async () => {
        const h = inMemoryRunDeps({ canaries: vault });
        const req = prInMember();
        await seed(h, req);
        const fresh = { repoToken: 'sealed:v1:fresh-own', prRepoToken: 'sealed:v1:fresh-own-pr', runToken: 'sealed:v1:fresh-run', workspace: [{ repositoryId: 'repo-shop-app', sealedRepoToken: 'sealed:v1:fresh-app', sealedPrRepoToken: 'sealed:v1:fresh-app-pr' }] };
        const gate = await awaitForkApproval(req, { ...h.deps, approvals: { has: async () => false, wait: async () => ({ headSha: req.pullRequest.headSha, tokens: fresh }) } });
        if (!('approved' in gate)) throw new Error('not approved');
        expect(gate.approved.repoToken).toBe('sealed:v1:fresh-own');
        expect(gate.approved.workspace![0]).toMatchObject({ alias: 'shop-app', sealedRepoToken: 'sealed:v1:fresh-app', sealedPrRepoToken: 'sealed:v1:fresh-app-pr' });
        // The PR's own repository keeps fetching with the request's (fresh) repoToken and prRepoToken.
        expect(gate.approved.workspace![1]).toEqual(req.workspace![1]);
    });
});
