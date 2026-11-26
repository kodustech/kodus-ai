import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';

import type { EnvSessionOpen, EnvSessionOwner, EnvSessionView, EnvStepView } from '@libs/runtime/contracts/env-session';
import { ownsEnvSession } from '@libs/runtime/contracts/env-session';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { isSealedSecret } from '@libs/runtime/run/sealed-secret';

import { RuntimeEnvironmentMembers } from '../application/environment-members.service';
import { RuntimeEnvToolsService } from '../application/env-tools.service';
import { ListRuntimeAuditUseCase } from '../application/use-cases/env-audit.use-case';
import { ENV_EXEC_QUOTA, type EnvKeyPrincipal, EnvSessionPortError, type ProductEnvironment, type RuntimeEnvSessionPort } from '../domain/ports';
import { InMemoryEnvironmentRepositories, openSealed, SEAL_KEY } from './fixtures';
import { InMemoryRuntimeEnvAuditStore } from '../testing';

const ORG = 'org-a';
const SHA = 'b'.repeat(40);
const KEY: EnvKeyPrincipal = { keyId: 'key-a', organizationId: ORG, teamId: 'team-a', capabilities: ['env:exec', 'env:fix'], repositoryIds: ['repo-a'] };

const env = (over: Partial<ProductEnvironment> = {}): ProductEnvironment => ({
    environmentId: 'env-a',
    organizationId: ORG,
    teamId: 'team-a',
    repositoryId: 'repo-a',
    repositoryName: 'acme/shop',
    state: 'active',
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...over,
});

const blockedSetup: EnvironmentSetupRecord = {
    environmentId: 'env-a',
    organizationId: ORG,
    repositoryId: 'repo-a',
    key: 'k',
    state: 'blocked',
    steps: [],
    requestedAt: '2026-11-03T00:00:00.000Z',
    updatedAt: '2026-11-03T00:00:00.000Z',
    recipe: {
        path: '.kodus/workspace.yaml',
        sha: SHA,
        state: 'found',
        content: 'services:\n  compose:\n    file: docker-compose.yml\n    env:\n      A: b\n',
    } as any,
    blockers: [
        { kind: 'missing_env', signature: 'missing_env', message: 'Error: SESSION_SECRET is not set', at: '2026-11-03T00:00:00Z' } as any,
        { kind: 'platform', signature: 'kodus_step', message: 'repo download failed', at: '2026-11-03T00:00:00Z' } as any,
    ],
};

/** The worker's rules over an in-memory table: enough to see what reaches it. */
class FakeEnvSessionPort implements RuntimeEnvSessionPort {
    readonly sessions = new Map<string, EnvSessionView & { owner: Omit<EnvSessionOwner, 'repositoryIds'> }>();
    readonly opened: EnvSessionOpen[] = [];
    readonly execs: Array<{ sessionId: string; command: string; repository?: string }> = [];
    private find(owner: EnvSessionOwner, sessionId: string) {
        const s = this.sessions.get(sessionId);
        if (!s || !ownsEnvSession({ ...s.owner, repositoryId: s.repositoryId }, owner)) throw new EnvSessionPortError(404, 'not_found', 'not found');
        return s;
    }
    async open(req: EnvSessionOpen) {
        this.opened.push(req);
        const view = {
            sessionId: req.sessionId,
            environmentId: req.environmentId,
            repositoryId: req.repositoryId,
            sha: req.sha,
            state: 'ready' as const,
            createdAt: 'x',
            lastUsedAt: 'x',
        };
        this.sessions.set(req.sessionId, { ...view, owner: { organizationId: req.organizationId, teamId: req.teamId, keyId: req.keyId } });
        return view;
    }
    async status(owner: EnvSessionOwner, id: string) {
        const { owner: _, ...v } = this.find(owner, id);
        return v;
    }
    async validation(owner: EnvSessionOwner,id:string,name:string) {
        const session=await this.status(owner,id);
        if(name!=='lint')throw new EnvSessionPortError(409,'validation_not_found','not found');
        return {session,name,command:'pnpm lint',recipeSha:SHA,recipeDigest:'a'.repeat(64)};
    }
    async exec(owner: EnvSessionOwner, id: string, req: { stepId: string; command: string; repository?: string }): Promise<EnvStepView> {
        this.find(owner, id);
        this.execs.push({ sessionId: id, ...req });
        return { stepId: req.stepId, sessionId: id, state: 'running', command: req.command, startedAt: 'x' };
    }
    readonly uploads: Array<{ sessionId: string; stepId: string; files: Array<{ path: string; contentBase64: string; mode?: number }> }> = [];
    async upload(owner: EnvSessionOwner, id: string, req: { stepId: string; files: Array<{ path: string; contentBase64: string; mode?: number }> }) {
        this.find(owner, id);
        this.uploads.push({ sessionId: id, ...req });
        return { stepId: req.stepId, sessionId: id, files: req.files.map((f) => ({ path: f.path, bytes: Buffer.from(f.contentBase64, 'base64').length, sha256: 'c'.repeat(64) })) };
    }
    async step(_owner: EnvSessionOwner, _stepId: string): Promise<EnvStepView> {
        throw new EnvSessionPortError(404, 'not_found', 'not found');
    }
    async release(owner: EnvSessionOwner, id: string) {
        const { owner: _, ...v } = this.find(owner, id);
        return { ...v, state: 'released' as const };
    }
}

function harness(
    opts: { setup?: EnvironmentSetupRecord | null; environments?: ProductEnvironment[]; membership?: InMemoryEnvironmentRepositories; heads?: Record<string, string> } = {},
) {
    const environments = opts.environments ?? [
        env(),
        env({ environmentId: 'env-b', organizationId: 'org-b', teamId: 'team-b', repositoryId: 'repo-b' }),
        env({ environmentId: 'env-c', repositoryId: 'repo-c' }),
    ];
    const products = {
        get: async (org: string, id: string) => environments.find((e) => e.organizationId === org && e.environmentId === id) ?? null,
        findByRepository: async (org: string, repo: string) => environments.find((e) => e.organizationId === org && e.repositoryId === repo) ?? null,
        listByOrganization: async (org: string) => environments.filter((e) => e.organizationId === org),
    };
    const setupReads: Array<{ organizationId: string; environmentId: string }> = [];
    const views = {
        setup: async (organizationId: string, environmentId: string) => (
            setupReads.push({ organizationId, environmentId }), opts.setup === undefined ? blockedSetup : opts.setup
        ),
        environmentRuns: async () => [],
    } as any;
    const sessions = new FakeEnvSessionPort();
    const audit = new InMemoryRuntimeEnvAuditStore();
    const tokens: string[] = [];
    const setupRequests: any[] = [];
    const prs: any[] = [];
    let now = new Date('2026-11-03T12:00:00.000Z');
    const service = new RuntimeEnvToolsService(
        products,
        views,
        { getDefaultBranchHead: async (r: { repositoryId: string }) => ({ status: 'ok', branch: 'main', sha: opts.heads?.[r.repositoryId] ?? SHA }) },
        {
            issue: async (r: { repositoryId: string }) => {
                const token = r.repositoryId === 'repo-a' ? 'ghs_plain' : `ghs_${r.repositoryId}`;
                tokens.push(token);
                return token;
            },
        },
        { secretSealKey: SEAL_KEY },
        sessions,
        audit,
        { request: async (e: any, u: any) => (setupRequests.push({ e, u }), e) },
        { openRecipePullRequest: async (...args: any[]) => (prs.push(args), { number: 7, url: 'https://example.invalid/pr/7' }) },
        () => now,
        undefined,
        opts.membership ? new RuntimeEnvironmentMembers(products, opts.membership) : undefined,
    );
    return { service, sessions, audit, setupRequests, setupReads, prs, tokens, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe('RuntimeEnvToolsService (/mcp/env)', () => {
    it('env_up opens a session at the default branch head with the token sealed to that session', async () => {
        const h = harness();
        const view = await h.service.up(KEY, { environmentId: 'env-a' });
        expect(view.state).toBe('ready');
        const req = h.sessions.opened[0];
        expect(req).toMatchObject({
            organizationId: ORG,
            teamId: 'team-a',
            keyId: 'key-a',
            repositoryIds: ['repo-a'],
            repositoryId: 'repo-a',
            environmentId: 'env-a',
            sha: SHA,
        });
        expect(isSealedSecret(req.sealedRepoToken)).toBe(true);
        expect(openSealed(req.sealedRepoToken, `mcp:${req.sessionId}`)).toBe('ghs_plain');
        expect(JSON.stringify(req)).not.toContain('ghs_plain');
        expect(req.workspace).toBeUndefined();
    });

    /** acme/shop (primary) with acme/billing beside it, both in the key. */
    async function shopWithBilling() {
        const environments = [env()];
        const membership = new InMemoryEnvironmentRepositories(environments);
        const row = { environmentId: 'env-a', organizationId: ORG, triggers: true, pairBranches: false };
        await membership.add({ ...row, repositoryId: 'repo-a', repositoryName: 'acme/shop', fullName: 'acme/shop', role: 'primary', alias: 'shop' });
        await membership.add({ ...row, repositoryId: 'repo-billing', repositoryName: 'acme/billing', fullName: 'acme/billing', role: 'member', alias: 'billing' });
        return { environments, membership, key: { ...KEY, repositoryIds: ['repo-a', 'repo-billing'] } };
    }

    it('env_up on a multi-repository environment boots every repository at its default-branch head, each with its own token sealed to the session', async () => {
        const { environments, membership, key } = await shopWithBilling();
        const BILLING_HEAD = 'c'.repeat(40);
        const h = harness({ environments, membership, heads: { 'repo-billing': BILLING_HEAD } });
        await h.service.up(key, { environmentId: 'env-a' });
        const req = h.sessions.opened[0];
        const layout = req.workspace!.map(({ sealedRepoToken: _, ...r }) => r);
        expect(layout).toEqual([
            { repositoryId: 'repo-a', fullName: 'acme/shop', alias: 'shop', role: 'primary', sha: SHA },
            { repositoryId: 'repo-billing', fullName: 'acme/billing', alias: 'billing', role: 'member', sha: BILLING_HEAD },
        ]);
        const opened = req.workspace!.map((r) => openSealed(r.sealedRepoToken, `mcp:${req.sessionId}`));
        expect(opened).toEqual(['ghs_plain', 'ghs_repo-billing']);
        expect(JSON.stringify(req)).not.toMatch(/ghs_/);
    });

    it('env_up boots a repository at the commit the caller names for its alias, and refuses an alias or a commit the environment cannot boot', async () => {
        const { environments, membership, key } = await shopWithBilling();
        const NAMED = 'd'.repeat(40);
        const h = harness({ environments, membership });
        await h.service.up(key, { environmentId: 'env-a', commits: { billing: NAMED } });
        expect(h.sessions.opened[0].workspace!.map((r) => [r.alias, r.sha])).toEqual([
            ['shop', SHA],
            ['billing', NAMED],
        ]);
        const tokensBefore = h.tokens.length;
        await expect(h.service.up(key, { environmentId: 'env-a', commits: { payments: NAMED } })).rejects.toThrow('not a repository of this environment: shop, billing');
        await expect(h.service.up(key, { environmentId: 'env-a', commits: { billing: 'abc' } })).rejects.toThrow('full 40-character');
        await expect(h.service.up(key, { environmentId: 'env-a', sha: SHA, commits: { shop: NAMED } })).rejects.toThrow('two different commits');
        expect(h.sessions.opened).toHaveLength(1);
        expect(h.tokens).toHaveLength(tokensBefore);
    });

    it('a team key missing one repository of a multi-repository environment does not reach it: env_up opens nothing, by id, by repository or as its only one', async () => {
        const environments = [env()];
        const membership = new InMemoryEnvironmentRepositories(environments);
        const row = { environmentId: 'env-a', organizationId: ORG, triggers: true, pairBranches: false };
        await membership.add({ ...row, repositoryId: 'repo-a', repositoryName: 'acme/shop', fullName: 'acme/shop', role: 'primary', alias: 'shop' });
        await membership.add({ ...row, repositoryId: 'repo-billing', repositoryName: 'acme/billing', fullName: 'acme/billing', role: 'member', alias: 'billing' });
        const h = harness({ environments, membership });
        await expect(h.service.up(KEY, { environmentId: 'env-a' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.service.up(KEY, { repositoryId: 'repo-a' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.service.up(KEY, {})).rejects.toThrow('reaches no Kody Runtime environment');
        expect(h.sessions.opened).toEqual([]);
        expect(h.tokens).toEqual([]);
        // The key that lists both reaches it.
        expect((await h.service.up({ ...KEY, repositoryIds: ['repo-a', 'repo-billing'] }, { environmentId: 'env-a' })).environmentId).toBe('env-a');
    });

    it('env_up finds the environment by repository, or the key only one', async () => {
        const h = harness();
        expect((await h.service.up(KEY, { repositoryId: 'repo-a' })).environmentId).toBe('env-a');
        expect((await h.service.up(KEY, {})).environmentId).toBe('env-a');
    });

    it('env_up refuses a sha that is not a full commit', async () => {
        await expect(harness().service.up(KEY, { environmentId: 'env-a', sha: 'main' })).rejects.toMatchObject({ status: 400 });
    });

    it.each([
        ['env_up', (s: RuntimeEnvToolsService, k: EnvKeyPrincipal) => s.up(k, { environmentId: 'env-a' })],
        ['env_exec', (s: RuntimeEnvToolsService, k: EnvKeyPrincipal) => s.exec(k, { sessionId: 'x', command: 'node -v' })],
        ['env_step', (s: RuntimeEnvToolsService, k: EnvKeyPrincipal) => s.step(k, { stepId: 'x' })],
        ['env_down', (s: RuntimeEnvToolsService, k: EnvKeyPrincipal) => s.down(k, { sessionId: 'x' })],
    ])('%s needs exactly env:exec (env:fix, runs:read or a look-alike do not count)', async (_name, call) => {
        const h = harness();
        for (const capabilities of [['env:fix'], ['runs:read'], ['env:*'], ['env:exec:all'], []]) {
            await expect(call(h.service, { ...KEY, capabilities })).rejects.toBeInstanceOf(ForbiddenException);
        }
        expect(h.sessions.opened).toHaveLength(0);
        expect(h.sessions.execs).toHaveLength(0);
    });

    it('env_fix needs exactly env:fix; env_blockers takes either', async () => {
        const h = harness();
        await expect(
            h.service.fix({ ...KEY, capabilities: ['env:exec'] }, { environmentId: 'env-a', signature: 'kodus_step', fixId: 'retry_setup' }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(h.service.blockers({ ...KEY, capabilities: ['runs:read'] }, { environmentId: 'env-a' })).rejects.toBeInstanceOf(ForbiddenException);
        expect((await h.service.blockers({ ...KEY, capabilities: ['env:fix'] }, { environmentId: 'env-a' })).blockers.length).toBeGreaterThan(0);
        expect((await h.service.blockers({ ...KEY, capabilities: ['env:exec'] }, { environmentId: 'env-a' })).environment.environmentId).toBe('env-a');
    });

    describe('env_status', () => {
        const DAY = 24 * 3_600_000;
        const at = (msAgo: number) => new Date(Date.parse('2026-11-03T12:00:00.000Z') - msAgo).toISOString();
        const activeSetup: EnvironmentSetupRecord = {
            ...blockedSetup,
            state: 'active',
            imageId: 'img-1',
            cellId: 'cell-1',
            blockers: [],
            boots: [
                { at: at(DAY), outcome: 'ready', ms: 40_000 },
                { at: at(2 * DAY), outcome: 'failed', ms: 9_000, signature: 'missing_env' },
                { at: at(3 * DAY), outcome: 'ready', ms: 60_000 },
                { at: at(8 * DAY), outcome: 'ready', ms: 1_000 },
            ],
        } as EnvironmentSetupRecord;

        it("answers the org's own environment from its setup record, read for the caller's org", async () => {
            const h = harness({ setup: activeSetup });
            const health = await h.service.status(KEY, { environmentId: 'env-a' });
            expect(health).toEqual({
                environmentId: 'env-a',
                state: 'active',
                boots7d: 3,
                bootRate7d: 2 / 3,
                readyP50Ms: 40_000,
                imageId: 'img-1',
                cellId: 'cell-1',
                blockers: [{ signature: 'missing_env', kind: 'unknown', count: 1, lastAt: at(2 * DAY) }],
                // Which setup it read: a caller that sent a recipe waits for its own (env_recipe_submit's setupKey).
                setupKey: activeSetup.key,
            });
            expect(h.setupReads).toEqual([{ organizationId: ORG, environmentId: 'env-a' }]);
        });

        it('a blocked setup names its open blockers with their kind', async () => {
            const h = harness();
            const health = await h.service.status(KEY, { repositoryId: 'repo-a' });
            expect(health.state).toBe('blocked');
            expect(health.boots7d).toBe(0);
            expect(health.bootRate7d).toBeUndefined();
            expect(health.blockers.map((b) => [b.signature, b.kind])).toEqual(
                expect.arrayContaining([
                    ['missing_env', 'missing_env'],
                    ['kodus_step', 'platform'],
                ]),
            );
        });

        it('an environment never set up reads not_set_up', async () => {
            const h = harness({ setup: null });
            expect(await h.service.status(KEY, { environmentId: 'env-a' })).toEqual({ environmentId: 'env-a', state: 'not_set_up', boots7d: 0, blockers: [] });
        });

        it("a setup record of another org reads not_set_up: nothing of it reaches the answer", async () => {
            const h = harness({ setup: { ...activeSetup, organizationId: 'org-b' } });
            const health = await h.service.status(KEY, { environmentId: 'env-a' });
            expect(health).toEqual({ environmentId: 'env-a', state: 'not_set_up', boots7d: 0, blockers: [] });
            expect(JSON.stringify(health)).not.toContain('img-1');
        });

        it.each([
            ['another org', 'env-b'],
            ['a repo the key does not list', 'env-c'],
            ['an unknown id', 'env-z'],
        ])('S-46: %s is 404 and no setup is read', async (_name, environmentId) => {
            const h = harness({ setup: activeSetup });
            await expect(h.service.status(KEY, { environmentId })).rejects.toBeInstanceOf(NotFoundException);
            expect(h.setupReads).toHaveLength(0);
        });

        it('takes env:exec or env:fix, nothing else', async () => {
            const h = harness({ setup: activeSetup });
            await expect(h.service.status({ ...KEY, capabilities: ['runs:read'] }, { environmentId: 'env-a' })).rejects.toBeInstanceOf(ForbiddenException);
            expect(h.setupReads).toHaveLength(0);
            expect((await h.service.status({ ...KEY, capabilities: ['env:fix'] }, { environmentId: 'env-a' })).state).toBe('active');
            expect((await h.service.status({ ...KEY, capabilities: ['env:exec'] }, { environmentId: 'env-a' })).state).toBe('active');
        });
    });

    it.each([
        ['another org', 'env-b'],
        ['a repo the key does not list', 'env-c'],
        ['an unknown id', 'env-z'],
    ])('S-46: %s is 404 for env_up, env_blockers and env_fix, and nothing is opened', async (_name, environmentId) => {
        const h = harness();
        await expect(h.service.up(KEY, { environmentId })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.service.blockers(KEY, { environmentId })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.service.fix(KEY, { environmentId, signature: 'kodus_step', fixId: 'retry_setup' })).rejects.toBeInstanceOf(NotFoundException);
        expect(h.sessions.opened).toHaveLength(0);
        expect(h.setupRequests).toHaveLength(0);
        expect(h.tokens).toHaveLength(0);
    });

    it('S-46: an environment of another team in the same org is 404', async () => {
        const h = harness({ environments: [env({ teamId: 'team-b' })] });
        await expect(h.service.up(KEY, { environmentId: 'env-a' })).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([
        ['team A key with team B session', { teamId: 'team-b' }],
        ['another key of the same team', { keyId: 'key-b' }],
        ['the same key after its repo was removed', { repositoryIds: ['repo-x'] }],
    ])('S-46: %s gets 404 on env_exec and env_down and no exec reaches the worker', async (_name, other) => {
        const h = harness();
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        const foreign = { ...KEY, ...other };
        await expect(h.service.exec(foreign, { sessionId, command: 'cat .env' })).rejects.toBeInstanceOf(NotFoundException);
        await expect(h.service.down(foreign, { sessionId })).rejects.toBeInstanceOf(NotFoundException);
        expect(h.sessions.execs).toHaveLength(0);
        expect(h.audit.rows).toHaveLength(0);
    });

    it('env_exec is audited with the key, repo and redacted command, and answers the step at once', async () => {
        const h = harness();
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        const step = await h.service.exec(KEY, { sessionId, command: 'curl -H "Authorization: token ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" https://x' });
        expect(step.state).toBe('running');
        expect(h.sessions.execs).toHaveLength(1);
        const [row] = h.audit.rows;
        expect(row).toMatchObject({
            kind: 'env_exec',
            keyId: 'key-a',
            repositoryId: 'repo-a',
            environmentId: 'env-a',
            sessionId,
            outcome: 'accepted',
            at: '2026-11-03T12:00:00.000Z',
        });
        expect(row.command).not.toContain('ghp_aaaa');
        expect(row.command).toContain('[redacted:');
    });

    it('env_exec stops at the per-key quota, records the refusal and sends nothing more', async () => {
        const h = harness();
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        for (let i = 0; i < ENV_EXEC_QUOTA.perKeyPerHour; i++) await h.service.exec(KEY, { sessionId, command: 'true' });
        await expect(h.service.exec(KEY, { sessionId, command: 'true' })).rejects.toMatchObject({ status: 429 });
        expect(h.sessions.execs).toHaveLength(ENV_EXEC_QUOTA.perKeyPerHour);
        expect(h.audit.rows.at(-1)?.outcome).toBe('refused_quota');
        // The window slides: an hour later the key runs again.
        h.advance(ENV_EXEC_QUOTA.windowMs + 1);
        await expect(h.service.exec(KEY, { sessionId, command: 'true' })).resolves.toMatchObject({ state: 'running' });
    });

    it('env_exec stops at the per-org quota across keys', async () => {
        const h = harness();
        for (let i = 0; i < ENV_EXEC_QUOTA.perOrgPerHour; i++) {
            await h.audit.record({
                auditId: `a${i}`,
                kind: 'env_exec',
                organizationId: ORG,
                teamId: 'team-a',
                keyId: `other-${i % 9}`,
                repositoryId: 'repo-a',
                command: 'x',
                at: '2026-11-03T11:59:00.000Z',
                outcome: 'accepted',
            });
        }
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        await expect(h.service.exec(KEY, { sessionId, command: 'true' })).rejects.toBeInstanceOf(HttpException);
        expect(h.sessions.execs).toHaveLength(0);
    });

    it('env_exec validates the command and the timeout', async () => {
        const h = harness();
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        await expect(h.service.exec(KEY, { sessionId, command: '' })).rejects.toMatchObject({ status: 400 });
        await expect(h.service.exec(KEY, { sessionId, command: 'x', timeoutMs: 700_000 })).rejects.toMatchObject({ status: 400 });
    });

    it("env_exec runs a command in the member repository the caller names, and refuses a name that is not an alias", async () => {
        const { environments, membership, key } = await shopWithBilling();
        const h = harness({ environments, membership });
        const { sessionId } = await h.service.up(key, { environmentId: 'env-a' });
        await h.service.exec(key, { sessionId, command: 'pnpm test', repository: 'billing' });
        await h.service.exec(key, { sessionId, command: 'pnpm test' });
        expect(h.sessions.execs.map((e) => e.repository)).toEqual(['billing', undefined]);
        await expect(h.service.exec(key, { sessionId, command: 'ls', repository: '../shop' })).rejects.toMatchObject({ status: 400 });
        expect(h.sessions.execs).toHaveLength(2);
    });

    it('env_fix opens the recipe PR for a set_env fix and asks for a setup for retry_setup, both audited', async () => {
        const h = harness();
        const view = await h.service.blockers(KEY, { environmentId: 'env-a' });
        const missing = view.blockers.find((g) => g.signature === 'missing_env:SESSION_SECRET')!;
        expect(missing.fixes[0]).toMatchObject({ id: 'set_env:SESSION_SECRET', recipeDiff: expect.any(String) });
        expect(await h.service.fix(KEY, { environmentId: 'env-a', signature: missing.signature, fixId: 'set_env:SESSION_SECRET' })).toMatchObject({
            action: 'set_env',
            pullRequest: { number: 7 },
        });
        expect(h.prs[0][0]).toMatchObject({ environmentId: 'env-a', repositoryId: 'repo-a' });
        const retry = view.blockers.find((g) => g.fixes.some((f) => f.action === 'retry_setup'))!;
        expect(await h.service.fix(KEY, { environmentId: 'env-a', signature: retry.signature, fixId: 'retry_setup' })).toEqual({
            action: 'retry_setup',
            setupRequested: true,
        });
        expect(h.setupRequests[0].u).toEqual({ uuid: 'team-key:key-a' });
        expect(h.audit.rows.map((r) => r.kind)).toEqual(['env_fix', 'env_fix']);
    });

    it('env_blockers names the failed build step and carries its output, where the Runtime page keeps one line', async () => {
        const lines = ['step [build 3/5] RUN npm run build failed:', ...Array.from({ length: 30 }, (_, i) => `  src/a.ts(${i},1): error TS2322: line ${i}`), 'docker build: exit status 1: ERROR: failed to solve'];
        const failed: EnvironmentSetupRecord = {
            ...blockedSetup,
            blockers: [{ kind: 'toolchain', signature: 'compose_up', message: lines[0], at: '2026-11-03T00:00:00Z' } as any],
            failureBundle: { services: [{ name: 'boot output', state: 'failed', logTail: lines }], ports: [], disk: [], deniedEgress: [], redactions: 0, truncated: false, collectedAt: '2026-11-03T00:00:00.000Z' } as any,
        };
        const view = await harness({ setup: failed }).service.blockers(KEY, { environmentId: 'env-a' });
        const evidence = view.blockers[0].evidence!;
        expect(evidence.step).toBe('[build 3/5] RUN npm run build');
        expect(evidence.lines).toHaveLength(30);
        expect(evidence.lines.at(-1)).toBe('src/a.ts(29,1): error TS2322: line 29');
    });

    it('env_fix never approves an egress host (S-27, S-40)', async () => {
        const h = harness({ setup: { ...blockedSetup, failureBundle: { deniedEgress: [{ host: 'api.stripe.com', port: 443 }] } as any } });
        const view = await h.service.blockers(KEY, { environmentId: 'env-a' });
        const egress = view.blockers.find((g) => g.fixes.some((f) => f.action === 'approve_host'))!;
        const fix = egress.fixes.find((f) => f.action === 'approve_host')!;
        await expect(h.service.fix(KEY, { environmentId: 'env-a', signature: egress.signature, fixId: fix.id })).rejects.toBeInstanceOf(ForbiddenException);
        expect(h.audit.rows).toHaveLength(0);
    });

    it('env_fix never applies a fix the catalog does not offer, nor a by-hand one', async () => {
        const h = harness();
        await expect(h.service.fix(KEY, { environmentId: 'env-a', signature: 'missing_env:SESSION_SECRET', fixId: 'set_env:OTHER' })).rejects.toBeInstanceOf(
            NotFoundException,
        );
        await expect(
            h.service.fix(KEY, { environmentId: 'env-a', signature: 'missing_env:SESSION_SECRET', fixId: 'use_mock:SESSION_SECRET' }),
        ).rejects.toMatchObject({ status: 400 });
        expect(h.prs).toHaveLength(0);
    });

    it('a worker refusal keeps its status for the dev (quota of sessions, stop)', async () => {
        const h = harness();
        h.sessions.open = async () => {
            throw new EnvSessionPortError(429, 'key_session_quota', 'too many');
        };
        await expect(h.service.up(KEY, { environmentId: 'env-a' })).rejects.toMatchObject({ status: 429 });
    });
});

describe('ListRuntimeAuditUseCase (GET /runtime/audit)', () => {
    it("lists the org's env_exec records only, newest first, and refuses an unknown kind", async () => {
        const audit = new InMemoryRuntimeEnvAuditStore();
        await audit.record({
            auditId: '1',
            kind: 'env_exec',
            organizationId: ORG,
            teamId: 't',
            keyId: 'k',
            repositoryId: 'r',
            command: 'a',
            at: '2026-11-03T10:00:00.000Z',
            outcome: 'accepted',
        });
        await audit.record({
            auditId: '2',
            kind: 'env_exec',
            organizationId: ORG,
            teamId: 't',
            keyId: 'k',
            repositoryId: 'r',
            command: 'b',
            at: '2026-11-03T11:00:00.000Z',
            outcome: 'accepted',
        });
        await audit.record({
            auditId: '3',
            kind: 'env_exec',
            organizationId: 'org-b',
            teamId: 't',
            keyId: 'k',
            repositoryId: 'r',
            command: 'c',
            at: '2026-11-03T12:00:00.000Z',
            outcome: 'accepted',
        });
        const uc = new ListRuntimeAuditUseCase(audit);
        const user = { organization: { uuid: ORG } } as any;
        expect((await uc.execute({ user, kind: 'env_exec' })).items.map((r) => r.command)).toEqual(['b', 'a']);
        expect((await uc.execute({ user, kind: 'env_exec', before: '2026-11-03T10:30:00.000Z' })).items.map((r) => r.command)).toEqual(['a']);
        await expect(uc.execute({ user, kind: 'runs' })).rejects.toMatchObject({ status: 400 });
        await expect(uc.execute({ user, kind: 'env_exec', limit: '0' })).rejects.toMatchObject({ status: 400 });
    });
});


describe('named env validation authority and quota', () => {
    it('executes only the worker-pinned named command and audits it under the exec quota', async () => {
        const h = harness();
        const session = await h.service.up(KEY, { environmentId: 'env-a' });
        const started = await h.service.validate(KEY, { sessionId: session.sessionId, name: 'lint' });
        expect(started.state).toBe('running');
        expect(h.sessions.execs[0]).toMatchObject({ command: 'pnpm lint', validationName: 'lint', executionScope: 'workload' });
        expect(h.audit.rows.at(-1)).toMatchObject({ kind: 'env_exec', command: 'pnpm lint', outcome: 'accepted' });
    });
    it('shares the exact exec quota and tenant/key ownership before dispatch', async () => {
        const h = harness();
        const session = await h.service.up(KEY, { environmentId: 'env-a' });
        for (const key of [
            { ...KEY, keyId: 'other' },
            { ...KEY, organizationId: 'org-other' },
            { ...KEY, repositoryIds: [] },
        ])
            await expect(h.service.validate(key, { sessionId: session.sessionId, name: 'lint' })).rejects.toMatchObject({ status: 404 });
        for (let i = 0; i < ENV_EXEC_QUOTA.perKeyPerHour; i++)
            await h.service.validate(KEY, { sessionId: session.sessionId, name: 'lint' });
        await expect(h.service.validate(KEY, { sessionId: session.sessionId, name: 'lint' })).rejects.toMatchObject({ status: 429 });
        expect(h.sessions.execs).toHaveLength(ENV_EXEC_QUOTA.perKeyPerHour);
        expect(h.audit.rows.at(-1)).toMatchObject({ kind: 'env_exec', outcome: 'refused_quota' });
    });
    it('refuses command authority, unknown checks and missing exact capability', async () => {
        const h = harness();
        const session = await h.service.up(KEY, { environmentId: 'env-a' });
        for (const input of [
            { sessionId: session.sessionId, name: 'lint', command: 'other' },
            { sessionId: session.sessionId, name: 'unknown' },
        ])
            await expect(h.service.validate(KEY, input as any)).rejects.toMatchObject({ status: expect.any(Number) });
        await expect(
            h.service.validate({ ...KEY, capabilities: ['env:*'] }, { sessionId: session.sessionId, name: 'lint' }),
        ).rejects.toMatchObject({ status: 403 });
        expect(h.sessions.execs).toEqual([]);
    });
});

describe('env_upload (/mcp/env)', () => {
    const b64 = (x: string) => Buffer.from(x).toString('base64');

    it('writes the files into a ready session, audited with their paths and sizes, never their bytes', async () => {
        const h = harness();
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        const secret = 'ghp_' + 'a'.repeat(36);
        const out = await h.service.upload(KEY, { sessionId, files: [{ path: 'fixtures/users.json', contentBase64: b64(`{"token":"${secret}"}`) }] });
        expect(out.files).toEqual([{ path: 'fixtures/users.json', bytes: 52, sha256: 'c'.repeat(64) }]);
        expect(h.sessions.uploads).toHaveLength(1);
        expect(h.sessions.uploads[0].stepId).toBe(out.stepId);
        const [row] = h.audit.rows;
        expect(row).toMatchObject({ kind: 'env_upload', keyId: 'key-a', repositoryId: 'repo-a', environmentId: 'env-a', sessionId, stepId: out.stepId, outcome: 'accepted' });
        expect(row.command).toBe('upload fixtures/users.json (52 B)');
        expect(JSON.stringify(h.audit.rows)).not.toContain(b64(`{"token":"${secret}"}`));
    });

    it('shares the env_exec hourly quota: an upload counts against it and is refused past it', async () => {
        const h = harness();
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        for (let i = 0; i < ENV_EXEC_QUOTA.perKeyPerHour - 1; i++) await h.service.exec(KEY, { sessionId, command: 'true' });
        await h.service.upload(KEY, { sessionId, files: [{ path: 'a.txt', contentBase64: b64('x') }] });
        await expect(h.service.exec(KEY, { sessionId, command: 'true' })).rejects.toMatchObject({ status: 429 });
        await expect(h.service.upload(KEY, { sessionId, files: [{ path: 'b.txt', contentBase64: b64('y') }] })).rejects.toMatchObject({ status: 429 });
        expect(h.sessions.uploads).toHaveLength(1);
        expect(h.audit.rows.at(-1)).toMatchObject({ kind: 'env_upload', outcome: 'refused_quota' });
    });

    it('needs env:exec and a session of the key; refuses a malformed list before anything is recorded', async () => {
        const h = harness();
        const { sessionId } = await h.service.up(KEY, { environmentId: 'env-a' });
        await expect(h.service.upload({ ...KEY, capabilities: ['env:fix'] }, { sessionId, files: [{ path: 'a', contentBase64: b64('x') }] })).rejects.toBeInstanceOf(ForbiddenException);
        await expect(h.service.upload({ ...KEY, keyId: 'key-b' }, { sessionId, files: [{ path: 'a', contentBase64: b64('x') }] })).rejects.toBeInstanceOf(NotFoundException);
        for (const files of [undefined, [], [{ path: 'a' }], [{ path: 5, contentBase64: 'eA==' }], Array.from({ length: 33 }, (_, i) => ({ path: `f${i}`, contentBase64: 'eA==' }))]) {
            await expect(h.service.upload(KEY, { sessionId, files })).rejects.toMatchObject({ status: 400 });
        }
        expect(h.audit.rows).toHaveLength(0);
        expect(h.sessions.uploads).toHaveLength(0);
    });
});
