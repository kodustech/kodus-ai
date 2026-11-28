import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { Blocked, Claim, EnvironmentRuntime } from '@libs/runtime/environment';
import { sealSecret } from '@libs/runtime/run';

import { devSealKey } from '../../testing/dev-seal-key';
import { testSetupService } from '../../testing/setup-service';
import { InMemoryEnvironmentSetupStore } from './testing';

const SHA = 'c'.repeat(40);
const KEY = 'env-1:2026-11-11T12:00:00.000Z';
const RECIPE = ['version: 1', 'services:', '  compose: { files: [docker-compose.yml], public: web, health: /ready }', '  expose:', '    - { service: web, port: 8080, kind: http }', ''].join('\n');
const cmd = (): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-11-11T12:00:00.000Z',
    key: KEY,
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: RECIPE },
    repoToken: sealSecret('ghs_download', devSealKey(), KEY),
});

const PHASES = [
    { name: 'export layers', ms: 1_260_400 },
    { name: 'yarn install', ms: 1_005_300 },
    { name: 'COPY . .', ms: 88_200 },
];

function env(acquire: () => Claim | Blocked, progress: Awaited<ReturnType<NonNullable<EnvironmentRuntime['progress']>>> = null): EnvironmentRuntime {
    return {
        acquire: async () => acquire(),
        probe: async () => ({ http: { status: 200 }, vmHealth: 'ok' }) as any,
        exec: async () => ({}) as any,
        reset: async () => undefined,
        release: async () => undefined,
        progress: async () => progress,
    };
}

const bootStep = (rec: { steps: Array<{ name: string; phases?: unknown }> }) => rec.steps.find((s) => s.name === 'boot');

describe('a setup says where its boot spent its time', () => {
    it('on the boot step of a setup that came up', async () => {
        const claim = {
            claimId: 'claim-1',
            cellId: 'cell-1',
            cellOwner: 'kodus',
            leaseExpiresAt: '',
            hardExpiresAt: '',
            observer: { id: 'obs', state: 'ready' },
            manifest: { services: [], expose: [{ service: 'web', port: 8080, kind: 'http' }], imageId: 'img', seedSha: 'none' },
            timing: { prepareMs: 2_700_000, phases: PHASES },
        } as Claim;
        const store = new InMemoryEnvironmentSetupStore();
        const rec = await testSetupService({ envForSetup: () => env(() => claim) }, store).run(cmd());
        expect(rec.state).toBe('active');
        expect(bootStep(rec)?.phases).toEqual(PHASES);
        expect(bootStep((await store.get('env-1'))!)?.phases).toEqual(PHASES);
    });

    it('on the boot step of a setup the ceiling stopped, from the last progress, with the phase it stopped in', async () => {
        const stopped = [{ name: 'export layers', ms: 1_200_000, running: true as const }, ...PHASES.slice(1)];
        const timeout: Blocked = { status: 'blocked', blockers: [{ kind: 'resources', signature: 'boot_timeout', message: 'the boot did not finish in 45 min, the most a setup waits' }], cellId: 'cell-1' };
        const rec = await testSetupService(
            { envForSetup: () => env(() => timeout, { phases: [], lines: [], updatedAt: '2026-11-11T12:45:00.000Z', bootPhases: stopped }) },
            new InMemoryEnvironmentSetupStore(),
        ).run(cmd());
        expect(rec.state).toBe('blocked');
        expect(bootStep(rec)?.phases).toEqual(stopped);
    });
});
