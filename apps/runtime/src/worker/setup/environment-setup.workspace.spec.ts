import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import { refsDigest } from '@libs/runtime/contracts/workspace';
import type { BakeRequest, Blocked, EnvironmentRuntime } from '@libs/runtime/environment';
import { type ClaimWorkspace, recipeDigest, sealSecret } from '@libs/runtime/run';

import { devSealKey } from '../../testing/dev-seal-key';
import { testSetupService } from '../../testing/setup-service';
import { InMemoryEnvironmentSetupStore } from './testing';

// A setup of a multi-repository environment boots every repository at its
// default-branch head, each with its own token; its bake is keyed by every
// commit and the recipe; a blocker about one repository names it.

const SHA = 'c'.repeat(40);
const BILLING_SHA = 'd'.repeat(40);
const KEY = 'env-1:2026-11-11T12:00:00.000Z';
const seal = (plain: string) => sealSecret(plain, devSealKey(), KEY);
const recipe = (needs = '') =>
    ['version: 1', 'services:', '  compose: { files: [docker-compose.yml], public: web, health: /ready }', '  expose:', '    - { service: web, port: 8080, kind: http }', needs, ''].join('\n');

const workspace: NonNullable<RuntimeEnvironmentSetupRequested['workspace']> = [
    { repositoryId: 'repo-1', fullName: 'acme/shop', alias: 'shop', role: 'primary', sha: SHA, branch: 'main', sealedRepoToken: seal('ghs_shop') },
    { repositoryId: 'repo-2', fullName: 'acme/billing', alias: 'billing', role: 'member', sha: BILLING_SHA, branch: 'trunk', sealedRepoToken: seal('ghs_billing') },
];

const cmd = (over: Partial<RuntimeEnvironmentSetupRequested> = {}): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    repositoryFullName: 'acme/shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-11-11T12:00:00.000Z',
    key: KEY,
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: recipe('  needs: [{ repo: acme/billing }]') },
    repoToken: seal('ghs_shop'),
    workspace,
    ...over,
});

function fakeEnv(blocked?: Blocked) {
    const bakes: Array<BakeRequest & { refsDigest?: string }> = [];
    const acquires: string[] = [];
    const env: EnvironmentRuntime = {
        acquire: async (req) => {
            acquires.push(`${req.ref.side} ${req.ref.sha.slice(0, 4)}`);
            if (blocked) return blocked;
            return { claimId: 'claim-1', cellId: 'cell-1', cellOwner: 'kodus', leaseExpiresAt: '', hardExpiresAt: '', observer: { id: 'obs', state: 'ready' }, manifest: { expose: [{ service: 'web', port: 8080, kind: 'http' }] } } as any;
        },
        probe: async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any,
        exec: async () => ({}) as any,
        reset: async () => undefined,
        release: async () => undefined,
        bake: async (req) => {
            bakes.push(req);
            return { status: 'accepted' };
        },
    };
    return { env, bakes, acquires };
}

describe('a setup of a multi-repository environment', () => {
    it('boots every repository at its head with its own token, records the commits, and keys the bake by all of them', async () => {
        const { env, bakes, acquires } = fakeEnv();
        let given: ClaimWorkspace | undefined;
        const rec = await testSetupService(
            {
                envForSetup: (input) => {
                    given = input.workspace;
                    return env;
                },
            },
            new InMemoryEnvironmentSetupStore(),
        ).run(cmd());
        expect(rec.state).toBe('active');
        expect(acquires).toEqual([`setup ${SHA.slice(0, 4)}`]);
        expect(given).toEqual({
            primary: { repositoryId: 'repo-1', fullName: 'acme/shop', alias: 'shop', base: { sha: SHA, sealedToken: workspace[0].sealedRepoToken }, pr: { sha: SHA, sealedToken: workspace[0].sealedRepoToken } },
            members: [{ repositoryId: 'repo-2', fullName: 'acme/billing', alias: 'billing', base: { sha: BILLING_SHA, sealedToken: workspace[1].sealedRepoToken }, pr: { sha: BILLING_SHA, sealedToken: workspace[1].sealedRepoToken } }],
        });
        expect(rec.workspace).toEqual([
            { repositoryId: 'repo-1', alias: 'shop', role: 'primary', sha: SHA, branch: 'main' },
            { repositoryId: 'repo-2', alias: 'billing', role: 'member', sha: BILLING_SHA, branch: 'trunk' },
        ]);
        expect(rec.steps.find((s) => s.name === 'resolve_ref')?.detail).toBe(`main ${SHA.slice(0, 12)}; billing trunk ${BILLING_SHA.slice(0, 12)}`);
        const digest = recipeDigest(cmd().recipe!.content!);
        expect(bakes).toEqual([
            {
                organizationId: 'org-1',
                environmentId: 'env-1',
                recipeSha: digest,
                sha: SHA,
                claimId: 'claim-1',
                refsDigest: refsDigest([{ repositoryId: 'repo-1', sha: SHA }, { repositoryId: 'repo-2', sha: BILLING_SHA }], digest),
            },
        ]);
        // The cell's image id names only the primary's commit: the record keeps which commits the bake holds.
        expect(rec.bakeRefsDigest).toBe(bakes[0].refsDigest);
        // No token of any repository is kept in the record.
        expect(JSON.stringify(rec)).not.toContain('sealed:');
    });

    it('a recipe that needs a repository the environment does not have is blocked before it boots, naming it', async () => {
        const { env, acquires } = fakeEnv();
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: recipe('  needs: [{ repo: acme/ledger }]') } }),
        );
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'other_repo', signature: 'recipe_needs_member', alias: 'ledger', message: expect.stringContaining('acme/ledger') });
        expect(acquires).toEqual([]);
    });

    it("a boot blocker about one repository keeps that repository's alias", async () => {
        const blocker = { kind: 'other_repo' as const, signature: 'recipe_needs', message: 'billing cannot boot beside this repository', alias: 'billing' };
        const { env } = fakeEnv({ status: 'blocked', blockers: [blocker] });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'other_repo', signature: 'recipe_needs', alias: 'billing' });
    });

    it('a setup of one repository passes no workspace, records none and bakes without refsDigest', async () => {
        const { env, bakes } = fakeEnv();
        const inputs: Array<Record<string, unknown>> = [];
        const rec = await testSetupService(
            {
                envForSetup: (input) => {
                    inputs.push(input);
                    return env;
                },
            },
            new InMemoryEnvironmentSetupStore(),
        ).run(cmd({ workspace: undefined, recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: recipe() } }));
        expect(rec.state).toBe('active');
        expect('workspace' in inputs[0]).toBe(false);
        expect(rec.workspace).toBeUndefined();
        expect(bakes[0]).not.toHaveProperty('refsDigest');
        expect(rec.bakeRefsDigest).toBeUndefined();
        expect(rec.steps.find((s) => s.name === 'resolve_ref')?.detail).toBe(`main ${SHA.slice(0, 12)}`);
    });
});
