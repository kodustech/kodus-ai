import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import { classifyBlocker } from '@libs/runtime/blockers/catalog';
import type { EnvironmentRuntime } from '@libs/runtime/environment';

import { recipeDigest, sealSecret } from '@libs/runtime/run';

import { CellUnavailableError } from '../../shared/errors';
import { devSealKey } from '../../testing/dev-seal-key';
import { testSetupService } from '../../testing/setup-service';
import { HttpRecipeAuthorClient, type RecipeAuthorClient, type RecipeAuthorOutcome, type RecipeAuthorRequestInput } from '../agent/http-recipe-author';
import { poolCellOf } from '../dbos/run-deps.factory';
import { capacityBlocked } from '../env/hub-environment-runtime';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { InMemoryLessonStore } from './lesson.store';
import { InMemoryEnvironmentSetupStore, loadSetupOptions, type SetupStepRunner, BLOCKER_MESSAGE_MAX, blockerMessage, BOOT_PROGRESS_POLL_MS, carriedBuildCell } from './environment-setup.service';

const SHA = 'c'.repeat(40);
const KEY = 'env-1:2026-10-30T12:00:00.000Z';
const SEALED = sealSecret('ghs_download', devSealKey(), KEY);
const RECIPE = [
    'version: 1',
    'services:',
    '  compose: { files: [docker-compose.yml], public: web, health: /ready }',
    '  expose:',
    '    - { service: db, port: 5432, kind: postgres }',
    '    - { service: web, port: 8080, kind: http }',
    '',
].join('\n');
const cmd = (over: Partial<RuntimeEnvironmentSetupRequested> = {}): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-10-30T12:00:00.000Z',
    key: KEY,
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: RECIPE },
    // Sealed by the product for this setup (bound to its key).
    repoToken: SEALED,
    ...over,
});

const EXPOSE = [{ service: 'app', port: 3000, kind: 'http' as const }];
const RECIPE_EXPOSE = [
    { service: 'db', port: 5432, kind: 'postgres' as const },
    { service: 'web', port: 8080, kind: 'http' as const },
];

const BUNDLE = {
    services: [{ name: 'app', state: 'exited (1)', logTail: ['Error: connect ECONNREFUSED db:5432', 'key [redacted:aws-access-token]'] }],
    ports: [{ service: 'app', port: 3000, listening: false }],
    disk: [{ path: '/', totalBytes: 100, freeBytes: 1 }],
    deniedEgress: [{ host: 'registry.npmjs.org', port: 443, at: '2026-10-30T12:00:01Z' }],
    redactions: 1,
    truncated: false,
    collectedAt: '2026-10-30T12:00:02Z',
};

function fakeEnv(opts: { blocked?: boolean; status?: number; manifest?: typeof EXPOSE | []; held?: boolean; bake?: string; pool?: string } = {}) {
    const calls: string[] = [];
    const env: EnvironmentRuntime = {
        acquire: async (req) => {
            calls.push(`acquire ${req.consumer} ${req.ref.side} ${req.ref.sha.slice(0, 4)}${req.diagnosticHold ? ' hold' : ''}${req.seedsCache ? '' : ' no-seed'}`);
            if (opts.held) {
                return {
                    status: 'blocked',
                    blockers: [{ kind: 'platform', signature: 'repo_upload', message: 'compose up failed', bundle: BUNDLE }],
                    held: { claimId: 'claim-held', cellId: 'cell-1', hardExpiresAt: '2026-10-30T12:45:00.000Z' },
                };
            }
            if (opts.blocked)
                return { status: 'blocked', blockers: [{ kind: 'no_recipe', signature: 'localdocker:no_environment', message: 'no compose file and no Dockerfile' }], cellId: 'cell-built' };
            return {
                claimId: 'claim-1',
                cellId: 'cell-1',
                cellOwner: 'kodus',
                leaseExpiresAt: '',
                hardExpiresAt: '',
                observer: { id: 'obs', state: 'ready' },
                manifest: { expose: opts.manifest ?? EXPOSE },
            } as any;
        },
        probe: async (_c, probe) => {
            calls.push(`probe ${probe.spec.kind === 'http' ? `${probe.spec.target.service} ${probe.spec.path}` : ''}`);
            return { http: { status: opts.status ?? 200 }, vmHealth: 'ok' } as any;
        },
        exec: async () => ({}) as any,
        reset: async () => undefined,
        release: async (id) => {
            calls.push(`release ${id}`);
        },
        ...(opts.bake
            ? {
                  bake: async (req) => {
                      calls.push(`bake ${req.claimId} ${req.sha.slice(0, 4)}`);
                      return opts.bake === 'accepted' ? { status: 'accepted' as const } : { status: 'refused' as const, code: opts.bake!, message: 'no' };
                  },
              }
            : {}),
        ...(opts.pool
            ? {
                  poolTarget: async (req) => {
                      calls.push(`pool ${req.cellId} ${req.size} via ${req.claimId}`);
                      return opts.pool === 'accepted' ? { status: 'accepted' as const } : { status: 'refused' as const, code: opts.pool!, message: 'no' };
                  },
              }
            : {}),
    };
    return { env, calls };
}

describe('EnvironmentSetupService', () => {
    it.each([
        'size: { cpu: 4, memory: 8gb }',
        'size: { cpu: 4, memory: 8gb, disk: 100gb }',
    ])(
        'refuses an unsupported/unreserved recipe requirement before acquire: %s',
        async (size) => {
            const { env, calls } = fakeEnv();
            const rec = await testSetupService(
                { envForSetup: () => env },
                new InMemoryEnvironmentSetupStore(),
            ).run(
                cmd({
                    recipe: {
                        path: '.kodus/workspace.yaml',
                        sha: SHA,
                        content: RECIPE + size + '\n',
                    },
                }),
            );
            expect(rec.state).toBe('blocked');
            expect(rec.blockers[0]).toMatchObject({ kind: 'resources' });
            expect(calls.some((c) => c.startsWith('acquire'))).toBe(false);
        },
    );
    it.each(['resources', 'recipe_invalid'] as const)('never bypasses a product %s refusal through a dev SHA override', async (kind) => {
        const { env, calls } = fakeEnv();
        const request = cmd({ blocker: { kind, message: 'The declared recipe requirements are blocked.' } });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { devSha: 'd'.repeat(40), devExpose: EXPOSE }).run(request);
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind, message: request.blocker!.message });
        expect(calls).toEqual([]);
    });
    it('preserves the product resource blocker even when admission refused the already blocked setup', async () => {
        const { env, calls } = fakeEnv();
        const request = cmd({
            blocker: {
                kind: 'resources',
                message: 'The recipe requires disk enforcement.',
            },
        });
        const rec = await testSetupService(
            { envForSetup: () => env },
            new InMemoryEnvironmentSetupStore(),
        ).run(request, undefined, undefined, {
            admissionBlocker: {
                kind: 'resources',
                signature: 'unavailable',
                message: 'Admission unavailable',
            },
        });
        expect(rec.blockers[0]).toMatchObject({
            kind: 'resources',
            message: 'The recipe requires disk enforcement.',
        });
        expect(calls).toEqual([]);
    });

    it("keeps the cell's boot progress on the record, read live while the boot runs", async () => {
        jest.useFakeTimers();
        try {
            const { env } = fakeEnv();
            const progress = { phases: [{ phase: 'fetch', state: 'done' as const, at: '2026-11-04T17:00:09Z', ms: 9323 }], lines: ['#13 RUN go mod download'], updatedAt: '2026-11-04T17:00:10Z' };
            const store = new InMemoryEnvironmentSetupStore();
            const live: unknown[] = [];
            const saveProgress = store.saveProgress.bind(store);
            store.saveProgress = async (id, key, p) => {
                live.push(p);
                await saveProgress(id, key, p);
            };
            let release!: () => void;
            const booting = new Promise<void>((r) => (release = r));
            const acquire = env.acquire.bind(env);
            env.acquire = async (req) => {
                await booting;
                return acquire(req);
            };
            env.progress = async (req) =>
                req.idempotencyKey.startsWith('setup:') ? progress : null;
            const run = testSetupService({ envForSetup: () => env }, store).run(cmd());
            await jest.advanceTimersByTimeAsync(BOOT_PROGRESS_POLL_MS * 2);
            expect(live).toEqual([progress]);
            expect((await store.get(cmd().environmentId))?.progress).toEqual(progress);
            release();
            await jest.runOnlyPendingTimersAsync();
            const rec = await run;
            expect(rec.state).toBe('active');
            expect(rec.progress).toEqual(progress);
            // An active setup leaves what it took for the next one to show.
            expect(rec.lastActive).toEqual({ finishedAt: rec.finishedAt, totalMs: Date.parse(rec.finishedAt!) - Date.parse(rec.requestedAt), phases: [{ phase: 'fetch', ms: 9323 }] });
        } finally {
            jest.useRealTimers();
        }
    });

    it('a new setup carries the last active one, and a blocked setup keeps it', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const lastActive = { finishedAt: '2026-10-29T10:12:00.000Z', totalMs: 720_000, phases: [{ phase: 'compose', ms: 600_000 }] };
        await store.save({
            environmentId: 'env-1',
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            key: 'old',
            state: 'active',
            steps: [],
            blockers: [],
            requestedAt: '2026-10-29T10:00:00.000Z',
            updatedAt: '2026-10-29T10:12:00.000Z',
            finishedAt: '2026-10-29T10:12:00.000Z',
            lastActive,
        });
        const { env } = fakeEnv();
        env.acquire = async () => ({ status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'boom' }] });
        const rec = await testSetupService({ envForSetup: () => env }, store).run(cmd({ key: 'new' }));
        expect(rec.state).toBe('blocked');
        expect(rec.lastActive).toEqual(lastActive);
    });

    it('boots the default-branch commit, checks /health, releases and ends active with the expose list', async () => {
        const { env, calls } = fakeEnv();
        const store = new InMemoryEnvironmentSetupStore();
        const rec = await testSetupService({ envForSetup: () => env }, store).run(cmd());
        expect(rec.state).toBe('active');
        expect(rec.steps.map((s) => `${s.name}:${s.state}`)).toEqual(['requested:done', 'resolve_ref:done', 'recipe:done', 'boot:done', 'ready:done', 'bake:skipped', 'pool:skipped', 'release:done']);
        expect(rec.expose).toEqual(EXPOSE);
        expect(rec).toMatchObject({ sha: SHA, branch: 'main', refSource: 'default_branch' });
        expect(calls).toEqual(['acquire setup setup cccc', 'probe app /ready', 'release claim-1']);
        // Progress is visible while it runs: the store saw the setting_up states first.
        expect(store.saved[0].state).toBe('setting_up');
        expect((await store.get('env-1'))?.state).toBe('active');
    });

    it('records a no_ref blocker when the command has no commit: the worker never picks one', async () => {
        const { env, calls } = fakeEnv();
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd({ ref: undefined, recipe: undefined }));
        expect(rec.state).toBe('blocked');
        expect(rec.blockers.map((b) => b.kind)).toEqual(['no_ref']);
        expect(calls).toEqual([]);
    });

    it('records the typed blocker the product sent and boots nothing', async () => {
        const { env, calls } = fakeEnv();
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({ ref: undefined, recipe: undefined, repoToken: undefined, blocker: { kind: 'unsupported_platform', message: 'GitLab is not supported yet' } }),
        );
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'unsupported_platform', signature: 'setup:unsupported_platform', message: 'GitLab is not supported yet' });
        expect(rec.steps.find((s) => s.name === 'resolve_ref')?.state).toBe('failed');
        expect(calls).toEqual([]);
    });

    it('boots with the recipe read at the default-branch commit and records it with its expose list', async () => {
        const { env, calls } = fakeEnv({ manifest: [] });
        const seen: any[] = [];
        const rec = await testSetupService(
            { envForSetup: (i) => (seen.push(i), env) },
            new InMemoryEnvironmentSetupStore(),
        ).run(cmd());
        expect(seen[0]).toMatchObject({ fullName: 'shop', organizationId: 'org-1', setupKey: KEY, sealedRepoToken: SEALED, expose: RECIPE_EXPOSE });
        expect(rec.expose).toEqual(RECIPE_EXPOSE);
        expect(rec.recipe).toMatchObject({ path: '.kodus/workspace.yaml', sha: SHA, state: 'found', public: 'web', health: '/ready', content: RECIPE });
        expect(rec.recipe?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
        // The ready check goes to the recipe's public service and health path.
        expect(calls).toContain('probe web /ready');
    });

    it('says which recipe keys the cell boots without, on the recipe step, and still boots', async () => {
        const { env } = fakeEnv({ manifest: [] });
        const content = `${RECIPE}fakes: { stripe: true }\nflags: { NEW_CHECKOUT: true }\nsize: large\n`;
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({
                machineSize: { cpus: 8, memoryMb: 16384 },
                recipe: { path: '.kodus/workspace.yaml', sha: SHA, content } }),
        );
        expect(rec.state).toBe('active');
        expect(rec.steps.find((s) => s.name === 'recipe')?.detail).toMatch(/, 2 exposed; not applied by the cell yet: flags$/);
        // A recipe that sets none says nothing more.
        const plain = await testSetupService({ envForSetup: () => fakeEnv({ manifest: [] }).env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(plain.steps.find((s) => s.name === 'recipe')?.detail).toMatch(/, 2 exposed$/);
    });

    it('a default branch without a recipe still boots, records the absence and has nothing to check', async () => {
        const { env, calls } = fakeEnv({ manifest: [] });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null } }),
        );
        expect(rec.state).toBe('active');
        expect(rec.recipe).toEqual({ path: '.kodus/workspace.yaml', sha: SHA, state: 'absent' });
        expect(rec.steps.find((s) => s.name === 'ready')?.state).toBe('skipped');
        expect(calls).toEqual(['acquire setup setup cccc', 'release claim-1']);
    });

    it('an invalid recipe is a recipe_invalid blocker before any machine boots', async () => {
        const { env, calls } = fakeEnv();
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: 'version: 1\nimage: node\n' } }),
        );
        expect(rec.blockers[0]).toMatchObject({ kind: 'recipe_invalid', message: 'recipe: unknown field "image"' });
        expect(calls).toEqual([]);
    });

    it('a recipe read at another commit than the one booting is not used', async () => {
        const { env } = fakeEnv();
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({ recipe: { path: '.kodus/workspace.yaml', sha: 'e'.repeat(40), content: RECIPE } }),
        );
        expect(rec.recipe).toBeUndefined();
        expect(rec.steps.find((s) => s.name === 'recipe')?.state).toBe('skipped');
    });

    it('RUNTIME_SETUP_DEV_SHA is an explicit override: it wins over the product commit and its blockers, and says so', async () => {
        const { env, calls } = fakeEnv();
        const dev = 'f'.repeat(40);
        const svc = testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { devSha: dev, devExpose: EXPOSE });
        const rec = await svc.run(cmd({ ref: undefined, recipe: undefined, blocker: { kind: 'token_unavailable', message: 'no GitHub App' } }));
        expect(rec).toMatchObject({ state: 'active', sha: dev, refSource: 'dev_override' });
        expect(rec.steps.find((s) => s.name === 'resolve_ref')?.detail).toContain('dev override');
        expect(calls[0]).toBe('acquire setup setup ffff no-seed');
    });

    it('every I/O is a checkpointed step: a replay after a crash does not boot a second machine', async () => {
        const { env, calls } = fakeEnv();
        const store = new InMemoryEnvironmentSetupStore();
        const names: string[] = [];
        // A DBOS-like runner: results recorded by position, replayed on recovery.
        const log: unknown[] = [];
        const runner = (crashAfter?: string): SetupStepRunner => {
            let i = 0;
            return async (name, fn) => {
                const at = i++;
                names.push(name);
                if (at < log.length) return log[at] as any;
                const out = await fn();
                log.push(out);
                if (name === crashAfter) throw new Error('worker killed');
                return out;
            };
        };
        const svc = testSetupService({ envForSetup: () => env }, store);
        await expect(svc.run(cmd(), runner('boot'))).resolves.toMatchObject({ state: 'blocked' });
        // The in-process catch recorded the crash; the real recovery replays the log instead.
        log.length = names.indexOf('boot') + 1;
        names.length = 0;
        const rec = await svc.run(cmd(), runner());
        expect(rec.state).toBe('active');
        expect(calls.filter((c) => c.startsWith('acquire'))).toHaveLength(1);
        expect(names).toEqual(expect.arrayContaining(['load', 'boot', 'health', 'release']));
        expect(names.filter((n) => n.startsWith('record:')).length).toBeGreaterThan(5);
    });

    it('records the cell blocker and does not release a claim it never got', async () => {
        const { env, calls } = fakeEnv({ blocked: true });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'no_recipe', signature: 'localdocker:no_environment' });
        expect(rec.steps.find((s) => s.name === 'boot')?.state).toBe('failed');
        expect(calls).toEqual(['acquire setup setup cccc']);
        // The cell the failed boot built on is kept: the next setup goes back to its state.
        expect(rec.buildCellId).toBe('cell-built');
        expect(rec.cellId).toBeUndefined();
    });

    it('a boot no cell took has its own signature, and the message names no organization', async () => {
        const { env } = fakeEnv();
        env.acquire = async () => {
            throw new CellUnavailableError('no cell is connected for this organization');
        };
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'cell_unavailable', signature: 'cell_unavailable', message: 'no cell is connected for this organization' });
    });

    it('a boot no cell had room for is blocked on its capacity card, and nothing is released', async () => {
        for (const [refusal, signature] of [
            [{ refused: 'no_capacity' }, 'no_capacity'],
            [{ refused: 'org_capacity', cap: 8, open: 8 }, 'org_capacity'],
        ] as const) {
            const { env, calls } = fakeEnv();
            env.acquire = async () => capacityBlocked(refusal);
            const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
            expect(rec.state).toBe('blocked');
            expect(rec.blockers[0]).toMatchObject({ kind: 'resources', signature });
            expect(classifyBlocker(rec.blockers[0]).fixes.map((f) => f.action)).toEqual(['retry_setup', 'use_own_cell']);
            expect(calls.filter((c) => c.startsWith('release'))).toEqual([]);
        }
    });

    it('blocks on a 5xx ready check and still releases the claim', async () => {
        const { env, calls } = fakeEnv({ status: 503 });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0].kind).toBe('not_ready');
        expect(rec.blockers[0].signature).toBe('setup:not_ready:app:3000/ready');
        expect(calls[calls.length - 1]).toBe('release claim-1');
    });

    it('asks the ready check again while the app starts, until it answers', async () => {
        const { env, calls } = fakeEnv();
        let tries = 0;
        env.probe = async () => {
            tries++;
            calls.push('probe');
            // Nothing listens yet (the observer cannot reach it), then 503 while it starts, then 200.
            if (tries === 1) return { code: 'vm_unhealthy', stepId: 's', vmHealth: 'unreachable' } as any;
            return { http: { status: tries === 2 ? 503 : 200 }, vmHealth: 'ok' } as any;
        };
        const steps: string[] = [];
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd(), async (name, fn) => {
            steps.push(name);
            return fn();
        });
        expect(rec.state).toBe('active');
        expect(tries).toBe(3);
        // Each try is its own journaled step: a replay reads the same tries.
        expect(steps.filter((n) => n.startsWith('health'))).toEqual(['health', 'health:1', 'health:2']);
    });

    it("gives up on the ready check at the recipe's health_timeout", async () => {
        const { env } = fakeEnv();
        let tries = 0;
        env.probe = async () => {
            tries++;
            return { code: 'vm_unhealthy', stepId: 's', vmHealth: 'unreachable' } as any;
        };
        const recipe = RECIPE.replace('health: /ready }', 'health: /ready, health_timeout: 15s }');
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: recipe } }),
        );
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'not_ready', message: expect.stringContaining('vm_unhealthy') });
        expect(tries).toBe(3); // 15 s / 5 s
    });

    it('stops the ready check at health_timeout on the clock, when each try hangs to its own timeout', async () => {
        const { env } = fakeEnv();
        let at = Date.parse('2026-10-30T12:00:00.000Z');
        let tries = 0;
        env.probe = async () => {
            tries++;
            at += 30_000; // the probe waits its 30 s timeout and gets nothing
            return { code: 'vm_unhealthy', stepId: 's', vmHealth: 'unreachable' } as any;
        };
        const recipe = RECIPE.replace('health: /ready }', 'health: /ready, health_timeout: 60s }');
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), {
            now: () => new Date(at),
            sleep: async (ms) => void (at += ms),
        }).run(cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: recipe } }));
        expect(rec.blockers[0]).toMatchObject({ kind: 'not_ready', message: expect.stringContaining('after 60 s') });
        // 0-30 s, then 35-65 s: past the 60 s wait. Counting tries alone would have made it 12 (6 minutes).
        expect(tries).toBe(2);
    });

    it('never waits past the most a ready check gets, whatever health_timeout the recipe sets', async () => {
        const { env } = fakeEnv();
        let tries = 0;
        env.probe = async () => {
            tries++;
            return { code: 'vm_unhealthy', stepId: 's', vmHealth: 'unreachable' } as any;
        };
        const slept: number[] = [];
        const recipe = RECIPE.replace('health: /ready }', 'health: /ready, health_timeout: 100h }');
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { sleep: async (ms) => void slept.push(ms) }).run(
            cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: recipe } }),
        );
        expect(rec.blockers[0]).toMatchObject({ kind: 'not_ready', message: expect.stringContaining('after 900 s') });
        expect(tries).toBe(180); // 900 s / 5 s, not 72 000
        expect(slept.every((ms) => ms === 5_000)).toBe(true);
    });

    it("never waits past the setup claim's hardExpiresAt, less the margin the bake still needs", async () => {
        const { env } = fakeEnv();
        let at = Date.parse('2026-10-30T12:40:00.000Z');
        // A long boot: the claim has 5 minutes left of its ceiling when the check starts.
        const acquire = env.acquire;
        env.acquire = async (req) => ({ ...((await acquire(req)) as any), hardExpiresAt: '2026-10-30T12:45:00.000Z' });
        let tries = 0;
        env.probe = async () => {
            tries++;
            return { code: 'vm_unhealthy', stepId: 's', vmHealth: 'unreachable' } as any;
        };
        const recipe = RECIPE.replace('health: /ready }', 'health: /ready, health_timeout: 900s }');
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), {
            now: () => new Date(at),
            sleep: async (ms) => void (at += ms),
        }).run(cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: recipe } }));
        // 300 s left less the 120 s margin: 180 s of the 900 s, and the release still runs before the ceiling.
        expect(rec.blockers[0]).toMatchObject({ kind: 'not_ready', message: expect.stringContaining("after 180 s, when the setup's machine time ran out") });
        expect(tries).toBe(36);
        expect(at).toBeLessThanOrEqual(Date.parse('2026-10-30T12:43:00.000Z'));
    });

    it('answers a redelivered command with the finished record', async () => {
        const { env, calls } = fakeEnv();
        const svc = testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore());
        await svc.run(cmd());
        const again = await svc.run(cmd());
        expect(again.state).toBe('active');
        expect(calls.filter((c) => c.startsWith('acquire'))).toHaveLength(1);
    });
});

describe('cell affinity across setups', () => {
    // What the hub client does on acquire: ask the preferred cell from the record as it is then.
    const preferring = (env: EnvironmentRuntime, store: InMemoryEnvironmentSetupStore, asked: Array<string | undefined>) => {
        const prefer = poolCellOf(store);
        const acquire = env.acquire.bind(env);
        env.acquire = async (req) => {
            asked.push(await prefer(req.organizationId, req.environmentId));
            return acquire(req);
        };
        return env;
    };

    it('the next setup boots preferring the cell the last one built and baked on', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const asked: Array<string | undefined> = [];
        const env = preferring(fakeEnv().env, store, asked);
        const svc = testSetupService({ envForSetup: () => env }, store);
        const first = await svc.run(cmd({ key: 'first' }));
        expect(first.cellId).toBe('cell-1');
        await svc.run(cmd({ key: 'second' }));
        expect(asked).toEqual([undefined, 'cell-1']);
    });

    it('carries the cell of a failed build, and never to another org nor as the active cell', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const asked: Array<string | undefined> = [];
        const blocked = fakeEnv({ blocked: true }).env;
        await testSetupService({ envForSetup: () => blocked }, store).run(cmd({ key: 'first' }));
        // An invalid recipe never boots: the record still names the cell holding the build state.
        const invalid = await testSetupService({ envForSetup: () => fakeEnv().env }, store).run(
            cmd({ key: 'second', recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: 'version: [' } }),
        );
        expect(invalid.state).toBe('blocked');
        expect(invalid.buildCellId).toBe('cell-built');
        expect(invalid.cellId).toBeUndefined();
        const env = preferring(fakeEnv().env, store, asked);
        await testSetupService({ envForSetup: () => env }, store).run(cmd({ key: 'third' }));
        expect(asked).toEqual(['cell-built']);

        expect(carriedBuildCell({ ...invalid, organizationId: 'org-2' }, 'org-1')).toEqual({});
        expect(carriedBuildCell({ ...invalid, buildCellId: undefined, cellId: 'cell-old' }, 'org-1')).toEqual({ buildCellId: 'cell-old' });
        expect(carriedBuildCell(null, 'org-1')).toEqual({});
    });
});

describe('lessons (ADR-018)', () => {
    const blockedBefore = (store: InMemoryEnvironmentSetupStore) =>
        store.save({
            environmentId: 'env-1',
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            key: 'env-1:2026-10-29T12:00:00.000Z',
            state: 'blocked',
            steps: [],
            blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1', at: '2026-10-29T12:01:00.000Z' }],
            failureBundle: BUNDLE,
            requestedAt: '2026-10-29T12:00:00.000Z',
            updatedAt: '2026-10-29T12:01:00.000Z',
        });

    it('a clean default-branch boot after a blocked setup records the fix that changed, with its origin', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        await blockedBefore(store);
        const lessons = new InMemoryLessonStore();
        const rec = await testSetupService({ envForSetup: () => fakeEnv().env }, store, {
            lessons: { store: lessons, approvedHosts: async () => ['registry.npmjs.org'] },
        }).run(cmd());
        expect(rec.state).toBe('active');
        const [lesson] = [...lessons.byId.values()];
        expect(lesson).toMatchObject({
            organizationId: 'org-1',
            repositoryId: 'repo-1',
            scope: 'repo',
            signature: 'external_service:egress:registry.npmjs.org',
            fix: { id: 'approve_host:registry.npmjs.org', action: 'approve_host' },
            origin: { sha: SHA, branch: 'main', blockedSetupKey: 'env-1:2026-10-29T12:00:00.000Z', fixedSetupKey: KEY },
        });
    });

    it('learns nothing from a dev override, nor when the host was never approved', async () => {
        for (const [over, hosts] of [
            [{ devSha: 'd'.repeat(40) }, ['registry.npmjs.org']],
            [{}, []],
        ] as const) {
            const store = new InMemoryEnvironmentSetupStore();
            await blockedBefore(store);
            const lessons = new InMemoryLessonStore();
            await testSetupService({ envForSetup: () => fakeEnv().env }, store, {
                ...over,
                lessons: { store: lessons, approvedHosts: async () => [...hosts] },
            }).run(cmd());
            expect(lessons.byId.size).toBe(0);
        }
    });

    it('a failing lesson store never fails the setup', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        await blockedBefore(store);
        const rec = await testSetupService({ envForSetup: () => fakeEnv().env }, store, {
            lessons: { store: { record: async () => Promise.reject(new Error('mongo down')), update: async () => false }, approvedHosts: async () => ['registry.npmjs.org'] },
        }).run(cmd());
        expect(rec.state).toBe('active');
    });
});

describe('S-52 bake', () => {
    it('asks image.bake from the setup claim only for the default-branch head the product read', async () => {
        const { env, calls } = fakeEnv({ bake: 'accepted' });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(rec.state).toBe('active');
        expect(calls).toEqual(['acquire setup setup cccc', 'probe app /ready', 'bake claim-1 cccc', 'release claim-1']);
        expect(rec.steps.find((s) => s.name === 'bake')).toMatchObject({ state: 'done', detail: expect.stringContaining('main') });
        // Runs boot on the bake (and its pool machines) from now on.
        expect(rec.imageId).toBe('latest');
    });

    it('never bakes the dev override nor a ref without its branch', async () => {
        for (const [c, opts] of [
            [cmd(), { devSha: 'f'.repeat(40) }],
            [cmd({ ref: { sha: SHA } }), {}],
        ] as const) {
            const { env, calls } = fakeEnv({ bake: 'accepted' });
            const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), opts).run(c);
            expect(calls.some((x) => x.startsWith('bake'))).toBe(false);
            expect(rec.steps.find((s) => s.name === 'bake')).toMatchObject({ state: 'skipped', detail: expect.stringContaining('S-52') });
            expect(rec.state).toBe('active');
        }
    });

    it('records a refused bake and stays active without an image', async () => {
        const { env } = fakeEnv({ bake: 'pr_claim' });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(rec.state).toBe('active');
        expect(rec.steps.find((s) => s.name === 'bake')).toMatchObject({ state: 'failed', detail: 'image.bake refused: pr_claim' });
        expect(rec.imageId).toBe('setup');
    });
});

describe('warm pool after the bake', () => {
    it('asks the cell that baked for the pool, before the release', async () => {
        const { env, calls } = fakeEnv({ bake: 'accepted', pool: 'accepted' });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd({ poolSize: 2 }));
        expect(calls).toEqual(['acquire setup setup cccc', 'probe app /ready', 'bake claim-1 cccc', 'pool cell-1 2 via claim-1', 'release claim-1']);
        expect(rec.steps.find((s) => s.name === 'pool')).toMatchObject({ state: 'done', detail: '2 machines kept ready from the bake' });
        expect(rec.state).toBe('active');
    });

    it('asks for no pool without a bake or a size, and a refused pool leaves the environment active', async () => {
        const noBake = fakeEnv({ bake: 'pr_claim', pool: 'accepted' });
        let rec = await testSetupService({ envForSetup: () => noBake.env }, new InMemoryEnvironmentSetupStore()).run(cmd({ poolSize: 2 }));
        expect(noBake.calls.some((c) => c.startsWith('pool'))).toBe(false);
        expect(rec.steps.find((s) => s.name === 'pool')).toMatchObject({ state: 'skipped', detail: 'no bake to fill the pool from' });

        const noSize = fakeEnv({ bake: 'accepted', pool: 'accepted' });
        rec = await testSetupService({ envForSetup: () => noSize.env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(noSize.calls.some((c) => c.startsWith('pool'))).toBe(false);
        expect(rec.steps.find((s) => s.name === 'pool')).toMatchObject({ state: 'skipped' });

        const refused = fakeEnv({ bake: 'accepted', pool: 'pool_unsupported' });
        rec = await testSetupService({ envForSetup: () => refused.env }, new InMemoryEnvironmentSetupStore()).run(cmd({ poolSize: 1 }));
        expect(rec.steps.find((s) => s.name === 'pool')).toMatchObject({ state: 'failed', detail: 'pool.target refused: pool_unsupported' });
        expect(rec.state).toBe('active');
    });

    it("asks for the pool at the environment's machine size; a cell too old for a sized pool skips it with the reason", async () => {
        const { env } = fakeEnv({ bake: 'accepted' });
        const asked: unknown[] = [];
        env.poolTarget = async (req) => {
            asked.push(req.machineSize);
            return { status: 'refused', code: 'pool_size_unsupported', message: 'this cell makes pool machines only at its default size' };
        };
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd({ poolSize: 2, machineSize: { memoryMb: 16_384, cpus: 8 } }));
        expect(asked).toEqual([{ memoryMb: 16_384, cpus: 8 }]);
        // Nothing failed: the environment is active and its Runs boot at the size, without warm machines.
        expect(rec.steps.find((s) => s.name === 'pool')).toMatchObject({ state: 'skipped', detail: 'this cell makes pool machines only at its default size' });
        expect(rec.state).toBe('active');
    });
});

describe('failure bundle and diagnostic hold', () => {
    it('keeps the redacted bundle and the held claim on the record, and does not release it', async () => {
        const { env, calls } = fakeEnv({ held: true });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd({ diagnosticHold: true }));
        expect(rec.state).toBe('blocked');
        expect(calls).toEqual(['acquire setup setup cccc hold']);
        expect(rec.failureBundle).toEqual(BUNDLE);
        expect(rec.diagnosticHold).toEqual({ claimId: 'claim-held', cellId: 'cell-1', until: '2026-10-30T12:45:00.000Z' });
        expect(rec.blockers[0]).toMatchObject({ kind: 'platform', signature: 'repo_upload' });
    });

    it('asks no hold unless the environment turned it on', async () => {
        const { env, calls } = fakeEnv({ blocked: true });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(calls).toEqual(['acquire setup setup cccc']);
        expect(rec.diagnosticHold).toBeUndefined();
    });
});

describe('machine size', () => {
    it("boots at the environment's machine size and records it for the Runs on this setup", async () => {
        const sizes: unknown[] = [];
        const { env } = fakeEnv();
        const acquire = env.acquire;
        env.acquire = async (req) => (sizes.push(req.size), acquire(req));
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd({ machineSize: { memoryMb: 16_384, cpus: 8 } }));
        expect(rec.state).toBe('active');
        expect(sizes).toEqual([{ memoryMb: 16_384, cpus: 8 }]);
        expect(rec.machineSize).toEqual({ memoryMb: 16_384, cpus: 8 });
    });

    it("asks no size when the environment chose none: the cell's default", async () => {
        const asked: any[] = [];
        const { env } = fakeEnv();
        const acquire = env.acquire;
        env.acquire = async (req) => (asked.push(req), acquire(req));
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(asked[0]).not.toHaveProperty('size');
        expect(rec).not.toHaveProperty('machineSize');
    });

    it('a size the cell does not grant blocks the setup with its card', async () => {
        const { env } = fakeEnv();
        env.acquire = async () => ({
            status: 'blocked',
            blockers: [{ kind: 'resources', signature: 'size_unavailable', message: 'asked 16384 MB / 8 CPUs, this cell grants at most 8192 MB / 4 CPUs' }],
        });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd({ machineSize: { memoryMb: 16_384, cpus: 8 } }));
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'resources', signature: 'size_unavailable' });
    });
});

describe('loadSetupOptions', () => {
    it('reads the dev overrides and refuses malformed ones', () => {
        expect(loadSetupOptions({})).toEqual({ devSha: undefined, devExpose: undefined, healthPath: undefined });
        expect(loadSetupOptions({ RUNTIME_SETUP_DEV_SHA: SHA, RUNTIME_SETUP_EXPOSE: JSON.stringify(EXPOSE) })).toMatchObject({ devSha: SHA, devExpose: EXPOSE });
        expect(() => loadSetupOptions({ RUNTIME_SETUP_DEV_SHA: 'main' })).toThrow('40-hex');
        expect(() => loadSetupOptions({ RUNTIME_SETUP_EXPOSE: '[{"service":"app"}]' })).toThrow('RUNTIME_SETUP_EXPOSE');
    });

    it('is deterministic for the workflow engine: the health probe id and the trace id derive from the command key', async () => {
        const seen: Array<{ stepId: string; correlationId: string }> = [];
        const run = async () => {
            const { env } = fakeEnv();
            let correlationId = '';
            const probe = env.probe;
            env.probe = async (c, p, stepId) => {
                seen.push({ stepId, correlationId });
                return probe(c, p, stepId);
            };
            await testSetupService(
                { envForSetup: (i) => ((correlationId = i.correlationId), env) },
                new InMemoryEnvironmentSetupStore(),
            ).run(cmd());
        };
        await run();
        await run();
        expect(seen).toHaveLength(2);
        expect(seen[0]).toEqual(seen[1]);
        expect(seen[0].stepId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    });

    it('reads every clock inside a step, so a replay records the same times', async () => {
        const names: string[] = [];
        const step: SetupStepRunner = (name, fn) => (names.push(name), fn());
        const { env } = fakeEnv();
        await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { now: () => new Date('2026-10-30T12:00:00Z') }).run(cmd(), step);
        expect(names.filter((n) => n.startsWith('clock:')).length).toBeGreaterThan(0);
    });
});


describe('a recipe Kodus inferred (no recipe on the default branch)', () => {
    const INFERRED = 'version: 1\nservices:\n  compose:\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
    const inferredCmd = (key: string) =>
        cmd({ key, requestedAt: key.split(':').slice(1).join(':'), recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: INFERRED, origin: 'inferred' } });

    it('boots with it, marks it inferred and counts the clean boots of the same digest in a row (ENV-06)', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const service = () => testSetupService({ envForSetup: () => fakeEnv().env }, store);
        const first = await service().run(inferredCmd('env-1:2026-10-30T12:00:00.000Z'));
        expect(first.state).toBe('active');
        expect(first.recipe).toMatchObject({ state: 'found', origin: 'inferred', content: INFERRED, cleanBoots: 1 });
        expect(first.steps.find((s) => s.name === 'recipe')?.detail).toMatch(/^inferred by Kodus sha256:/);
        const second = await service().run(inferredCmd('env-1:2026-10-30T13:00:00.000Z'));
        expect(second.recipe?.cleanBoots).toBe(2);
        // The same command delivered again is not a new boot.
        expect((await service().run(inferredCmd('env-1:2026-10-30T13:00:00.000Z'))).recipe?.cleanBoots).toBe(2);
        // Another inferred text starts over.
        const changed = await service().run({ ...inferredCmd('env-1:2026-10-30T14:00:00.000Z'), recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: `${INFERRED}# x\n`, origin: 'inferred' } });
        expect(changed.recipe?.cleanBoots).toBe(1);
    });

    it('does not count a boot that did not answer, nor one after a blocked setup', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const failed = await testSetupService({ envForSetup: () => fakeEnv({ status: 502 }).env }, store).run(inferredCmd('env-1:2026-10-30T12:00:00.000Z'));
        expect(failed.state).toBe('blocked');
        expect(failed.recipe?.cleanBoots).toBeUndefined();
        const next = await testSetupService({ envForSetup: () => fakeEnv().env }, store).run(inferredCmd('env-1:2026-10-30T13:00:00.000Z'));
        expect(next.recipe?.cleanBoots).toBe(1);
    });

    it('a repository recipe carries no origin and no clean boot count', async () => {
        const rec = await testSetupService({ envForSetup: () => fakeEnv({ manifest: RECIPE_EXPOSE as any }).env }, new InMemoryEnvironmentSetupStore()).run(cmd());
        expect(rec.recipe?.origin).toBeUndefined();
        expect(rec.recipe?.cleanBoots).toBeUndefined();
    });

    it('blocks with no_recipe before booting when there is nothing to infer from', async () => {
        const { env, calls } = fakeEnv();
        const message = 'There is no compose file and no Dockerfile at the repository root, so Kodus has nothing to infer a recipe from.';
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(
            cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null, inference: { reason: 'no_build_files', message } } }),
        );
        expect(rec.state).toBe('blocked');
        expect(rec.blockers).toEqual([expect.objectContaining({ kind: 'no_recipe', signature: 'setup:no_recipe', message })]);
        expect(rec.recipe).toEqual({ path: '.kodus/workspace.yaml', sha: SHA, state: 'absent', inference: { reason: 'no_build_files', message } });
        expect(calls).toEqual([]);
    });

    it('records why it could not infer one and still boots what the cell finds', async () => {
        const { env, calls } = fakeEnv();
        const inference = { reason: 'no_http_port' as const, message: 'No service in compose.yaml declares an HTTP port Kodus can call (ports or expose), so no recipe was inferred.' };
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore()).run(cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null, inference } }));
        expect(rec.state).toBe('active');
        expect(rec.recipe).toMatchObject({ state: 'absent', inference });
        expect(calls[0]).toBe('acquire setup setup cccc');
    });
});

describe('a recipe Kody writes (no recipe on the default branch, none inferred)', () => {
    const AUTHORED = 'version: 1\nservices:\n  compose:\n    files: [docker-compose.yml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
    const LLM_TOKEN = sealSecret('kst1.setup-token', devSealKey(), KEY);
    const inference = { reason: 'no_http_port' as const, message: 'No service in compose.yaml declares an HTTP port Kodus can call (ports or expose), so no recipe was inferred.' };
    const noRecipeCmd = (over: Partial<RuntimeEnvironmentSetupRequested> = {}) =>
        cmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null, inference }, llmToken: LLM_TOKEN, ...over });
    const author = (answer: RecipeAuthorOutcome) => {
        const calls: RecipeAuthorRequestInput[] = [];
        const client: RecipeAuthorClient = {
            author: async (req) => {
                calls.push(req);
                return answer;
            },
        };
        return { client, calls };
    };
    const submitted: RecipeAuthorOutcome = { status: 'submitted', recipe: AUTHORED, notes: 'The root compose file; the app listens on 3000.', usage: { inputTokens: 900, outputTokens: 80 } };
    /** The env, with the recipe each boot was asked to use. */
    const recordingEnv = (opts: Parameters<typeof fakeEnv>[0] = {}) => {
        const f = fakeEnv(opts);
        const recipes: unknown[] = [];
        const acquire = f.env.acquire.bind(f.env);
        f.env.acquire = async (req) => {
            recipes.push(req.recipe);
            return acquire(req);
        };
        return { ...f, recipes };
    };

    it("boots with Kody's recipe, marks it authored with Kody's notes, and asks the product with the setup token and commit", async () => {
        const { env, recipes } = recordingEnv();
        const a = author(submitted);
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { author: a.client }).run(noRecipeCmd());
        expect(a.calls).toEqual([{ organizationId: 'org-1', llmToken: LLM_TOKEN, setupKey: KEY, sha: SHA }]);
        expect(rec.state).toBe('active');
        expect(rec.recipe).toMatchObject({ path: '.kodus/workspace.yaml', sha: SHA, state: 'found', origin: 'authored', content: AUTHORED, notes: submitted.status === 'submitted' ? submitted.notes : '', cleanBoots: 1 });
        expect(rec.recipe?.digest).toMatch(/^sha256:/);
        expect(rec.recipe?.inference).toBeUndefined();
        expect(rec.steps.find((s) => s.name === 'recipe')).toMatchObject({ state: 'done', detail: expect.stringMatching(/^written by Kody sha256:.*, 1 exposed$/) });
        expect(recipes).toEqual([{ path: '.kodus/workspace.yaml', content: AUTHORED, digest: rec.recipe?.digest }]);
    });

    it('keeps the recipe that booted in the last setup: no new run, and its clean boots add up to the PR (ENV-06)', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const a = author(submitted);
        const service = () => testSetupService({ envForSetup: () => fakeEnv().env }, store, { author: a.client });
        const second = 'env-1:2026-10-30T13:00:00.000Z';
        await service().run(noRecipeCmd());
        const again = await service().run(noRecipeCmd({ key: second, requestedAt: '2026-10-30T13:00:00.000Z', llmToken: sealSecret('kst1.setup-token', devSealKey(), second) }));
        expect(a.calls).toHaveLength(1);
        expect(again.recipe).toMatchObject({ origin: 'authored', content: AUTHORED, cleanBoots: 2 });
        expect(again.steps.find((s) => s.name === 'recipe')?.detail).toMatch(/^written by Kody \(kept from the last setup\)/);
    });

    const KODY_FILES = [
        { path: '.kodus/Dockerfile', content: 'FROM node:22-bookworm-slim\nCOPY . .\nCMD ["npm", "start"]\n' },
        { path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n' },
    ];
    const withFiles: RecipeAuthorOutcome = { ...(submitted as Extract<RecipeAuthorOutcome, { status: 'submitted' }>), recipe: AUTHORED.replace('docker-compose.yml', '.kodus/compose.yaml'), files: KODY_FILES };

    it("records Kody's files with the recipe, under one digest of both, and boots with them", async () => {
        const { env, recipes } = recordingEnv();
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { author: author(withFiles).client }).run(noRecipeCmd());
        const text = withFiles.status === 'submitted' ? withFiles.recipe : '';
        expect(rec.state).toBe('active');
        expect(rec.recipe).toMatchObject({ origin: 'authored', content: text, files: KODY_FILES, digest: recipeDigest(text, KODY_FILES) });
        // The digest covers the files: the recipe alone, or other files, is another digest.
        expect(rec.recipe?.digest).not.toBe(recipeDigest(text));
        expect(recipeDigest(text, [KODY_FILES[0], { ...KODY_FILES[1], content: KODY_FILES[1].content + '#\n' }])).not.toBe(rec.recipe?.digest);
        expect(recipeDigest(text, [...KODY_FILES].reverse())).toBe(rec.recipe?.digest);
        expect(rec.steps.find((s) => s.name === 'recipe')?.detail).toMatch(/^written by Kody with 2 files under \.kodus\/ sha256:/);
        expect(recipes).toEqual([{ path: '.kodus/workspace.yaml', content: text, digest: rec.recipe?.digest, files: KODY_FILES }]);
    });

    it('keeps the files with the recipe it reuses: the next setup boots both, same digest, clean boots add up', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const a = author(withFiles);
        const first = await testSetupService({ envForSetup: () => fakeEnv().env }, store, { author: a.client }).run(noRecipeCmd());
        const second = 'env-1:2026-10-30T13:00:00.000Z';
        const { env, recipes } = recordingEnv();
        const again = await testSetupService({ envForSetup: () => env }, store, { author: a.client }).run(
            noRecipeCmd({ key: second, requestedAt: '2026-10-30T13:00:00.000Z', llmToken: sealSecret('kst1.setup-token', devSealKey(), second) }),
        );
        expect(a.calls).toHaveLength(1);
        expect(again.recipe).toMatchObject({ origin: 'authored', files: KODY_FILES, digest: first.recipe?.digest, cleanBoots: 2 });
        expect(recipes).toEqual([expect.objectContaining({ files: KODY_FILES, digest: first.recipe?.digest })]);
    });

    it("blocks with no_recipe and Kody's reason, and boots nothing", async () => {
        const { env, calls } = fakeEnv();
        const a = author({ status: 'no_recipe', reason: 'Kody found nothing to boot: the repository is a library with no server', usage: { inputTokens: 1, outputTokens: 1 } });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { author: a.client }).run(noRecipeCmd());
        expect(rec.state).toBe('blocked');
        expect(rec.blockers).toEqual([
            expect.objectContaining({ kind: 'no_recipe', signature: 'setup:no_recipe', message: 'Kody could not write a recipe: Kody found nothing to boot: the repository is a library with no server' }),
        ]);
        expect(rec.recipe).toMatchObject({ state: 'absent', inference });
        expect(calls).toEqual([]);
    });

    it('without a setup token, without the client, or with a dev override, Kody is not asked and the setup goes on as before', async () => {
        for (const [over, opts] of [
            [{ llmToken: undefined }, {}],
            [{}, { noAuthor: true }],
            [{}, { devSha: SHA }],
        ] as const) {
            const { env, calls } = fakeEnv();
            const a = author(submitted);
            const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), {
                ...('noAuthor' in opts ? {} : { author: a.client }),
                ...('devSha' in opts ? { devSha: opts.devSha } : {}),
            }).run(noRecipeCmd(over));
            expect(a.calls).toEqual([]);
            expect(rec.state).toBe('active');
            expect(rec.recipe).toMatchObject({ state: 'absent', inference });
            expect(calls[0]).toMatch(/^acquire setup setup cccc/);
        }
        // A repository recipe or an inferred one never goes to Kody.
        const a = author(submitted);
        await testSetupService({ envForSetup: () => fakeEnv({ manifest: RECIPE_EXPOSE as any }).env }, new InMemoryEnvironmentSetupStore(), { author: a.client }).run(cmd({ llmToken: LLM_TOKEN }));
        expect(a.calls).toEqual([]);
    });

    it('no answer from the product leaves the setup as without Kody, and says why on the step', async () => {
        const a = author({ status: 'unavailable', code: 'llm_budget_exceeded', message: "the setup's LLM budget is spent" });
        const rec = await testSetupService({ envForSetup: () => fakeEnv().env }, new InMemoryEnvironmentSetupStore(), { author: a.client }).run(noRecipeCmd());
        expect(rec.state).toBe('active');
        expect(rec.steps.find((s) => s.name === 'recipe')).toMatchObject({ state: 'skipped', detail: expect.stringContaining("Kody could not write one (the setup's LLM budget is spent)") });
        // With nothing to build from either, the inference's own blocker stands.
        const message = 'There is no compose file and no Dockerfile at the repository root, so Kodus has nothing to infer a recipe from.';
        const blocked = await testSetupService({ envForSetup: () => fakeEnv().env }, new InMemoryEnvironmentSetupStore(), { author: a.client }).run(
            noRecipeCmd({ recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null, inference: { reason: 'no_build_files', message } } }),
        );
        expect(blocked.blockers).toEqual([expect.objectContaining({ kind: 'no_recipe', message })]);
    });

    it('a model failure in the product is no verdict: the setup goes on as without Kody and says so, never blocks on no_recipe', async () => {
        const fetch = async () => ({ status: 502, ok: false, json: async () => ({ code: 'llm_unavailable', message: "Kody's model call failed" }) });
        const client = new HttpRecipeAuthorClient('http://api.test', { secrets: new SealedSecretOpener(devSealKey()), fetch });
        const rec = await testSetupService({ envForSetup: () => fakeEnv().env }, new InMemoryEnvironmentSetupStore(), { author: client }).run(noRecipeCmd());
        expect(rec.state).toBe('active');
        expect(rec.blockers).toEqual([]);
        expect(rec.steps.find((s) => s.name === 'recipe')).toMatchObject({ state: 'skipped', detail: expect.stringContaining('Kody could not write one (the model call failed)') });
    });

    it("Kody's recipe goes through the same parse as a repository recipe", async () => {
        const { env, calls } = fakeEnv();
        const a = author({ status: 'submitted', recipe: 'version: 1\nservices: [nope]\n', usage: { inputTokens: 1, outputTokens: 1 } });
        const rec = await testSetupService({ envForSetup: () => env }, new InMemoryEnvironmentSetupStore(), { author: a.client }).run(noRecipeCmd());
        expect(rec.state).toBe('blocked');
        expect(rec.blockers[0]).toMatchObject({ kind: 'recipe_invalid', signature: 'setup:recipe_invalid' });
        expect(calls).toEqual([]);
    });

    it('the product call is a step: a replay after a crash reads the recorded answer instead of asking again', async () => {
        const { env, calls } = fakeEnv();
        const a = author(submitted);
        const store = new InMemoryEnvironmentSetupStore();
        const names: string[] = [];
        const log: unknown[] = [];
        const runner = (crashAfter?: string): SetupStepRunner => {
            let i = 0;
            return async (name, fn) => {
                const at = i++;
                names.push(name);
                if (at < log.length) return log[at] as any;
                const out = await fn();
                log.push(out);
                if (name === crashAfter) throw new Error('worker killed');
                return out;
            };
        };
        const svc = testSetupService({ envForSetup: () => env }, store, { author: a.client });
        await expect(svc.run(noRecipeCmd(), runner('boot'))).resolves.toMatchObject({ state: 'blocked' });
        log.length = names.indexOf('boot') + 1;
        names.length = 0;
        const rec = await svc.run(noRecipeCmd(), runner());
        expect(rec).toMatchObject({ state: 'active', recipe: { origin: 'authored', content: AUTHORED } });
        expect(names).toContain('recipe:author');
        expect(a.calls).toHaveLength(1);
        expect(calls.filter((c) => c.startsWith('acquire'))).toHaveLength(1);
    });
});

describe('blockerMessage', () => {
    it('keeps the start and the end of a long message, where a build says what failed', () => {
        const cause = 'error: failed to solve: process "/bin/sh -c apk add bash" did not complete successfully: exit code: 4';
        const text = `compose_up: dockergvisor: build app: docker run --rm --runtime runsc ${'-v /x:/y '.repeat(200)}\n${cause}`;
        const out = blockerMessage(text);
        expect(Array.from(out).length).toBeLessThanOrEqual(BLOCKER_MESSAGE_MAX);
        expect(out.startsWith('compose_up: dockergvisor: build app')).toBe(true);
        expect(out.endsWith(cause)).toBe(true);
        expect(blockerMessage('short')).toBe('short');
    });

    it('never cuts a character in two', () => {
        const out = blockerMessage('é'.repeat(600) + '🚫'.repeat(600));
        expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
        expect(out.endsWith('🚫')).toBe(true);
    });
});
