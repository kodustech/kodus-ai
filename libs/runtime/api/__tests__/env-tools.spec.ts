import { ForbiddenException, HttpException, NotFoundException } from '@nestjs/common';

import type { EnvSessionOpen, EnvSessionOwner, EnvSessionView, EnvStepView } from '@libs/runtime/contracts/env-session';
import { ownsEnvSession } from '@libs/runtime/contracts/env-session';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import { isSealedSecret } from '@libs/runtime/run/sealed-secret';

import { RuntimeEnvToolsService } from '../application/env-tools.service';
import { ListRuntimeAuditUseCase } from '../application/use-cases/env-audit.use-case';
import { ENV_EXEC_QUOTA, type EnvKeyPrincipal, EnvSessionPortError, type ProductEnvironment, type RuntimeEnvSessionPort } from '../domain/ports';
import { InMemoryRuntimeEnvAuditStore } from '../infrastructure/mongo-env-audit.store';
import { openSealed, SEAL_KEY } from './fixtures';

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
    readonly execs: Array<{ sessionId: string; command: string }> = [];
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
    async exec(owner: EnvSessionOwner, id: string, req: { stepId: string; command: string }): Promise<EnvStepView> {
        this.find(owner, id);
        this.execs.push({ sessionId: id, ...req });
        return { stepId: req.stepId, sessionId: id, state: 'running', command: req.command, startedAt: 'x' };
    }
    async step(_owner: EnvSessionOwner, _stepId: string): Promise<EnvStepView> {
        throw new EnvSessionPortError(404, 'not_found', 'not found');
    }
    async release(owner: EnvSessionOwner, id: string) {
        const { owner: _, ...v } = this.find(owner, id);
        return { ...v, state: 'released' as const };
    }
}

function harness(opts: { setup?: EnvironmentSetupRecord | null; environments?: ProductEnvironment[] } = {}) {
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
    const views = { setup: async () => (opts.setup === undefined ? blockedSetup : opts.setup), environmentRuns: async () => [] } as any;
    const sessions = new FakeEnvSessionPort();
    const audit = new InMemoryRuntimeEnvAuditStore();
    const tokens: string[] = [];
    const setupRequests: any[] = [];
    const prs: any[] = [];
    let now = new Date('2026-11-03T12:00:00.000Z');
    const service = new RuntimeEnvToolsService(
        products,
        views,
        { getDefaultBranchHead: async () => ({ status: 'ok', branch: 'main', sha: SHA }) },
        { issue: async () => (tokens.push('ghs_plain'), 'ghs_plain') },
        { secretSealKey: SEAL_KEY },
        sessions,
        audit,
        { request: async (e: any, u: any) => (setupRequests.push({ e, u }), e) },
        { openRecipePullRequest: async (...args: any[]) => (prs.push(args), { number: 7, url: 'https://example.invalid/pr/7' }) },
        () => now,
    );
    return { service, sessions, audit, setupRequests, prs, tokens, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
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
