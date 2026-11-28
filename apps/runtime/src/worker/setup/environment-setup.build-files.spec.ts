import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { EnvironmentRuntime } from '@libs/runtime/environment';
import { recipeDigest } from '@libs/runtime/run';

import { testSetupService } from '../../testing/setup-service';
import { InMemoryEnvironmentSetupStore } from './testing';

// A PR branch cut before the recipe's commit has no .kodus/ build files. The product reads them at the recipe's commit and
// sends them with the setup command; the record keeps them apart from Kody's authored files, so they stay out of the
// recipe's digest and out of the recipe files a PR's change is reported against.

const SHA = 'c'.repeat(40);
const RECIPE = 'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
const BUILD_FILES = [{ path: '.kodus/compose.yaml', content: 'services:\n  app:\n    image: node:22\n' }];

const cmd = (): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-11-25T12:00:00.000Z',
    key: 'env-1:2026-11-25T12:00:00.000Z',
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: RECIPE, buildFiles: BUILD_FILES },
});

const env: EnvironmentRuntime = {
    acquire: async () => ({ claimId: 'claim-1', cellId: 'cell-1', cellOwner: 'kodus', leaseExpiresAt: '', hardExpiresAt: '', observer: { id: 'obs', state: 'ready' }, manifest: { expose: [{ service: 'app', port: 3000, kind: 'http' }] } }) as any,
    probe: async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any,
    exec: async () => ({ stepId: 's', exitCode: 0, stdout: '', stderr: '', truncated: false, durationMs: 1, transport: 'ok' as const }),
    reset: async () => undefined,
    release: async () => undefined,
};

describe('a setup of a committed recipe that carries build files', () => {
    it("records them as the recipe's buildFiles, not as authored files, and leaves the recipe's digest as the recipe text alone", async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const rec = await testSetupService({ envForSetup: () => env }, store).run(cmd());
        expect(rec.state).toBe('active');
        expect(rec.recipe).toMatchObject({ state: 'found', content: RECIPE, buildFiles: BUILD_FILES, digest: recipeDigest(RECIPE) });
        expect(rec.recipe?.files).toBeUndefined();
        expect(rec.recipe?.origin).toBeUndefined();
    });
});

// docs/runtime/host-providers.md §8.2.2: the template's key is made from the build inputs digest the product read, so the setup
// record must keep it for the fleet, and only for a default-branch setup.
describe('a setup request that carries the build inputs digest', () => {
    const INPUTS = 'b'.repeat(64);
    it("records it on the setup, next to the recipe's digest, for the fleet to key the template on", async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const rec = await testSetupService({ envForSetup: () => env }, store).run({ ...cmd(), buildInputsDigest: INPUTS });
        expect(rec.buildInputsDigest).toBe(INPUTS);
    });
    it('records none when the product sent none', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const rec = await testSetupService({ envForSetup: () => env }, store).run(cmd());
        expect(rec.buildInputsDigest).toBeUndefined();
    });
});
