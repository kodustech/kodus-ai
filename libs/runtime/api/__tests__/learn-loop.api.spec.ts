import { ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';

import { type EnvironmentSetupRecord, setupLearnScopeId } from '@libs/runtime/run';
import { recipeDigest } from '@libs/runtime/run/recipe';
import { inferRecipe } from '@libs/runtime/run/recipe-inference';
import { applyRecipeChange } from '@libs/runtime/blockers/recipe-edit';

import { RuntimeSetupRequester } from '../application/runtime-setup-requester.service';
import { ApplyBlockerFixUseCase, KODY_FIX_ORIGIN } from '../application/use-cases/apply-blocker-fix.use-case';
import { blockerGroups, EnvironmentViewBuilder } from '../application/use-cases/environments.use-cases';
import { RuntimeLlmGatewayUseCase } from '../application/use-cases/llm-gateway.use-case';
import { ProposeInferredRecipeUseCase } from '../application/use-cases/propose-inferred-recipe.use-case';
import { InvalidRunTokenError, signRunToken, signSetupToken, verifyRunToken, verifySetupToken } from '../domain/run-token';
import type { RuntimeLlmProvider } from '../domain/ports';
import { clock, config, FakeOutbox, InMemoryLlmUsage, NOW, openSealed, ORG, REPO, SECRET, storeWith, TEAM } from './fixtures';

// Kody's learn loop, product side: the setup token the command carries, the
// gateway that budgets it like a Run, and how the proven fix reaches the dev
// (the card's one-field PR, or the inferred recipe's PR).

const KEY = 'env-1:2026-10-29T12:00:00.000Z';
const SHA = 'a'.repeat(40);
const REPO_RECIPE = 'version: 1\nservices:\n  compose:\n    public: web # ready check\n  expose:\n    - { service: web, port: 3000, kind: http }\n';

const blockedSetup = (over: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
    environmentId: 'env-1',
    organizationId: ORG,
    repositoryId: REPO,
    key: KEY,
    state: 'blocked',
    steps: [],
    blockers: [
        { kind: 'not_ready', signature: 'setup:not_ready:web:3000/health', message: 'GET /health on web:3000 answered 404', at: '2026-10-29T12:01:00.000Z' },
    ],
    sha: SHA,
    branch: 'main',
    refSource: 'default_branch',
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', content: REPO_RECIPE, digest: recipeDigest(REPO_RECIPE) },
    requestedAt: '2026-10-29T12:00:00.000Z',
    updatedAt: '2026-10-29T12:05:00.000Z',
    ...over,
});

const setupToken = (patch: Record<string, unknown> = {}) =>
    `Bearer ${signSetupToken({ setupKey: KEY, environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: NOW.getTime() / 1000 + 3_600, ...patch } as any, SECRET)}`;
const learnBody = (over: Record<string, unknown> = {}) => ({
    runId: setupLearnScopeId(KEY),
    task: 'runtime.setup_learn',
    messages: [{ role: 'user', content: '{}' }],
    ...over,
});

class FakeProvider implements RuntimeLlmProvider {
    calls: any[] = [];
    async complete(input: any) {
        this.calls.push(input);
        return { text: '{"hypothesis":{"kind":"cannot_fix"}}', usage: { inputTokens: 300, outputTokens: 100 } };
    }
}

async function gateway(setup: EnvironmentSetupRecord | null = blockedSetup(), withReader = true) {
    const provider = new FakeProvider();
    const usage = new InMemoryLlmUsage();
    const reader = { get: jest.fn(async (org: string, env: string) => (setup && setup.organizationId === org && setup.environmentId === env ? setup : null)) };
    const uc = new RuntimeLlmGatewayUseCase(await storeWith(), usage, provider, config(), clock, undefined, withReader ? reader : undefined);
    return { uc, provider, usage };
}

describe('setup token', () => {
    it('names one setup; a Run token never passes as a setup token, nor the other way round', () => {
        const token = signSetupToken(
            { setupKey: KEY, environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, exp: NOW.getTime() / 1000 + 60 },
            SECRET,
        );
        expect(verifySetupToken(token, SECRET, NOW)).toMatchObject({ setupKey: KEY, environmentId: 'env-1' });
        expect(() => verifyRunToken(token, SECRET, NOW)).toThrow(InvalidRunTokenError);
        const runToken = signRunToken(
            { runId: 'r', attempt: 1, organizationId: ORG, teamId: TEAM, repositoryId: REPO, prNumber: 1, exp: NOW.getTime() / 1000 + 60 },
            SECRET,
        );
        expect(() => verifySetupToken(runToken, SECRET, NOW)).toThrow(InvalidRunTokenError);
        // Same body under the other prefix: the signature is keyed by the prefix.
        const [, body, sig] = token.split('.');
        expect(() => verifyRunToken(`krt1.${body}.${sig}`, SECRET, NOW)).toThrow(InvalidRunTokenError);
    });
});

describe('LLM gateway with a setup token', () => {
    it('serves the learn loop of the latest blocked setup, budgeted under its scope id and prNumber 0', async () => {
        const g = await gateway();
        const out = await g.uc.execute({ authorization: setupToken(), body: learnBody() });
        expect(out.text).toContain('cannot_fix');
        expect(g.provider.calls[0]).toMatchObject({
            organizationId: ORG,
            teamId: TEAM,
            runId: setupLearnScopeId(KEY),
            repositoryId: REPO,
            prNumber: 0,
            task: 'runtime.setup_learn',
        });
        expect(g.usage.rows[0]).toMatchObject({ runId: setupLearnScopeId(KEY), repositoryId: REPO, prNumber: 0, inputTokens: 300, outputTokens: 100 });
    });

    it('refuses another task, another scope id, a superseded or unblocked setup, and a missing setup reader', async () => {
        const g = await gateway();
        await expect(g.uc.execute({ authorization: setupToken(), body: learnBody({ task: 'runtime.plan' }) })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(g.uc.execute({ authorization: setupToken(), body: learnBody({ runId: setupLearnScopeId('other') }) })).rejects.toBeInstanceOf(
            ForbiddenException,
        );
        await expect(g.uc.execute({ authorization: setupToken({ exp: NOW.getTime() / 1000 - 1 }), body: learnBody() })).rejects.toBeInstanceOf(
            UnauthorizedException,
        );
        await expect(
            (await gateway(blockedSetup({ key: 'env-1:later' }))).uc.execute({ authorization: setupToken(), body: learnBody() }),
        ).rejects.toBeInstanceOf(ConflictException);
        await expect((await gateway(blockedSetup({ state: 'active' }))).uc.execute({ authorization: setupToken(), body: learnBody() })).rejects.toBeInstanceOf(
            ConflictException,
        );
        await expect((await gateway(null)).uc.execute({ authorization: setupToken(), body: learnBody() })).rejects.toBeInstanceOf(NotFoundException);
        await expect((await gateway(blockedSetup(), false)).uc.execute({ authorization: setupToken(), body: learnBody() })).rejects.toBeInstanceOf(
            ServiceUnavailableException,
        );
        expect(g.provider.calls).toHaveLength(0);
    });

    it("earlier setups of the repository never lock its learn loop out: a setup's tokens are no pull request's", async () => {
        const g = await gateway();
        // Older setups spent the per-PR limit (config: 2 500) under prNumber 0, on another day.
        await g.usage.record({ runId: setupLearnScopeId('env-1:old'), organizationId: ORG, repositoryId: REPO, prNumber: 0, task: 'runtime.setup_learn', inputTokens: 5_000, outputTokens: 0, at: new Date('2026-10-01T00:00:00Z') });
        const out = await g.uc.execute({ authorization: setupToken(), body: learnBody() });
        expect(out.text).toContain('cannot_fix');
    });

    it('stops at the token ceiling like a Run (429 llm_budget_exceeded, which the worker reads as a budget stop)', async () => {
        const g = await gateway();
        await g.uc.execute({ authorization: setupToken({ maxTokens: 400 }), body: learnBody() });
        const err = await g.uc.execute({ authorization: setupToken({ maxTokens: 400 }), body: learnBody() }).catch((e) => e);
        expect(err).toBeInstanceOf(HttpException);
        expect(err.getStatus()).toBe(429);
        expect(err.getResponse()).toMatchObject({ code: 'llm_budget_exceeded', scope: 'run' });
    });
});

describe('the setup command carries the setup token', () => {
    const env = {
        environmentId: 'env-1',
        organizationId: ORG,
        teamId: TEAM,
        repositoryId: REPO,
        repositoryName: 'acme/shop',
        state: 'active' as const,
        createdAt: '',
        updatedAt: '',
    };
    const git = {
        getDefaultBranchHead: async () => ({ status: 'ok' as const, branch: 'main', sha: SHA }),
        readFileAtCommit: async (i: { path: string }) => (i.path === '.kodus/workspace.yaml' ? REPO_RECIPE : null),
    };
    const make = (cfg = config()) => {
        const outbox = new FakeOutbox();
        const environments = { markSetupRequested: jest.fn() };
        const requester = new RuntimeSetupRequester(environments as any, git as any, { issue: async () => 'ghs_download' }, outbox as any, clock, cfg);
        return { outbox, requester };
    };

    it('sealed to the setup key, signed for that setup, with the per-Run ceiling', async () => {
        const t = make();
        await t.requester.request(env, { uuid: 'u-1' });
        const cmd = t.outbox.rows[0].payload.payload;
        expect(JSON.stringify(t.outbox.rows)).not.toContain('kst1.');
        const token = openSealed(cmd.llmToken, cmd.key);
        expect(verifySetupToken(token, SECRET, NOW)).toMatchObject({
            setupKey: cmd.key,
            environmentId: 'env-1',
            organizationId: ORG,
            teamId: TEAM,
            repositoryId: REPO,
            maxTokens: 1_000,
        });
    });

    it('without the run token secret there is no token, and the loop is off', async () => {
        const t = make(config({ runTokenSecret: undefined }));
        await t.requester.request(env, { uuid: 'u-1' });
        expect(t.outbox.rows[0].payload.payload.llmToken).toBeUndefined();
    });
});

describe('the proven fix reaches the dev', () => {
    const provenHealth = (over: Partial<NonNullable<NonNullable<EnvironmentSetupRecord['learn']>['proven']>> = {}) => {
        const edit = applyRecipeChange(REPO_RECIPE, { path: ['health'], value: '/healthz' });
        if ('error' in edit) throw new Error('fixture');
        return blockedSetup({
            learn: {
                tried: [{ signature: 'setup:not_ready:web:3000/health', count: 1 }],
                attempts: [
                    {
                        n: 1,
                        signature: 'setup:not_ready:web:3000/health',
                        fix: { id: 'set_health_path:/healthz', action: 'set_health_path', label: 'Check /healthz for the ready check' },
                        result: 'booted',
                        cleanBoots: 2,
                        setupKey: KEY,
                        at: '2026-10-29T12:04:00.000Z',
                    },
                ],
                stopped: 'proven',
                proven: {
                    signature: 'setup:not_ready:web:3000/health',
                    fix: { id: 'set_health_path:/healthz', action: 'set_health_path', label: 'Check /healthz for the ready check' },
                    change: { path: ['health'], value: '/healthz' },
                    content: edit.text,
                    digest: recipeDigest(edit.text),
                    cleanBoots: 2,
                    origin: 'repository',
                    ...over,
                },
            },
        });
    };

    it("a repository recipe: Kody's fix comes first on its card as a one-field PR, and the PR says where it came from", async () => {
        const setup = provenHealth();
        const [group] = blockerGroups(setup, []);
        expect(group.fixes[0]).toMatchObject({
            id: 'kody:set_health_path:/healthz',
            action: 'set_health_path',
            label: "Check /healthz for the ready check (Kody's fix)",
        });
        expect(group.fixes[0].recipeDiff).toContain('+    health: "/healthz"');

        const git = {
            getDefaultBranchHead: jest.fn().mockResolvedValue({ status: 'ok', branch: 'main', sha: 'f00dbabe1234' }),
            readFileAtCommit: jest.fn().mockResolvedValue(REPO_RECIPE),
            openPullRequestWithFiles: jest.fn().mockResolvedValue({ number: 41, url: 'https://github.com/acme/shop/pull/41' }),
        };
        const product = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
        const environment = {
            load: jest.fn(async () => ({ env: { environmentId: 'env-1', organizationId: ORG, repositoryId: REPO }, runs: [] })),
            setup: jest.fn().mockResolvedValue(setup),
        };
        const uc = new ApplyBlockerFixUseCase(
            environment as any,
            { get: jest.fn().mockResolvedValue(product) },
            { ensure: jest.fn() } as any,
            {} as any,
            {} as any,
            git as any,
        );
        const out = await uc.execute({
            user: { uuid: 'u', organization: { uuid: ORG } },
            environmentId: 'env-1',
            signature: group.signature,
            fixId: 'kody:set_health_path:/healthz',
        });
        expect(out).toMatchObject({ action: 'set_health_path', pullRequest: { number: 41 } });
        const pr = git.openPullRequestWithFiles.mock.calls[0][0];
        expect(pr.files[0].content).toBe(setup.learn!.proven!.content);
        expect(pr.body).toContain(KODY_FIX_ORIGIN);
    });

    it("the environment view shows the attempts, never a repository recipe's text", async () => {
        const setup = provenHealth();
        const builder = new EnvironmentViewBuilder(
            { listByOrganization: async () => [], get: async () => null } as any,
            await storeWith(),
            { blockedForRuns: async () => [], approvals: async () => [] } as any,
            clock,
            { get: async () => setup },
        );
        const view = await builder.view({ environmentId: 'env-1', organizationId: ORG, repositoryId: REPO }, [], false);
        expect(view.setup?.learn?.attempts[0]).toMatchObject({ result: 'booted', fix: { label: 'Check /healthz for the ready check' } });
        expect(view.setup?.learn?.proven).toMatchObject({ origin: 'repository', cleanBoots: 2 });
        expect(view.setup?.learn?.proven).not.toHaveProperty('content');
        expect(JSON.stringify(view)).not.toContain('# ready check');
    });

    it("an inferred recipe: the recipe PR adds it with Kody's change, rebuilt from the typed change and checked against what booted", async () => {
        const COMPOSE = 'services:\n  web: { build: ., ports: ["3000"] }\n';
        const inferred = inferRecipe({ compose: { path: 'compose.yaml', text: COMPOSE } });
        if (inferred.status !== 'inferred') throw new Error('fixture');
        const change = { path: ['env', 'SESSION_STORE_URL'] as ['env', string], value: 'http://kodus-fake.invalid' };
        const edit = applyRecipeChange(inferred.content, change);
        if ('error' in edit) throw new Error('fixture');
        const rec = (digest = recipeDigest(edit.text)) =>
            blockedSetup({
                blockers: [{ kind: 'unknown', signature: 'compose_up', message: 'compose up failed', at: '2026-10-29T12:01:00.000Z' }],
                recipe: {
                    path: '.kodus/workspace.yaml',
                    sha: SHA,
                    state: 'found',
                    content: inferred.content,
                    digest: recipeDigest(inferred.content),
                    origin: 'inferred',
                    cleanBoots: 0,
                },
                learn: {
                    tried: [],
                    attempts: [],
                    proven: {
                        signature: 'compose_up',
                        fix: { id: 'set_env:SESSION_STORE_URL', action: 'set_env', label: 'Give SESSION_STORE_URL a test value' },
                        change,
                        content: edit.text,
                        digest,
                        cleanBoots: 2,
                        origin: 'inferred',
                    },
                },
            });
        const make = (setup: EnvironmentSetupRecord) => {
            const git = {
                getDefaultBranchHead: jest.fn(async () => ({ status: 'ok', branch: 'main', sha: SHA })),
                readFileAtCommit: jest.fn(async (i: { path: string }) => (i.path === 'compose.yaml' ? COMPOSE : null)),
                openPullRequestWithFiles: jest.fn(async (_i: { body: string; files: Array<{ content: string }> }) => ({
                    number: 52,
                    url: 'https://github.com/acme/shop/pull/52',
                })),
            };
            const environment = {
                load: jest.fn(async () => ({ env: { environmentId: 'env-1', organizationId: ORG, repositoryId: REPO }, runs: [] })),
                setup: jest.fn().mockResolvedValue(setup),
            };
            const product = { environmentId: 'env-1', organizationId: ORG, teamId: TEAM, repositoryId: REPO, repositoryName: 'acme/shop' };
            return {
                git,
                uc: new ProposeInferredRecipeUseCase(
                    environment as any,
                    { get: jest.fn().mockResolvedValue(product) },
                    { ensure: jest.fn() } as any,
                    git as any,
                ),
            };
        };
        const ok = make(rec());
        await ok.uc.execute({ user: { uuid: 'u', organization: { uuid: ORG } }, environmentId: 'env-1' });
        const pr = ok.git.openPullRequestWithFiles.mock.calls[0][0];
        expect(pr.files[0].content).toBe(edit.text);
        expect(pr.body).toContain('**Give SESSION_STORE_URL a test value**');
        expect(pr.body).toContain(KODY_FIX_ORIGIN);

        const tampered = make(rec('sha256:' + '0'.repeat(64)));
        await expect(tampered.uc.execute({ user: { uuid: 'u', organization: { uuid: ORG } }, environmentId: 'env-1' })).rejects.toBeInstanceOf(
            ConflictException,
        );
        expect(tampered.git.openPullRequestWithFiles).not.toHaveBeenCalled();
    });
});
