import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { AcquireRequest, Blocked, EnvironmentRuntime } from '@libs/runtime/environment';
import { recipeDigest, sealSecret, type EnvironmentSetupRecord } from '@libs/runtime/run';

import { devSealKey } from '../../testing/dev-seal-key';
import { clockFrom, testSetupService } from '../../testing/setup-service';
import type { RecipeAuthorClient, RecipeAuthorOutcome, RecipeAuthorRequestInput } from '../agent/http-recipe-author';
import { capacityBlocked } from '../env/hub-environment-runtime';
import { repairFailureOf, type SetupOptions, type SetupStepRunner } from './environment-setup.service';
import { InMemoryEnvironmentSetupStore } from './testing';

// A recipe Kody wrote whose boot fails on the recipe's account goes back to
// Kody inside the same setup (RUNTIME_SETUP_AUTHOR_REPAIRS), and the recipe
// Kody rewrites boots on a new claim, instead of waiting for the next setup.

const SHA = 'c'.repeat(40);
const KEY = 'env-1:2026-11-11T12:00:00.000Z';
const LLM_TOKEN = sealSecret('kst1.setup-token', devSealKey(), KEY);
const inference = { reason: 'no_http_port' as const, message: 'No service in compose.yaml declares an HTTP port Kodus can call.' };
const cmd = (over: Partial<RuntimeEnvironmentSetupRequested> = {}): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1',
    organizationId: 'org-1',
    teamId: 'team-1',
    repositoryId: 'repo-1',
    repositoryName: 'shop',
    requestedBy: { userId: 'u-1' },
    requestedAt: '2026-11-11T12:00:00.000Z',
    key: KEY,
    ref: { sha: SHA, branch: 'main' },
    recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: null, inference },
    llmToken: LLM_TOKEN,
    ...over,
});

const recipe = (tag: string) => `version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n# ${tag}\n`;
const FILES = [{ path: '.kodus/compose.yaml', content: 'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n' }];
const FIRST = recipe('first');
const SECOND = recipe('second');
const THIRD = recipe('third');
const submitted = (text: string, notes = 'Builds the app from .kodus/Dockerfile.'): RecipeAuthorOutcome => ({
    status: 'submitted',
    recipe: text,
    files: FILES,
    notes,
    usage: { inputTokens: 900, outputTokens: 80 },
});

const BUILD_LINES = ['#12 [app 4/6] RUN go build ./...', 'main.go:3:2: undefined: Handler'];
const BUILD_FAILED: Blocked = {
    status: 'blocked',
    blockers: [
        {
            kind: 'toolchain',
            signature: 'compose_up',
            message: 'compose_up: dockergvisor: build app: process "/bin/sh -c go build ./..." did not complete successfully: exit code: 1',
            bundle: {
                services: [{ name: 'app', state: 'exited (1)', logTail: BUILD_LINES }],
                ports: [],
                disk: [],
                deniedEgress: [],
                redactions: 0,
                truncated: false,
                collectedAt: '2026-11-11T12:01:00Z',
            },
        },
    ],
    cellId: 'cell-1',
};
const blockedOn = (kind: Blocked['blockers'][number]['kind'], signature: string, message = 'the boot failed'): Blocked => ({ status: 'blocked', blockers: [{ kind, signature, message }], cellId: 'cell-1' });

type Boot = 'ok' | 'not_ready' | Blocked | (() => never);

/** An env whose boot of each recipe text ends as `boots` says (by the comment the recipe ends with); records every call. */
function fakeEnv(boots: Record<string, Boot>) {
    const calls: string[] = [];
    const acquired: AcquireRequest[] = [];
    let n = 0;
    const statusOf = new Map<string, number>();
    const env: EnvironmentRuntime = {
        acquire: async (req) => {
            acquired.push(req);
            calls.push(`acquire ${req.idempotencyKey}`);
            const tag = /# (\w+)\n$/.exec(req.recipe?.content ?? '')?.[1] ?? 'none';
            const boot = boots[tag] ?? 'ok';
            if (typeof boot === 'function') boot();
            if (typeof boot === 'object') return boot;
            const claimId = `claim-${++n}`;
            statusOf.set(claimId, boot === 'not_ready' ? 503 : 200);
            return {
                claimId,
                cellId: 'cell-1',
                cellOwner: 'kodus',
                leaseExpiresAt: '',
                hardExpiresAt: '',
                observer: { id: 'obs', state: 'ready' },
                manifest: { expose: [{ service: 'app', port: 3000, kind: 'http' }] },
            } as any;
        },
        probe: async (claimId) => ({ http: { status: statusOf.get(claimId) ?? 200 }, vmHealth: 'ok' }) as any,
        exec: async () => ({}) as any,
        reset: async () => undefined,
        release: async (id) => {
            calls.push(`release ${id}`);
        },
    };
    return { env, calls, acquired };
}

/** Kody's answers in order (the last one repeats); records what each call was sent and the setup's stored state at that moment. */
function author(store: InMemoryEnvironmentSetupStore, ...answers: RecipeAuthorOutcome[]) {
    const calls: RecipeAuthorRequestInput[] = [];
    const seen: Array<Pick<EnvironmentSetupRecord, 'state' | 'blockers'> | undefined> = [];
    const client: RecipeAuthorClient = {
        author: async (req) => {
            calls.push(req);
            const stored = await store.get('env-1');
            seen.push(stored ? { state: stored.state, blockers: stored.blockers } : undefined);
            return answers[Math.min(calls.length - 1, answers.length - 1)];
        },
    };
    return { client, calls, seen };
}

const service = (store: InMemoryEnvironmentSetupStore, env: EnvironmentRuntime, opts: SetupOptions = {}) =>
    testSetupService({ envForSetup: () => env }, store, { authorRepairs: 2, ...opts });

const stepLabels = (rec: EnvironmentSetupRecord) => rec.steps.map((s) => `${s.name}${s.repair ? ` (repair ${s.repair})` : ''} ${s.state}`);

describe('repairs of a recipe Kody wrote, inside one setup', () => {
    it('sends a failed build back to Kody with its build lines, boots the rewrite on its own claim, and ends active with it', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, calls } = fakeEnv({ first: BUILD_FAILED });
        const a = author(store, submitted(FIRST), submitted(SECOND));
        const rec = await service(store, env, { author: a.client }).run(cmd());

        expect(rec.state).toBe('active');
        expect(rec.blockers).toEqual([]);
        expect(rec.recipe).toMatchObject({ origin: 'authored', content: SECOND, files: FILES, digest: recipeDigest(SECOND, FILES), cleanBoots: 1 });
        expect(rec.failureBundle).toBeUndefined();
        // The failed recipe, its files, its notes and how its build failed, as the next setup would have sent them.
        expect(a.calls[1]).toEqual({
            organizationId: 'org-1',
            llmToken: LLM_TOKEN,
            setupKey: KEY,
            sha: SHA,
            attempt: 'repair-1',
            last: {
                recipe: FIRST,
                files: FILES,
                notes: 'Builds the app from .kodus/Dockerfile.',
                failure: { signature: 'compose_up', title: expect.any(String), evidence: expect.arrayContaining([expect.stringContaining('undefined: Handler')]) },
            },
        });
        // The product's author answers only a running setup: the record says so while Kody writes.
        expect(a.seen[1]).toEqual({ state: 'setting_up', blockers: [] });
        expect(calls).toEqual([`acquire setup:${KEY}`, `acquire setup:${KEY}:repair-1`, 'release claim-1']);
        expect(rec.repairs).toEqual([
            {
                n: 1,
                max: 2,
                blocker: { kind: 'toolchain', signature: 'compose_up', title: expect.any(String) },
                failedDigest: recipeDigest(FIRST, FILES),
                recipeDigest: recipeDigest(SECOND, FILES),
                outcome: 'booted',
                at: expect.any(String),
            },
        ]);
        expect(stepLabels(rec)).toEqual([
            'requested done',
            'resolve_ref done',
            'recipe done',
            'boot failed',
            'recipe (repair 1) done',
            'boot (repair 1) done',
            'ready (repair 1) done',
            'bake (repair 1) skipped',
            'pool (repair 1) skipped',
            'release (repair 1) done',
        ]);
        expect(rec.steps.find((s) => s.repair === 1 && s.name === 'recipe')?.detail).toMatch(/^written by Kody \(repair 1 of 2, after the boot failed on compose_up\) with 1 file under \.kodus\/ sha256:/);
        // Both boots count in Environment Health.
        expect(rec.boots?.map((b) => b.outcome)).toEqual(['failed', 'ready']);
    });

    it('releases the claim of a boot whose app did not answer before the rewrite boots', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, calls } = fakeEnv({ first: 'not_ready' });
        const a = author(store, submitted(FIRST), submitted(SECOND));
        const rec = await service(store, env, { author: a.client }).run(cmd());
        expect(rec.state).toBe('active');
        expect(calls).toEqual([`acquire setup:${KEY}`, 'release claim-1', `acquire setup:${KEY}:repair-1`, 'release claim-2']);
        expect(rec.repairs?.[0]).toMatchObject({ blocker: { kind: 'not_ready' }, outcome: 'booted' });
    });

    it('stops at the cap: the last boot is the setup verdict, every failed claim released, the failed recipe kept for the next setup', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, calls } = fakeEnv({ first: 'not_ready', second: 'not_ready', third: 'not_ready' });
        const a = author(store, submitted(FIRST), submitted(SECOND), submitted(THIRD));
        const rec = await service(store, env, { author: a.client }).run(cmd());
        expect(a.calls).toHaveLength(3);
        expect(rec.state).toBe('blocked');
        expect(rec.blockers).toEqual([expect.objectContaining({ kind: 'not_ready' })]);
        expect(rec.recipe?.content).toBe(THIRD);
        expect(rec.repairs?.map((r) => [r.n, r.max, r.outcome])).toEqual([
            [1, 2, 'blocked'],
            [2, 2, 'blocked'],
        ]);
        expect(calls.filter((c) => c.startsWith('release'))).toEqual(['release claim-1', 'release claim-2', 'release claim-3']);
        expect((await store.get('env-1'))?.state).toBe('blocked');
    });

    it('a repair cap of 0 turns it off', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, calls } = fakeEnv({ first: BUILD_FAILED });
        const a = author(store, submitted(FIRST), submitted(SECOND));
        const rec = await service(store, env, { author: a.client, authorRepairs: 0 }).run(cmd());
        expect(rec.state).toBe('blocked');
        expect(a.calls).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(rec.repairs).toBeUndefined();
    });

    it.each([
        ['the same recipe and files', submitted(FIRST, 'other notes'), 'identical', 'failed'],
        ['no recipe', { status: 'no_recipe', reason: 'the build needs a private module', usage: { inputTokens: 1, outputTokens: 1 } } as RecipeAuthorOutcome, 'no_recipe', 'failed'],
        ['no answer', { status: 'unavailable', code: 'llm_unavailable', message: 'the product answered 503' } as RecipeAuthorOutcome, 'unavailable', 'skipped'],
        ['a spent budget', { status: 'unavailable', code: 'llm_budget_exceeded', message: "the setup's LLM budget is spent" } as RecipeAuthorOutcome, 'budget', 'skipped'],
        ['a recipe the checks refuse', { status: 'submitted', recipe: 'version: 1\nservices: [nope]\n', usage: { inputTokens: 1, outputTokens: 1 } } as RecipeAuthorOutcome, 'refused', 'failed'],
    ])('%s from Kody stops the repairs: the failed boot stays the verdict and nothing else boots', async (_name, answer, outcome, stepState) => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, calls } = fakeEnv({ first: BUILD_FAILED });
        const a = author(store, submitted(FIRST), answer);
        const rec = await service(store, env, { author: a.client }).run(cmd());
        expect(a.calls).toHaveLength(2);
        expect(calls).toEqual([`acquire setup:${KEY}`]);
        expect(rec.state).toBe('blocked');
        expect(rec.blockers).toEqual([expect.objectContaining({ kind: 'toolchain', signature: 'compose_up' })]);
        expect(rec.recipe).toMatchObject({ content: FIRST, digest: recipeDigest(FIRST, FILES) });
        expect(rec.failureBundle).toEqual(BUILD_FAILED.blockers[0].bundle);
        expect(rec.repairs).toEqual([expect.objectContaining({ n: 1, outcome })]);
        expect(rec.steps.at(-1)).toMatchObject({ name: 'recipe', repair: 1, state: stepState });
        expect(rec.finishedAt).toBeDefined();
    });

    it('a rewrite back to a recipe that already failed in this setup stops too', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env } = fakeEnv({ first: 'not_ready', second: 'not_ready' });
        const a = author(store, submitted(FIRST), submitted(SECOND), submitted(FIRST));
        const rec = await service(store, env, { author: a.client }).run(cmd());
        expect(rec.repairs?.map((r) => r.outcome)).toEqual(['blocked', 'identical']);
        expect(rec.recipe?.content).toBe(SECOND);
    });

    describe('is never made', () => {
        const noRepair = async (boot: Boot, over: Partial<RuntimeEnvironmentSetupRequested> = {}, opts: SetupOptions = {}) => {
            const store = new InMemoryEnvironmentSetupStore();
            const { env, calls } = fakeEnv({ first: boot, none: boot });
            const a = author(store, submitted(FIRST), submitted(SECOND));
            const rec = await service(store, env, { author: a.client, ...opts }).run(cmd(over));
            expect(rec.state).toBe('blocked');
            expect(rec.repairs).toBeUndefined();
            expect(rec.steps.some((s) => s.repair)).toBe(false);
            expect(calls.filter((c) => c.startsWith('acquire'))).toHaveLength(1);
            return { rec, a };
        };

        it('for a recipe Kody did not write (the repository, or Kodus)', async () => {
            const repo = await noRepair('not_ready', { recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: FIRST } });
            expect(repo.a.calls).toHaveLength(0);
            const inferred = await noRepair('not_ready', { recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: FIRST, origin: 'inferred' } });
            expect(inferred.a.calls).toHaveLength(0);
        });

        it.each([
            ['the platform', blockedOn('platform', 'builder_failed')],
            ['no room on any cell', capacityBlocked({ refused: 'no_capacity' })],
            ['no room for the org', capacityBlocked({ refused: 'org_capacity', cap: 8, open: 8 })],
            ['a machine size no cell grants', blockedOn('resources', 'size_unavailable')],
            ['the boot outliving the setup', blockedOn('resources', 'boot_timeout', 'the boot did not finish in 44 min, the most a setup waits')],
            ['the machine memory', blockedOn('resources', 'out_of_memory', 'the build was killed: memory passed 4g')],
            ['a credential sent out', blockedOn('security_violation', 'canary_egress')],
            ['no cell connected', blockedOn('platform', 'cell_unavailable')],
        ])('after a failure on %s', async (_name, boot) => {
            const { a } = await noRepair(boot);
            expect(a.calls).toHaveLength(1);
        });

        it('after an outbound host an admin approves', async () => {
            const denied: Blocked = {
                status: 'blocked',
                blockers: [{ ...BUILD_FAILED.blockers[0], bundle: { ...BUILD_FAILED.blockers[0].bundle!, deniedEgress: [{ host: 'api.stripe.com', port: 443, at: '2026-11-11T12:00:30Z' }] } }],
            };
            const { a } = await noRepair(denied);
            expect(a.calls).toHaveLength(1);
        });

        it('under a diagnostic hold, or with a dev override', async () => {
            await noRepair('not_ready', { diagnosticHold: true });
            const dev = await noRepair('not_ready', {}, { devSha: SHA });
            expect(dev.a.calls).toHaveLength(0);
        });

        it('when the cell lost the claim mid-boot (a platform throw)', async () => {
            const { a } = await noRepair(() => {
                throw Object.assign(new Error('no cell is connected'), { code: 'cell_unavailable' });
            });
            expect(a.calls).toHaveLength(1);
        });
    });

    it('a cancelled setup stops between attempts, before Kody is asked again, without closing the setup', async () => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, calls } = fakeEnv({ first: BUILD_FAILED });
        const a = author(store, submitted(FIRST), submitted(SECOND));
        const controller = new AbortController();
        const cancelled = Object.assign(new Error('workflow cancelled'), { name: 'DBOSWorkflowCancelledError' });
        const step: SetupStepRunner = async (name, fn) => {
            // The cancel lands while the first boot fails.
            if (name === 'boot:progress') controller.abort(cancelled);
            return fn();
        };
        await expect(service(store, env, { author: a.client }).run(cmd(), step, () => controller.signal)).rejects.toBe(cancelled);
        expect(a.calls).toHaveLength(1);
        expect(calls).toEqual([`acquire setup:${KEY}`]);
        expect((await store.get('env-1'))?.state).toBe('setting_up');
    });

    it('gives every attempt its own claim and step names, the same on every run, and a replay asks Kody and boots nothing twice', async () => {
        const record = async (runner?: (names: string[]) => SetupStepRunner) => {
            const store = new InMemoryEnvironmentSetupStore();
            const f = fakeEnv({ first: 'not_ready', second: BUILD_FAILED });
            const a = author(store, submitted(FIRST), submitted(SECOND), submitted(THIRD));
            const names: string[] = [];
            const step: SetupStepRunner = runner ? runner(names) : (name, fn) => (names.push(name), fn());
            const rec = await service(store, f.env, { author: a.client, now: () => new Date('2026-11-11T12:00:00Z') }).run(cmd(), step);
            return { names, rec, a, f };
        };
        const once = await record();
        const again = await record();
        expect(once.rec.state).toBe('active');
        expect(once.names).toEqual(again.names);
        expect(new Set(once.names).size).toBe(once.names.length);
        expect(once.f.acquired.map((r) => r.idempotencyKey)).toEqual([`setup:${KEY}`, `setup:${KEY}:repair-1`, `setup:${KEY}:repair-2`]);
        // Each call to Kody names its attempt, the same on every run: the product answers a repeat with what it stored, not a second run.
        expect(once.a.calls.map((c) => c.attempt)).toEqual(['author-0', 'repair-1', 'repair-2']);

        // A DBOS-like runner: results recorded by position, replayed on recovery.
        const log: unknown[] = [];
        const dbos = (crashAfter?: string) => (names: string[]): SetupStepRunner => {
            let i = 0;
            return async (name, fn) => {
                const at = i++;
                names.push(name);
                if (at < log.length) return log[at] as any;
                const out = await fn();
                log.push(out);
                if (name === crashAfter) throw Object.assign(new Error('worker killed'), { name: 'WorkerKilledCancel' });
                return out;
            };
        };
        const store = new InMemoryEnvironmentSetupStore();
        const f = fakeEnv({ first: 'not_ready', second: BUILD_FAILED });
        const a = author(store, submitted(FIRST), submitted(SECOND), submitted(THIRD));
        const svc = service(store, f.env, { author: a.client });
        const names: string[] = [];
        await expect(svc.run(cmd(), dbos('boot:repair:1')(names))).rejects.toThrow('worker killed');
        const rec = await svc.run(cmd(), dbos()([]));
        expect(rec).toMatchObject({ state: 'active', recipe: { content: THIRD } });
        expect(a.calls).toHaveLength(3);
        expect(f.acquired).toHaveLength(3);
    });

    it('a setup that needs no repair records exactly what it did before, whatever the cap', async () => {
        const run = async (boot: Boot, authorRepairs: number, over: Partial<RuntimeEnvironmentSetupRequested> = {}) => {
            const store = new InMemoryEnvironmentSetupStore();
            const { env, calls } = fakeEnv({ first: boot, none: boot });
            const a = author(store, submitted(FIRST), submitted(SECOND));
            const names: string[] = [];
            const step: SetupStepRunner = (name, fn) => (names.push(name), fn());
            const rec = await service(store, env, { author: a.client, authorRepairs, now: () => new Date('2026-11-11T12:00:00Z') }).run(cmd(over), step);
            return JSON.stringify({ rec, saved: store.saved, names, calls, asked: a.calls });
        };
        for (const [boot, over] of [
            ['ok', {}],
            [blockedOn('platform', 'builder_failed'), {}],
            [blockedOn('resources', 'boot_timeout'), {}],
            ['not_ready', { recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: FIRST } }],
            ['not_ready', { recipe: { path: '.kodus/workspace.yaml', sha: SHA, content: FIRST, origin: 'inferred' as const } }],
        ] as const) {
            expect(await run(boot, 2, over)).toBe(await run(boot, 0, over));
        }
    });
});

describe('repairFailureOf', () => {
    const blocked = (b: { kind: string; signature: string; message: string }, over: Partial<EnvironmentSetupRecord> = {}): EnvironmentSetupRecord => ({
        environmentId: 'env-1',
        organizationId: 'org-1',
        repositoryId: 'repo-1',
        key: KEY,
        state: 'blocked',
        steps: [],
        blockers: [{ ...b, at: '2026-11-11T12:05:00Z' }],
        requestedAt: '2026-11-11T12:00:00Z',
        updatedAt: '2026-11-11T12:05:00Z',
        refSource: 'default_branch',
        recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', origin: 'authored', content: FIRST, digest: recipeDigest(FIRST) },
        ...over,
    });

    // G1: a registry refused to the image build is Kody's to repair: its next Dockerfile declares the mirror's build
    // args (declareMirrorBuildArgs), unlike a host only an owner can allow (external_service:egress).
    it('repairs a build that reached a registry itself, never a machine that needs an approval', () => {
        const bundle = (host: string) => ({
            services: [{ name: 'kodus-boot', state: 'exited' as const, logTail: ['#9 [api 4/8] RUN npm ci', '#9 ERROR: process "/bin/sh -c npm ci" did not complete successfully: exit code: 1'] }],
            ports: [], disk: [], deniedEgress: [{ host, port: 443, at: '2026-11-11T12:05:00Z' }], redactions: 0, truncated: false, collectedAt: '2026-11-11T12:05:00Z',
        });
        const b = { kind: 'toolchain', signature: 'compose_up', message: 'compose up: exit 1' };
        expect(repairFailureOf(blocked(b, { failureBundle: bundle('registry.npmjs.org') }))).toMatchObject({ failure: { signature: 'external_service:build_egress:registry.npmjs.org' } });
        expect(repairFailureOf(blocked(b, { failureBundle: { ...bundle('api.vendor.example'), services: [] } }))).toBeUndefined();
    });

    it('is the failure the next setup would send back, for an authored recipe that failed on its own account', () => {
        expect(repairFailureOf(blocked({ kind: 'resources', signature: 'image_too_large', message: 'the image is 31 GB' }))).toMatchObject({ kind: 'resources', failure: { signature: 'image_too_large' } });
        expect(repairFailureOf(blocked({ kind: 'toolchain', signature: 'compose_refused', message: 'privileged: true is refused' }))).toMatchObject({ failure: { signature: 'compose_refused' } });
    });

    const TIMEOUT = { kind: 'resources', signature: 'boot_timeout', message: 'the boot did not come up within 30 minutes' };
    const timedOut = (phases: Array<{ name: string; ms: number; running?: true }> | undefined, over: Partial<EnvironmentSetupRecord> = {}) =>
        blocked(TIMEOUT, { steps: [{ name: 'boot', state: 'failed', startedAt: '2026-11-11T12:00:00Z', ...(phases ? { phases } : {}) }], ...over });

    it("a boot that ran out of time in the recipe's own build goes back to Kody with the slowest steps, so the Dockerfile can be restructured", () => {
        // twenty: node_modules copied between stages, then a workspace install.
        expect(repairFailureOf(timedOut([
            { name: 'COPY /app/node_modules /app/node_modules', ms: 439_500 },
            { name: 'yarn workspaces', ms: 169_000 },
            { name: 'pull node:22', ms: 21_000 },
        ]))).toEqual({
            kind: 'resources',
            failure: {
                signature: 'boot_timeout',
                title: "The build did not finish within the setup's limit",
                evidence: ['COPY /app/node_modules /app/node_modules: 439.5 s', 'yarn workspaces: 169.0 s', 'pull node:22: 21.0 s'],
            },
        });
        // cal.com: exporting the layers of what the install put in the image.
        expect(repairFailureOf(timedOut([
            { name: 'export layers', ms: 1_260_400, running: true },
            { name: 'yarn install', ms: 1_005_300 },
            { name: 'docker load', ms: 61_000 },
        ]))?.failure.evidence).toEqual(['export layers: 1260.4 s (still running at the limit)', 'yarn install: 1005.3 s', 'docker load: 61.0 s']);
    });

    it('a boot that ran out of time pulling base images, exporting alone, or with no phases recorded is no recipe failure to repair', () => {
        expect(repairFailureOf(timedOut([{ name: 'pull nvidia/cuda:12', ms: 1_500_000 }, { name: 'yarn install', ms: 90_000 }]))).toBeUndefined();
        expect(repairFailureOf(timedOut([{ name: 'export layers', ms: 1_200_000 }, { name: 'pull node:22', ms: 300_000 }, { name: 'docker load', ms: 90_000 }]))).toBeUndefined();
        expect(repairFailureOf(timedOut(undefined))).toBeUndefined();
    });

    it("a timeout is repaired at most once per setup: each try costs the setup's whole limit", () => {
        const phases = [{ name: 'yarn install', ms: 1_700_000 }];
        const repairs = [{ n: 1, max: 2, blocker: { kind: 'resources', signature: 'boot_timeout', title: 'x' }, failedDigest: 'sha256:a', outcome: 'blocked' as const, at: '2026-11-11T12:30:00Z' }];
        expect(repairFailureOf(timedOut(phases))).toBeDefined();
        expect(repairFailureOf(timedOut(phases, { repairs }))).toBeUndefined();
    });

    it('is none for an active setup, a dev override or another origin', () => {
        const b = { kind: 'toolchain', signature: 'compose_up', message: 'boom' };
        expect(repairFailureOf(blocked(b, { state: 'active' }))).toBeUndefined();
        expect(repairFailureOf(blocked(b, { refSource: 'dev_override' }))).toBeUndefined();
        expect(repairFailureOf(blocked(b, { recipe: { path: '.kodus/workspace.yaml', sha: SHA, state: 'found', origin: 'inferred', content: FIRST, digest: 'sha256:x' } }))).toBeUndefined();
    });
});

// The cell revokes a repository token right after its first download, so the
// boot of Kody's rewrite downloads with fresh tokens the product mints for
// this setup (twenty: the repair boot failed in 2 s on `download status 401`).
describe("the boot of Kody's rewrite downloads with fresh tokens", () => {
    const FIRST_TOKEN = sealSecret('ghs_first', devSealKey(), KEY);
    const FRESH_TOKEN = sealSecret('ghs_fresh', devSealKey(), KEY);
    const MEMBER_TOKEN = sealSecret('ghs_member_first', devSealKey(), KEY);
    const FRESH_MEMBER = sealSecret('ghs_member_fresh', devSealKey(), KEY);
    const workspace = [
        { repositoryId: 'repo-1', fullName: 'acme/shop', alias: 'shop', role: 'primary' as const, sha: SHA, branch: 'main', sealedRepoToken: FIRST_TOKEN },
        { repositoryId: 'repo-2', fullName: 'acme/billing', alias: 'billing', role: 'member' as const, sha: 'd'.repeat(40), branch: 'main', sealedRepoToken: MEMBER_TOKEN },
    ];
    const run = async (tokens: SetupOptions['repoTokens'], over: Partial<RuntimeEnvironmentSetupRequested> = {}) => {
        const store = new InMemoryEnvironmentSetupStore();
        const { env, calls } = fakeEnv({ first: BUILD_FAILED });
        const a = author(store, submitted(FIRST), submitted(SECOND));
        const boots: Array<{ token: string; workspace?: unknown }> = [];
        const rec = await testSetupService(
            { envForSetup: (input) => (boots.push({ token: input.sealedRepoToken, workspace: input.workspace }), env) },
            store,
            // The request was just made: its first boot downloads with the command's tokens.
            { authorRepairs: 2, author: a.client, now: clockFrom(cmd().requestedAt), ...(tokens ? { repoTokens: tokens } : {}) },
        ).run(cmd({ repoToken: FIRST_TOKEN, ...over }));
        return { rec, calls, a, boots };
    };

    it('asks the product for this setup and boots the rewrite with the tokens it answers', async () => {
        const asked: unknown[] = [];
        const { rec, boots } = await run({ refresh: async (req) => (asked.push(req), { status: 'issued', repoToken: FRESH_TOKEN, workspace: [{ repositoryId: 'repo-2', sealedRepoToken: FRESH_MEMBER }] }) }, { workspace });

        expect(rec.state).toBe('active');
        expect(asked).toEqual([{ organizationId: 'org-1', llmToken: LLM_TOKEN, setupKey: KEY, attempt: 'repair-1' }]);
        expect(boots.map((b) => b.token)).toEqual([FIRST_TOKEN, FRESH_TOKEN]);
        expect(boots[1].workspace).toMatchObject({ primary: { base: { sealedToken: FRESH_TOKEN } }, members: [{ alias: 'billing', base: { sealedToken: FRESH_MEMBER } }] });
    });

    it('stops with a plain reason when no fresh token is to be had, and Kody is not asked to rewrite', async () => {
        for (const tokens of [undefined, { refresh: async () => ({ status: 'unavailable' as const, message: 'the product answered 404' }) }]) {
            const { rec, calls, a } = await run(tokens);

            expect(a.calls).toHaveLength(1);
            expect(calls.filter((c) => c.startsWith('acquire'))).toHaveLength(1);
            expect(rec.state).toBe('blocked');
            expect(rec.blockers).toEqual([expect.objectContaining({ kind: 'toolchain', signature: 'compose_up' })]);
            expect(rec.repairs).toEqual([expect.objectContaining({ n: 1, outcome: 'no_token' })]);
            expect(rec.steps.at(-1)?.detail).toMatch(/^Kody's rewrite was not asked: a new boot could not download the repository again/);
        }
    });
});
