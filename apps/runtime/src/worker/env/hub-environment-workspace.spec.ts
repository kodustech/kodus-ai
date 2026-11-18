import { randomBytes } from 'crypto';

import { runClaimWorkspace, setupClaimWorkspace, type ClaimWorkspace, type RuntimeRunRequested } from '@libs/runtime/run';

import { shopRunRequest } from '../../e2e/fixtures';
import { devSealKey } from '../../testing/dev-seal-key';
import { type EnvironmentContext, hubEnvironments, RunDependenciesFactory } from '../dbos/run-deps.factory';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { HubClient, HubEnvironmentClient } from './hub-environment-runtime';

// A multi-repository environment's claims: the claim is of the primary, and
// every other repository goes in the acquire as `repos`, at the side's commit,
// with that side's own token, opened only for the call.

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const secrets = new SealedSecretOpener(devSealKey());
type Call = { url: string; body: any };
const hub = (calls: Call[]) =>
    new HubClient({
        cellDirectory: { reserveCell: async () => ({ cellId: 'cell-a', replicaUrl: 'https://hub-1', owner: 'kodus' as const }), replicaForClaim: async () => 'https://hub-1' },
        hubBaseUrl: 'https://hub',
        postImpl: async (url, _headers, body) => {
            calls.push({ url, body: JSON.parse(body) });
            return { status: 200, text: '{}' };
        },
    });
const repo = { provider: 'github' as const, fullName: 'acme/app', apiBase: 'https://api.github.com' };
const seal = (plain: string) => secrets.seal(plain, 'run-1');

const workspace = (): ClaimWorkspace => ({
    primary: { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', base: { sha: A, sealedToken: seal('ghs_app_base') }, pr: { sha: B, sealedToken: seal('ghs_app_pr') } },
    members: [{ repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', base: { sha: C, sealedToken: seal('ghs_bill_base') }, pr: { sha: C, sealedToken: seal('ghs_bill_pr') } }],
});

const client = (calls: Call[], ws: ClaimWorkspace | undefined) =>
    new HubEnvironmentClient(hub(calls), secrets, {
        correlationId: 'corr',
        organizationId: 'org-a',
        runId: 'run-1',
        repo,
        sealedRepoToken: seal('ghs_unused'),
        tokenBinding: 'run-1',
        imageId: 'img',
        expose: [],
        ...(ws ? { workspace: ws } : {}),
    });

const acquire = (side: 'base' | 'pr' | 'setup', sha: string) => ({ organizationId: 'org-a', environmentId: 'env-1', runId: 'run-1', ref: { side, sha }, consumer: 'runtime', idempotencyKey: `run-1:${side}:1` }) as any;

describe('HubEnvironmentClient with a workspace', () => {
    it('sends every other repository at the side commit with that side token, and the primary with its own', async () => {
        const calls: Call[] = [];
        const env = client(calls, workspace());
        await env.acquire(acquire('base', A));
        await env.acquire(acquire('pr', B));
        expect(calls[0].body).toMatchObject({
            repo,
            repoToken: 'ghs_app_base',
            repos: [{ alias: 'billing', repo: { provider: 'github', fullName: 'acme/billing', apiBase: 'https://api.github.com' }, sha: C, repoToken: 'ghs_bill_base' }],
        });
        expect(calls[1].body).toMatchObject({ repoToken: 'ghs_app_pr', repos: [{ alias: 'billing', sha: C, repoToken: 'ghs_bill_pr' }] });
    });

    it('a repository without a token for the side blocks the claim, naming it, before any token is opened or sent', async () => {
        const calls: Call[] = [];
        const ws = workspace();
        delete ws.members[0].pr.sealedToken;
        const out = await client(calls, ws).acquire(acquire('pr', B));
        expect(out).toMatchObject({
            status: 'blocked',
            blockers: [{ kind: 'other_repo', signature: 'workspace_token_missing', message: expect.stringContaining('billing'), alias: 'billing' }],
        });
        expect(calls).toHaveLength(0);
    });

    it("a primary whose alias is not the one the cell gives its name is blocked before anything is sent", async () => {
        const calls: Call[] = [];
        const ws = workspace();
        ws.primary.alias = 'core';
        const out = await client(calls, ws).acquire(acquire('base', A));
        expect(out).toMatchObject({ status: 'blocked', blockers: [{ kind: 'other_repo', signature: 'workspace_primary_alias', message: expect.stringContaining('lays it out as app'), alias: 'core' }] });
        expect(calls).toHaveLength(0);
    });

    it('a workspace of the primary alone sends no repos', async () => {
        const calls: Call[] = [];
        await client(calls, { ...workspace(), members: [] }).acquire(acquire('base', A));
        expect(calls[0].body.repoToken).toBe('ghs_app_base');
        expect('repos' in calls[0].body).toBe(false);
    });

    it('without a workspace the acquire body is the one of a single repository, key for key', async () => {
        const calls: Call[] = [];
        await client(calls, undefined).acquire(acquire('base', A));
        expect(Object.keys(calls[0].body)).toEqual(['organizationId', 'environmentId', 'runId', 'ref', 'consumer', 'idempotencyKey', 'expose', 'repo', 'repoToken']);
        expect(calls[0].body.repoToken).toBe('ghs_unused');
    });

    it('the production factory keeps the workspace of the context', async () => {
        const calls: Call[] = [];
        const env = hubEnvironments(hub(calls), secrets, { provider: 'github', apiBase: 'https://api.github.com' })({
            correlationId: 'corr',
            organizationId: 'org-a',
            runId: 'run-1',
            fullName: 'acme/app',
            sealedRepoToken: seal('ghs_unused'),
            tokenBinding: 'run-1',
            imageId: 'img',
            expose: [],
            workspace: workspace(),
        });
        await env.acquire(acquire('base', A));
        expect(calls[0].body.repos).toHaveLength(1);
    });

    it('a setup sends every repository at its default-branch head', async () => {
        const calls: Call[] = [];
        const ws = setupClaimWorkspace({
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary', sha: A, branch: 'main', sealedRepoToken: secrets.seal('ghs_app', 'setup-key') },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member', sha: C, branch: 'main', sealedRepoToken: secrets.seal('ghs_bill', 'setup-key') },
            ],
        })!;
        const env = new HubEnvironmentClient(hub(calls), secrets, { correlationId: 'c', organizationId: 'org-a', repo, sealedRepoToken: '', tokenBinding: 'setup-key', imageId: 'setup', expose: [], workspace: ws });
        await env.acquire({ ...acquire('setup', A), runId: undefined, consumer: 'setup' });
        expect(calls[0].body).toMatchObject({ repoToken: 'ghs_app', repos: [{ alias: 'billing', sha: C, repoToken: 'ghs_bill' }] });
    });
});

describe('RunDependenciesFactory.forRun with a workspace', () => {
    const contextOf = (req: RuntimeRunRequested): EnvironmentContext => {
        let captured: EnvironmentContext | undefined;
        const factory = new RunDependenciesFactory({
            environment: (ctx) => {
                captured = ctx;
                return { renew: async () => ({ status: 'gone' }) } as any;
            },
            canaryKey: randomBytes(32),
        } as any);
        factory.forRun(req);
        return captured!;
    };

    it('a PR in a member: the claim is of the primary, the PR repository a member with the request tokens', () => {
        const base = shopRunRequest();
        const req = shopRunRequest({
            runId: base.runId,
            repository: { id: 'r-bill', name: 'billing', fullName: 'acme/billing' },
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary', baseSha: C, headSha: C, source: 'default_branch', sealedRepoToken: base.repoToken },
                { repositoryId: 'r-bill', fullName: 'acme/billing', alias: 'billing', role: 'member', baseSha: base.pullRequest.baseSha, headSha: base.pullRequest.headSha, source: 'pull_request' },
            ],
        });
        const ctx = contextOf(req);
        expect(ctx.fullName).toBe('acme/app');
        expect(ctx.workspace).toEqual(runClaimWorkspace(req));
        expect(ctx.workspace!.members[0]).toMatchObject({ alias: 'billing', base: { sha: req.pullRequest.baseSha, sealedToken: req.repoToken } });
    });

    it('without a workspace the context is the one of a single repository', () => {
        const req = shopRunRequest();
        const ctx = contextOf(req);
        expect(ctx.fullName).toBe('demo/shop');
        expect('workspace' in ctx).toBe(false);
    });
});

describe('the commands of a Run whose PR is in a member repository', () => {
    it('go to that repository (exec.repository); a client of one repository sends none', async () => {
        const calls: Call[] = [];
        const env = new HubEnvironmentClient(hub(calls), secrets, {
            correlationId: 'corr', organizationId: 'org-a', runId: 'run-1', repo, sealedRepoToken: seal('ghs_unused'), tokenBinding: 'run-1', imageId: 'img', expose: [],
            workspace: workspace(), execRepository: 'billing',
        });
        await env.exec('c1', { stepId: 's1', command: 'npm test', timeoutMs: 1_000 });
        expect(calls[0].body).toMatchObject({ command: 'npm test', repository: 'billing' });
        const plain: Call[] = [];
        await client(plain, undefined).exec('c1', { stepId: 's2', command: 'npm test', timeoutMs: 1_000 });
        expect(Object.keys(plain[0].body)).toEqual(['organizationId', 'runId', 'stepId', 'command', 'timeoutMs']);
    });

    it('forRun names the member only when the PR is in one', () => {
        let captured: EnvironmentContext | undefined;
        const factory = new RunDependenciesFactory({ environment: (ctx) => ((captured = ctx), { renew: async () => ({ status: 'gone' }) } as any), canaryKey: randomBytes(32) } as any);
        const base = shopRunRequest();
        factory.forRun({
            ...base,
            workspace: [
                { repositoryId: 'r-app', fullName: 'acme/app', alias: 'app', role: 'primary', baseSha: C, headSha: C, source: 'default_branch', sealedRepoToken: base.repoToken },
                { repositoryId: base.repository.id, fullName: 'demo/shop', alias: 'shop', role: 'member', baseSha: base.pullRequest.baseSha, headSha: base.pullRequest.headSha, source: 'pull_request' },
            ],
        });
        expect(captured!.execRepository).toBe('shop');
        factory.forRun(shopRunRequest());
        expect('execRepository' in captured!).toBe(false);
    });
});
