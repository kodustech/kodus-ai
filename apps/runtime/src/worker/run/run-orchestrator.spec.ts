import { FakeEnvironmentRuntime } from '@libs/runtime/environment';

import { SCENARIOS } from '../../fake-cell/scenarios';
import { shopRunRequest } from '../../e2e/fixtures';
import { awaitForkApproval, finalizeStoppedRun, runRuntimeRun } from './run-orchestrator';
import { HmacCanaryVault } from '../canary/canary';
import { inMemoryRunDeps } from './in-memory-deps';
import shopTurns from '../agent/fixtures/shop-orders.json';
import { RuntimeAgent } from '../agent/runtime-agent';

const seed = async (projection: any, req: ReturnType<typeof shopRunRequest>) =>
    projection.upsert(req.runId, {
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


/** The publications after the progress comments: the check and the result. */
const finalOnly = <T extends { progress?: unknown }>(published: T[]) => published.filter((p) => !p.progress);

describe('Run image pin from acquired manifests (#2505)', () => {
    const concrete = 'kodus-bake/fixture@' + 'a'.repeat(40);
    const fixture = (requested = 'latest', prImage = concrete) => {
        const fake = new FakeEnvironmentRuntime({ ...SCENARIOS, shop: { ...SCENARIOS.shop, imageId: concrete } }, () => new Date());
        const h = inMemoryRunDeps({ env: fake });
        const req = shopRunRequest();
        req.environment.imageId = requested;
        const acquire = h.deps.env.acquire.bind(h.deps.env);
        const acquired = jest.spyOn(h.deps.env, 'acquire').mockImplementation(async request => {
            const result = await acquire({ ...request, imageId: concrete });
            return 'status' in result || request.ref.side !== 'pr' ? result : { ...result, manifest: { ...result.manifest, imageId: prImage } };
        });
        const reset = fake.reset.bind(fake);
        const resets = jest.spyOn(h.deps.env, 'reset').mockImplementation(async (claimId: string, imageId?: string) =>
            imageId === concrete ? reset(claimId) : { code: 'transport_lost' as const, stepId: 'reset-image-mismatch' });
        const plan = jest.spyOn(h.deps.agent, 'plan');
        const probe = jest.spyOn(h.deps.env, 'probe');
        return { ...h, req, resets, plan, probe, acquired };
    };

    // A real cell resolves latest at acquire; the old client reset still sent latest and lost every round.
    it('pins the common concrete bake before replay and forwards it on every reset', async () => {
        const h = fixture();
        await seed(h.projection, h.req);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result.state).toBe('regression');
        expect((await h.projection.get(h.req.runId))!.imageId).toBe(concrete);
        expect(h.req.environment.imageId).toBe('latest');
        expect(h.resets.mock.calls.length).toBeGreaterThan(0);
        expect(h.resets.mock.calls.every(([, image]) => image === concrete)).toBe(true);
        expect(h.plan).toHaveBeenCalledTimes(1);
    });

    it('accepts an explicitly requested concrete image when both acquired manifests match', async () => {
        const h = fixture(concrete);
        await seed(h.projection, h.req);
        expect((await runRuntimeRun(h.req, h.deps)).state).toBe('regression');
        expect((await h.projection.get(h.req.runId))!.imageId).toBe(concrete);
        expect(h.probe).toHaveBeenCalled();
    });

    it('derives the pin from serialized acquire checkpoints without acquiring again', async () => {
        const h = fixture();
        const checkpoints = new Map<string, unknown>();
        for (const side of ['base', 'pr'] as const) {
            const claim = await h.deps.env.acquire({
                organizationId: h.req.organizationId,
                environmentId: h.req.environment.environmentId,
                runId: h.req.runId,
                imageId: 'latest',
                ref: { side, sha: side === 'base' ? h.req.pullRequest.baseSha : h.req.pullRequest.headSha },
                consumer: 'runtime',
                idempotencyKey: `${h.req.runId}:${side}:${h.req.attempt}`,
            });
            checkpoints.set(`acquire:${side}:1`, JSON.parse(JSON.stringify({ claim, readyAt: new Date().toISOString() })));
        }
        h.acquired.mockClear();
        h.acquired.mockImplementation(async () => { throw new Error('a recovered acquire must not run again'); });
        const step = h.deps.step;
        h.deps.step = (name, fn) => checkpoints.has(name) ? Promise.resolve(checkpoints.get(name) as any) : step(name, fn);
        await seed(h.projection, h.req);
        expect((await runRuntimeRun(h.req, h.deps)).state).toBe('regression');
        expect(h.acquired).not.toHaveBeenCalled();
        expect((await h.projection.get(h.req.runId))!.imageId).toBe(concrete);
        expect(h.req.environment.imageId).toBe('latest');
        expect(h.resets.mock.calls.length).toBeGreaterThan(0);
        expect(h.resets.mock.calls.every(([, image]) => image === concrete)).toBe(true);
    });

    it.each([
        ['different side bake', 'latest', 'other-bake'],
        ['missing side image', 'latest', ''],
        ['unresolved side alias', 'latest', 'latest'],
        ['explicit requested image mismatch', 'explicit-bake', concrete],
    ])('refuses %s before planning or probing and releases both claims', async (_case, requested, prImage) => {
        const h = fixture(requested, prImage);
        await seed(h.projection, h.req);
        const result = await runRuntimeRun(h.req, h.deps);
        expect(result).toMatchObject({ state: 'errored', conclusion: 'neutral' });
        expect(h.plan).not.toHaveBeenCalled();
        expect(h.probe).not.toHaveBeenCalled();
        expect(h.resets).not.toHaveBeenCalled();
        expect(h.claims.claims.size).toBe(2);
        expect([...h.claims.claims.values()].every(claim => claim.released)).toBe(true);
    });
});

describe('runRuntimeRun', () => {
    it('passes only the acquired base capability and independent canaries into planning', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const req = shopRunRequest(); await seed(projection, req);
        const acquire = deps.env.acquire.bind(deps.env);
        jest.spyOn(deps.env, 'acquire').mockImplementation(async (request) => {
            const out = await acquire(request);
            return 'status' in out || request.ref.side !== 'base' ? out : { ...out, capabilities: { browserExplore: 'v1' as const } };
        });
        const planned = jest.spyOn(deps.agent, 'plan');
        await runRuntimeRun(req, deps);
        expect(planned).toHaveBeenCalledWith(expect.objectContaining({ baseCapabilities: { browserExplore: 'v1' }, canaries: expect.any(Array) }));
    });

    it('finds the regression on POST /orders, clears GET /orders and publishes a failing check', async () => {
        const { deps, projection, stream, published, claims } = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(projection, req);

        const result = await runRuntimeRun(req, deps);

        expect(result).toMatchObject({ state: 'regression', verdictState: 'regression', conclusion: 'failure', title: '1 regression' });
        const run = await projection.get(req.runId);
        // Both sides booted: the Run keeps its time to ready for Environment Health.
        expect(run!.bootMs).toEqual(expect.any(Number));
        expect(run!.bootMs).toBeGreaterThanOrEqual(0);
        expect(run!.probes!.map((p) => [p.probeId, p.verdict])).toEqual([
            ['orders-empty-cart', 'finding'],
            ['orders-list', 'not_reproduced'],
        ]);
        expect(run!.findings![0].differingFields).toEqual(expect.arrayContaining(['status']));
        // Where the finding comes from in the diff, for the Run page; never in the report.
        expect(run!.findings![0].diffRef).toEqual({ file: expect.any(String), line: expect.any(Number) });
        expect(req.diff.map((d) => d.path)).toContain(run!.findings![0].diffRef!.file);
        expect(run!.findings![0].intent).toBe('unintended');
        // The finding keeps its observer probe and what each side answered: the "reproduce on your machine" script.
        expect(run!.reproduction!.probes.map((p) => p.probeId)).toEqual(['orders-empty-cart']);
        expect(run!.reproduction!.probes[0]).toMatchObject({ spec: { kind: 'http' }, base: expect.any(Object), pr: expect.any(Object) });
        // The shell probe the agent wrote never reaches the replay.
        expect(run!.probes!.some((p) => p.probeId === 'sneaky-shell')).toBe(false);

        // One comment edited at each phase (screen 6), then the check and the result.
        expect(published.filter((p) => p.progress).map((p) => [p.key, p.progress!.phase])).toEqual([
            [`${req.runId}:1:comment:booting`, 'booting'],
            [`${req.runId}:1:comment:applying`, 'applying'],
            [`${req.runId}:1:comment:testing`, 'testing'],
            [`${req.runId}:1:comment:reporting`, 'reporting'],
        ]);
        expect(published.find((p) => p.progress?.phase === 'reporting')!.progress).toMatchObject({ tested: { done: 2, total: 2 }, regressions: 1 });
        const out = finalOnly(published);
        const kinds = out.map((p) => p.kind);
        expect(kinds).toEqual(['check', 'comment']);
        expect(out[0].check).toMatchObject({ status: 'completed', conclusion: 'failure' });
        expect(out[0].key).toBe(`${req.runId}:1:check`);
        // The comment is structured: the product renders it (ADR-052).
        expect(out[1].comment).toBeUndefined();
        expect(out[1].report).toMatchObject({ state: 'regression', verdictState: 'regression', headSha: req.pullRequest.headSha, trigger: req.trigger });
        expect(out[1].report!.paths.map((p) => [p.entryPoint, p.verdict, p.base, p.pr])).toEqual([
            ['POST /orders', 'finding', { status: 400 }, { status: 500 }],
            ['GET /orders', 'not_reproduced', { status: 200 }, { status: 200 }],
        ]);
        // The response diff and the diff link are the Run page's: never in what the PR gets.
        expect(run!.findings![0].responseDiff!.fields).toContainEqual({ path: 'json.error', base: '"cart is empty"', pr: '"internal"' });
        expect(JSON.stringify(out)).not.toMatch(/responseDiff|diffRef|cart is empty/);
        // The publish request carries no target: the product worker reads it from the Run record.
        expect(JSON.stringify(published)).not.toContain('repo-shop');

        const states = (await stream.read(req.organizationId, req.runId))!.events.filter((e) => e.type === 'state').map((e) => e.data.state);
        expect(states).toEqual(['booting', 'testing', 'regression']);
        expect([...claims.claims.values()].every((c) => c.released)).toBe(true);
    });

    it('S-19: a Run whose PR changes the recipe says so in the report and the fallback summary', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(projection, req);
        await projection.upsert(req.runId, { recipeChangedInPr: ['.kodus/workspace.yaml'] });

        await runRuntimeRun(req, deps);

        const out = finalOnly(published);
        expect(out.map((p) => p.report?.recipeChangedInPr)).toEqual([['.kodus/workspace.yaml'], ['.kodus/workspace.yaml']]);
        expect(out[0].check!.summary).toContain('**Recipe changed**: this PR changes `.kodus/workspace.yaml`');
    });

    describe('S-19: a PR that changes only the recipe the claims replace', () => {
        const withRecipe = (diff: ReturnType<typeof shopRunRequest>['diff'], extra: Partial<ReturnType<typeof shopRunRequest>> = {}) => {
            const req = shopRunRequest({ diff, ...extra });
            return { ...req, environment: { ...req.environment, recipe: { path: '.kodus/workspace.yaml', content: 'version: 1\n' } } };
        };
        const run = async (req: ReturnType<typeof shopRunRequest>) => {
            const h = inMemoryRunDeps();
            const acquire = jest.spyOn(h.deps.env, 'acquire');
            await seed(h.projection, req);
            await h.projection.upsert(req.runId, { recipeChangedInPr: ['.kodus/workspace.yaml'] });
            const result = await runRuntimeRun(req, h.deps);
            return { ...h, acquire, result };
        };

        it('boots nothing and ends partly tested with the recipe note, as a diff with nothing to call', async () => {
            const req = withRecipe([{ path: '.kodus/workspace.yaml', patch: '+  health: /ready' }]);
            const { acquire, result, published, stream, projection } = await run(req);

            expect(acquire).not.toHaveBeenCalled();
            expect(result).toMatchObject({ state: 'partly_tested', verdictState: 'partly_tested', conclusion: 'neutral', title: 'Partly tested' });
            const states = (await stream.read(req.organizationId, req.runId))!.events.filter((e) => e.type === 'state').map((e) => e.data.state);
            expect(states).toEqual(['partly_tested']);
            expect((await projection.get(req.runId))!.bootMs).toBeUndefined();
            // No progress comment: only the check and the result.
            expect(published.filter((p) => p.progress)).toEqual([]);
            const out = finalOnly(published);
            expect(out.map((p) => p.kind)).toEqual(['check', 'comment']);
            // What the "changes nothing Kody can call" renderer reads: no path, nothing uncovered, plus S-19.
            expect(out[1].report).toMatchObject({ state: 'partly_tested', paths: [], uncovered: [], recipeChangedInPr: ['.kodus/workspace.yaml'] });
            expect(out[0].check!.summary).toContain('**Recipe changed**: this PR changes `.kodus/workspace.yaml`');
        });

        it('a recipe change with code boots both sides as before', async () => {
            const code = shopRunRequest().diff;
            const { acquire, result } = await run(withRecipe([...code, { path: '.kodus/workspace.yaml', patch: '+x' }]));
            expect(acquire.mock.calls.map(([r]) => r.ref.side).sort()).toEqual(['base', 'pr']);
            expect(result.state).toBe('regression');
        });

        it('boots when a changed .kodus/ file is not one the claims replace (kr-grafana #7: the compose), or when the claims carry no recipe', async () => {
            const compose = await run(withRecipe([{ path: '.kodus/compose.yaml', patch: '+      GF_LOG_LEVEL: debug' }]));
            expect(compose.acquire).toHaveBeenCalled();
            const renamed = await run(withRecipe([{ path: '.kodus/workspace.yaml', patch: '' }], { prChangedRecipeFiles: ['.kodus/workspace.yaml', '.kodus/compose.yaml'] }));
            expect(renamed.acquire).toHaveBeenCalled();
            const cut = await run(withRecipe([{ path: '.kodus/workspace.yaml', patch: '+x' }], { diffTruncated: true }));
            expect(cut.acquire).toHaveBeenCalled();
            const noRecipe = await run(shopRunRequest({ diff: [{ path: '.kodus/workspace.yaml', patch: '+x' }] }));
            expect(noRecipe.acquire).toHaveBeenCalled();
        });
    });

    it('could_not_boot when the base does not boot either', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const req = shopRunRequest({ environment: { environmentId: 'broken', imageId: 'img-shop-1', expose: [] } });
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'could_not_boot', conclusion: 'neutral', title: 'Could not boot' });
        // A boot that did not finish has no time to ready.
        expect((await projection.get(req.runId))!.bootMs).toBeUndefined();
    });

    it("could_not_boot names the base's missing variable on every untested path, on the Run and in the report", async () => {
        const h = inMemoryRunDeps();
        const req = shopRunRequest({ environment: { environmentId: 'broken', imageId: 'img-shop-1', expose: [] } });
        await seed(h.projection, req);
        await runRuntimeRun(req, h.deps);
        const run = (await h.projection.get(req.runId))!;
        expect(run.uncovered!.length).toBeGreaterThan(0);
        expect(run.uncovered!.every((u) => u.reason === 'blocker' && u.blocker?.kind === 'missing_env' && u.blocker.name === 'PAYMENTS_KEY')).toBe(true);
        const report = h.published.filter((p) => p.kind === 'comment' && p.report).at(-1)!.report!;
        expect(report.uncovered).toEqual(run.uncovered);
        expect(report.bootFailure).toEqual({ failsOnBase: true, kind: 'missing_env' });
    });

    it('regression when only the PR fails to boot', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) => (r.ref.side === 'pr' ? { status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'node-24', message: 'x' }] } : acquire(r));
        const { deps, projection } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result.state).toBe('regression');
        expect((await projection.get(req.runId))!.findings![0].findingKind).toBe('pr_destabilizes_machine');
        expect((await projection.get(req.runId))!.bootMs).toBeUndefined();
    });

    it('a PR boot the cell ran out of memory for is never a regression: partly tested, neutral, every path untested with that cause', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) =>
            r.ref.side === 'pr' ? { status: 'blocked', blockers: [{ kind: 'resources', signature: 'out_of_memory', message: 'killed at its memory limit' }] } : acquire(r);
        const { deps, projection, published } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'partly_tested', conclusion: 'neutral' });
        const run = (await projection.get(req.runId))!;
        expect(run.findings ?? []).toEqual([]);
        expect(run.uncovered!.length).toBeGreaterThan(0);
        expect(run.uncovered!.every((u) => u.reason === 'blocker' && u.blocker?.kind === 'resources')).toBe(true);
        const report = published.filter((p) => p.kind === 'comment' && p.report).at(-1)!.report!;
        expect(report.paths).toEqual([]);
        expect(report.bootFailure).toBeUndefined();
    });

    it('a PR whose build needs a host the sandbox does not reach carries the error line and tail on the Run and one line in the report', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        const message = [
            'compose up: exit 1',
            '#14 [api 5/9] RUN go work sync',
            '#14 2.31 go: verifying module: github.com/a/b@v1.2.3: Get "https://sum.golang.org/lookup/github.com/a/b@v1.2.3": dial tcp: lookup sum.golang.org: no such host',
            '#14 ERROR: process "/bin/sh -c go work sync" did not complete successfully: exit code: 1',
        ].join('\n');
        env.acquire = async (r) => (r.ref.side === 'pr' ? { status: 'blocked', blockers: [{ kind: 'unknown', signature: 'compose_up', message }] } : acquire(r));
        const { deps, projection, published } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'partly_tested', conclusion: 'neutral' });
        const run = (await projection.get(req.runId))!;
        expect(run.bootFailure).toMatchObject({
            side: 'pr',
            kind: 'platform',
            signature: 'platform:go_checksum_db',
            errorLine: expect.stringContaining('lookup sum.golang.org: no such host'),
            logTail: message.split('\n'),
            at: expect.any(String),
        });
        const report = published.filter((p) => p.kind === 'comment' && p.report).at(-1)!.report!;
        expect(report.bootError).toEqual({ side: 'pr', line: run.bootFailure!.errorLine });
    });

    it('a PR that does not boot keeps its boot failure next to the regression', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) =>
            r.ref.side === 'pr' ? { status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'node-24', message: 'step 1\nError: Cannot find module \'left-pad\'' }] } : acquire(r);
        const { deps, projection } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        expect((await projection.get(req.runId))!.bootFailure).toMatchObject({ side: 'pr', errorLine: "Error: Cannot find module 'left-pad'" });
    });

    it('errored when the LLM budget is exhausted, and the claims are released', async () => {
        const { deps, projection, claims } = inMemoryRunDeps({ maxTokensPerRun: 500 });
        const req = shopRunRequest();
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'errored', title: 'Could not finish' });
        expect((await projection.get(req.runId))!.reason).toContain('LLM');
        expect([...claims.claims.values()].every((c) => c.released)).toBe(true);
    });

    it('errored when the cell is lost twice while acquiring', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        let calls = 0;
        env.acquire = async () => {
            calls++;
            throw new Error('cell_unavailable');
        };
        const { deps, projection } = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(projection, req);
        expect((await runRuntimeRun(req, deps)).state).toBe('errored');
        // Base and PR boot together (one round each), then base gets its one retry and the Run stops.
        expect(calls).toBe(3);
    });

    it('timed_out after 30 min in the queue', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const req = shopRunRequest({ requestedAt: new Date(Date.now() - 31 * 60_000).toISOString() });
        await seed(projection, req);
        expect(await runRuntimeRun(req, deps)).toMatchObject({ state: 'timed_out', conclusion: 'timed_out' });
    });

    it('S-32: a probe the agent labels POST /orders but that only sent GET /orders covers nothing: partly tested, never success', async () => {
        const lying = JSON.parse(shopTurns[1].text);
        lying.probes = lying.probes.filter((p: any) => p.probe.id === 'orders-list').map((p: any) => ({ ...p, entryPoint: 'POST /orders' }));
        const turns = [shopTurns[0], { ...shopTurns[1], text: JSON.stringify(lying) }] as any;
        const { deps, projection } = inMemoryRunDeps({ turns });
        const req = shopRunRequest({
            diff: [{ path: 'src/orders/orders.controller.ts', patch: '@@ -4,1 +4,1 @@\n     create() {', content: "@Controller('orders')\nexport class A {\n    @Post()\n    create() {\n        return 1;\n    }\n}" }],
        });
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'partly_tested', conclusion: 'neutral' });
        const run = await projection.get(req.runId);
        expect(run!.probes!.map((p) => [p.probeId, p.entryPoint, p.verdict])).toEqual([['orders-list', 'unmapped', 'not_reproduced']]);
        expect(run!.uncoveredEntryPoints).toEqual(['POST /orders']);
        // What it really sent is carried for the screens, from the spec, and still covers nothing.
        expect(run!.probes![0].exercised).toBe('GET /orders');
    });

    it('acquires both machines with the recipe the setup recorded, never the PR copy (§6)', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const asked: any[] = [];
        const acquire = env.acquire.bind(env);
        env.acquire = async (req) => {
            asked.push(req);
            return acquire(req);
        };
        const { deps, projection } = inMemoryRunDeps({ env });
        const recipe = { path: '.kodus/workspace.runtime.yaml', content: 'version: 1\n', digest: 'sha256:r' };
        const req = shopRunRequest();
        req.environment = { ...req.environment, recipe };
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        expect(asked.map((a) => [a.ref.side, a.recipe])).toEqual([
            ['base', recipe],
            ['pr', recipe],
        ]);
    });

    it('acquires base and PR at the machine size the setup recorded, and none when it recorded none', async () => {
        for (const size of [{ memoryMb: 8_192, cpus: 4 }, undefined]) {
            const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
            const asked: any[] = [];
            const acquire = env.acquire.bind(env);
            env.acquire = async (req) => {
                asked.push(req);
                return acquire(req);
            };
            const { deps, projection } = inMemoryRunDeps({ env });
            const req = shopRunRequest();
            if (size) req.environment = { ...req.environment, size };
            await seed(projection, req);
            await runRuntimeRun(req, deps);
            expect(asked.map((a) => [a.ref.side, a.size])).toEqual([
                ['base', size],
                ['pr', size],
            ]);
        }
    });

    it('a blocked outbound request during the test forces neutral', async () => {
        const listOnly = JSON.parse(shopTurns[1].text);
        listOnly.probes = listOnly.probes.filter((p: any) => p.probe.id === 'orders-list');
        const turns = [shopTurns[0], { ...shopTurns[1], text: JSON.stringify(listOnly) }] as any;
        const { deps, projection, claims } = inMemoryRunDeps({ turns });
        const req = shopRunRequest({
            diff: [{ path: 'src/orders/orders.controller.ts', patch: '@@ -4,1 +4,1 @@\n     list() {', content: "@Controller('orders')\nexport class A {\n    @Get()\n    list() {\n        return 1;\n    }\n}" }],
        });
        await seed(projection, req);
        const record = claims.record.bind(claims);
        claims.record = async (c) => {
            await record(c);
            claims.egress.push({ claimId: c.claimId, host: 'telemetry.example.test', port: 443, phase: 'test' });
        };
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'no_regressions', conclusion: 'neutral' });
        expect(result.title).toBe('No regressions in what was tested · 2 blocked outbound requests');
    });

    it('finalizeStoppedRun supersedes a live Run without a comment and releases its claims', async () => {
        const { deps, projection, published, claims } = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(projection, req);
        await projection.upsert(req.runId, { state: 'testing' });
        await claims.record({ claimId: 'c1', cellId: 'cell', runId: req.runId, organizationId: req.organizationId, side: 'base', hardExpiresAt: new Date().toISOString() });
        const moved = await finalizeStoppedRun(deps, { ...req, headSha: req.pullRequest.headSha }, 'superseded', 'new push');
        expect(moved).toBe(true);
        expect((await projection.get(req.runId))!.state).toBe('superseded');
        expect(published.map((p) => p.kind)).toEqual(['check']);
        expect(published[0].check!.conclusion).toBe('cancelled');
        expect(await deps.claims.forRun(req.runId)).toEqual([]);
    });

    it('cancel does nothing once publishing started', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(projection, req);
        await projection.upsert(req.runId, { state: 'testing', publishStartedAt: new Date().toISOString() });
        expect(await finalizeStoppedRun(deps, { ...req, headSha: req.pullRequest.headSha }, 'cancelled', 'closed')).toBe(false);
        expect(published).toEqual([]);
    });
});

describe('intent', () => {
    const ORDERS_SPEC = { id: 'orders-spec', path: 'test/orders.e2e-spec.ts', command: 'npx jest test/orders.e2e-spec.ts', entryPoint: 'POST /orders' };
    const turnsWith = (tests: unknown[], intentText: string) => {
        const plan = JSON.parse(shopTurns[1].text);
        plan.tests = tests;
        return [shopTurns[0], { ...shopTurns[1], text: JSON.stringify(plan) }, { task: 'runtime.intent', text: intentText, usage: { inputTokens: 10, outputTokens: 5 } }] as any;
    };
    /** Exit codes of the test command on each side. */
    const envWithTests = (exit: { base: number; pr: number }) => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const sides = new Map<string, 'base' | 'pr'>();
        const acquire = env.acquire.bind(env);
        env.acquire = async (r) => {
            const c = await acquire(r);
            if ('claimId' in c) sides.set(c.claimId, r.ref.side as 'base' | 'pr');
            return c;
        };
        const exec = env.exec.bind(env);
        const ran: string[] = [];
        env.exec = async (claimId, r) => {
            const out = await exec(claimId, r);
            if (!r.command.includes('jest') || 'code' in out) return out;
            ran.push(`${sides.get(claimId)}:${r.command}`);
            return { ...out, exitCode: exit[sides.get(claimId)!] };
        };
        return { env, ran };
    };

    it('a pre-existing test that passes on base and PR downgrades the finding to an intended change: partly tested, neutral', async () => {
        const { env, ran } = envWithTests({ base: 0, pr: 0 });
        const { deps, projection, published } = inMemoryRunDeps({ env, turns: turnsWith([ORDERS_SPEC], '{"intent":"intended","testId":"orders-spec"}') });
        const req = shopRunRequest();
        await seed(projection, req);

        const result = await runRuntimeRun(req, deps);

        expect(result).toMatchObject({ state: 'partly_tested', conclusion: 'neutral', title: 'Partly tested · 1 intended change' });
        expect(ran).toEqual(['base:npx jest test/orders.e2e-spec.ts', 'pr:npx jest test/orders.e2e-spec.ts']);
        const run = await projection.get(req.runId);
        // Still published, never hidden.
        expect(run!.probes!.find((p) => p.probeId === 'orders-empty-cart')).toMatchObject({ verdict: 'finding', intent: 'intended' });
        expect(finalOnly(published).find((p) => p.kind === 'comment')!.report!.paths.find((p) => p.probeId === 'orders-empty-cart')!.intent).toBe('intended');
    });

    it('a test the PR changes keeps the regression', async () => {
        const { env } = envWithTests({ base: 0, pr: 0 });
        const { deps, projection } = inMemoryRunDeps({ env, turns: turnsWith([ORDERS_SPEC], '{"intent":"intended","testId":"orders-spec"}') });
        const base = shopRunRequest();
        const req = shopRunRequest({ diff: [...base.diff, { path: 'test/orders.e2e-spec.ts', patch: '@@ -1 +1 @@\n-it(400)\n+it(500)' }] });
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result).toMatchObject({ state: 'regression', conclusion: 'failure' });
        expect((await projection.get(req.runId))!.findings![0].intent).toBe('uncertain');
    });

    it('a pre-existing test that already failed on base keeps the regression', async () => {
        const { env } = envWithTests({ base: 1, pr: 0 });
        const { deps, projection } = inMemoryRunDeps({ env, turns: turnsWith([ORDERS_SPEC], '{"intent":"intended","testId":"orders-spec"}') });
        const req = shopRunRequest();
        await seed(projection, req);
        expect(await runRuntimeRun(req, deps)).toMatchObject({ state: 'regression', conclusion: 'failure' });
    });

    it('an LLM failure in the classifier leaves the finding uncertain and the Run finishes', async () => {
        const { deps, projection } = inMemoryRunDeps({ turns: [shopTurns[0], shopTurns[1]] as any });
        const req = shopRunRequest();
        await seed(projection, req);
        expect(await runRuntimeRun(req, deps)).toMatchObject({ state: 'regression', conclusion: 'failure' });
        expect((await projection.get(req.runId))!.findings![0].intent).toBe('uncertain');
    });

    it('the agent plan rejects tests outside the diff entry points or that do not run their own file', async () => {
        const { deps, projection, stream } = inMemoryRunDeps({
            turns: turnsWith(
                [
                    ORDERS_SPEC,
                    { ...ORDERS_SPEC, id: 'other', entryPoint: 'GET /checkout' },
                    { ...ORDERS_SPEC, id: 'mismatch', command: 'npx jest test/other.spec.ts' },
                    { ...ORDERS_SPEC, id: 'abs', path: '/etc/passwd', command: 'cat /etc/passwd' },
                ],
                '{"intent":"unintended"}',
            ),
        });
        const req = shopRunRequest();
        await seed(projection, req);
        await runRuntimeRun(req, deps);
        const verdict = (await stream.read(req.organizationId, req.runId))!.events.find((e) => e.type === 'verdict')!;
        expect(verdict.data).toMatchObject({ tests: 1, rejectedProbes: 4 });
    });
});

describe('a security violation the cell reports (halted)', () => {
    /** The fake environment, where the PR side's claim turns compromised once `when` returns true. */
    const compromisedPr = (when: (n: number) => boolean) => {
        const base = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const sides = new Map<string, 'base' | 'pr'>();
        let probes = 0;
        const env = Object.assign(Object.create(base), {
            acquire: async (a: any) => {
                const c: any = await base.acquire(a);
                if (c.claimId) sides.set(c.claimId, a.ref.side);
                return c;
            },
            probe: async (claimId: string, p: any, stepId: string) => {
                if (sides.get(claimId) === 'pr' && when(++probes)) return { code: 'security_violation', claimId, signature: 'credential_exfiltration' };
                return base.probe(claimId, p, stepId);
            },
        });
        return env;
    };

    it('halts outside the planning checkpoint after a browser security marker, including a serialized recovery with no new LLM or exploration', async () => {
        const req = shopRunRequest();
        let checkpoint: any;
        const make = async (recover = false) => {
            const h = inMemoryRunDeps(); await seed(h.projection, req);
            const acquire = h.deps.env.acquire.bind(h.deps.env);
            h.deps.env.acquire = async request => {
                const out = await acquire(request);
                return 'status' in out || request.ref.side !== 'base' ? out : { ...out, capabilities: { browserExplore: 'v1' } };
            };
            const explore = jest.fn(async () => ({ code: 'security_violation' as const, claimId: 'base', signature: 'credential_exfiltration' }));
            h.deps.env.exploreBrowser = explore;
            const planner = jest.fn(async () => ({ status: 'explore_browser' as const, request: { steps: [{ goto: '/' }], viewport: { width: 800, height: 600 }, timeoutMs: 1000 }, usage: { inputTokens: 1, outputTokens: 1 }, steps: 1 }));
            h.deps.agent = new RuntimeAgent({ complete: async () => { throw new Error('legacy LLM must not run'); } }, h.deps.env, { plan: planner });
            const probe = jest.spyOn(h.deps.env, 'probe');
            h.deps.step = async (name, fn) => {
                if (name !== 'agent:plan') return fn();
                if (recover) return JSON.parse(JSON.stringify(checkpoint));
                checkpoint = JSON.parse(JSON.stringify(await fn()));
                return checkpoint;
            };
            const result = await runRuntimeRun(req, h.deps);
            expect(result).toMatchObject({ state: 'halted', conclusion: 'failure' });
            expect((await h.projection.get(req.runId))!.securityEvent).toMatchObject({ kind: 'exfiltration', where: 'base', signature: 'credential_exfiltration' });
            expect(probe).not.toHaveBeenCalled();
            expect(planner).toHaveBeenCalledTimes(recover ? 0 : 1);
            expect(explore).toHaveBeenCalledTimes(recover ? 0 : 1);
            expect([...h.claims.claims.values()].every(c => c.released)).toBe(true);
        };
        await make();
        expect(checkpoint.securityViolation).toEqual({ side: 'base', signature: 'credential_exfiltration' });
        await make(true);
    });

    it('a probe on a compromised claim halts the Run as a failing check, with the side and the alert kind recorded', async () => {
        const h = inMemoryRunDeps({ env: compromisedPr(() => true) });
        const recorded = jest.spyOn(h.deps.metrics, 'recordSecurityEvent');
        const req = shopRunRequest();
        await seed(h.projection, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result).toMatchObject({ state: 'halted', conclusion: 'failure' });
        expect(result.title).toMatch(/^Security violation · /);
        const run = await h.projection.get(req.runId);
        expect(run!.securityEvent).toMatchObject({ kind: 'exfiltration', where: 'pr', signature: 'credential_exfiltration' });
        expect(recorded).toHaveBeenCalledWith({ orgId: req.organizationId, kind: 'exfiltration', where: 'pr' });
        const out = finalOnly(h.published);
        expect(out[0].check).toMatchObject({ conclusion: 'failure' });
        expect(out[1].report!.securityViolation).toEqual({ side: 'pr', signature: 'credential_exfiltration' });
        expect([...h.claims.claims.values()].every((c) => c.released)).toBe(true);
    });

    it('a violation the hub recorded between steps halts the Run too', async () => {
        const h = inMemoryRunDeps();
        const req = shopRunRequest();
        await seed(h.projection, req);
        const record = h.claims.record.bind(h.claims);
        h.claims.record = async (c) => {
            await record(c);
            if (c.side === 'base') h.claims.violations.push({ claimId: c.claimId, side: 'base', signature: 'bait_exfiltration' });
        };
        const result = await runRuntimeRun(req, h.deps);
        expect(result).toMatchObject({ state: 'halted', conclusion: 'failure' });
        expect((await h.projection.get(req.runId))!.securityEvent).toMatchObject({ kind: 'exfiltration', where: 'base', signature: 'bait_exfiltration' });
    });

    it('a claim compromised during the boot halts the Run instead of could_not_boot', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        env.acquire = async (a) =>
            a.ref.side === 'pr' ? { status: 'blocked', blockers: [{ kind: 'security_violation', signature: 'credential_exfiltration', message: 'x' }] } : acquire(a);
        const h = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(h.projection, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result).toMatchObject({ state: 'halted', conclusion: 'failure' });
        expect((await h.projection.get(req.runId))!.securityEvent).toMatchObject({ kind: 'exfiltration', where: 'pr' });
    });
});

describe('canaries (halted)', () => {
    const vault = new HmacCanaryVault();
    const everything = async (h: ReturnType<typeof inMemoryRunDeps>, runId: string, orgId: string) =>
        JSON.stringify({ published: h.published, run: await h.projection.get(runId), stream: await h.stream.read(orgId, runId) });
    const assertNoCanary = (text: string, req: ReturnType<typeof shopRunRequest>) => {
        for (const c of vault.forRun(req)) {
            expect(text).not.toContain(c.value);
            expect(text.toLowerCase()).not.toContain(c.core);
        }
    };

    it('a canary in the agent exec output never reaches the next prompt: halted with the computed verdict', async () => {
        const req = shopRunRequest();
        const [npm] = vault.forRun(req);
        const env = new FakeEnvironmentRuntime(
            { ...SCENARIOS, shop: { ...SCENARIOS.shop, exec: () => ({ stdout: `//registry.npmjs.org/:_authToken=${npm.value}\n` }) } },
            () => new Date(),
        );
        const h = inMemoryRunDeps({ env, canaries: vault });
        const sent = jest.spyOn(h.llm, 'complete');
        const recorded = jest.spyOn(h.deps.metrics, 'recordSecurityEvent');
        await seed(h.projection, req);

        const result = await runRuntimeRun(req, h.deps);

        // No probe ran: every entry point is unverified, so the computed verdict is partly_tested.
        expect(result).toMatchObject({ state: 'halted', verdictState: 'partly_tested', conclusion: 'neutral', title: 'Partly tested · security event' });
        expect(sent).toHaveBeenCalledTimes(1);
        const run = await h.projection.get(req.runId);
        expect(run).toMatchObject({ state: 'halted', verdictState: 'partly_tested', securityEvent: { kind: 'canary', where: 'llm_prompt' } });
        const events = (await h.stream.read(req.organizationId, req.runId))!.events;
        expect(events.filter((e) => e.type === 'state').map((e) => e.data.state)).toEqual(['booting', 'testing', 'halted']);
        expect(events.find((e) => e.type === 'security')!.data).toEqual({ kind: 'canary', where: 'llm_prompt' });
        expect(recorded).toHaveBeenCalledWith({ orgId: req.organizationId, kind: 'canary', where: 'llm_prompt' });
        // The check is never removed; the comment is the normal one plus the security event.
        const out = finalOnly(h.published);
        expect(out.map((p) => p.kind)).toEqual(['check', 'comment']);
        expect(out[0].check).toMatchObject({ conclusion: 'neutral', title: 'Partly tested · security event' });
        expect(out[1].report!.securityEvent).toBe(true);
        expect([...h.claims.claims.values()].every((c) => c.released)).toBe(true);
        assertNoCanary(await everything(h, req.runId, req.organizationId), req);
    });

    it('a canary in probe evidence stops the replay; the gate closes with the steps already recorded', async () => {
        const req = shopRunRequest();
        const [, cfg] = vault.forRun(req);
        const shop = SCENARIOS.shop;
        const env = new FakeEnvironmentRuntime(
            {
                ...SCENARIOS,
                shop: {
                    ...shop,
                    probes: {
                        ...shop.probes,
                        'orders-list': { ...shop.probes!['orders-list'], pr: () => ({ http: { status: 200, headers: {}, body: `{"items":[],"debug":"${cfg.value}"}` } }) },
                    },
                },
            },
            () => new Date(),
        );
        const h = inMemoryRunDeps({ env, canaries: vault });
        const sent = jest.spyOn(h.llm, 'complete');
        await seed(h.projection, req);

        const result = await runRuntimeRun(req, h.deps);

        // POST /orders already had its finding; GET /orders has no verdict.
        expect(result).toMatchObject({ state: 'halted', verdictState: 'regression', conclusion: 'failure', title: '1 regression · security event' });
        const run = await h.projection.get(req.runId);
        expect(run!.probes!.map((p) => [p.probeId, p.verdict])).toEqual([['orders-empty-cart', 'finding']]);
        expect(run!.uncoveredEntryPoints).toEqual(['GET /orders']);
        expect(run!.securityEvent!.where).toBe('probe_output');
        // No more LLM calls after the event: the intent classifier did not run.
        expect(sent.mock.calls.map(([r]) => r.task)).toEqual(['runtime.plan', 'runtime.plan']);
        expect(finalOnly(h.published)[1].report!.uncovered).toEqual([{ entryPoint: 'GET /orders', reason: 'not_reached' }]);
        assertNoCanary(await everything(h, req.runId, req.organizationId), req);
    });

    it('a canary in a blocked outbound host halts the Run after the replay', async () => {
        const req = shopRunRequest();
        const [, , seedRow] = vault.forRun(req);
        const h = inMemoryRunDeps({ canaries: vault });
        const record = h.claims.record.bind(h.claims);
        h.claims.record = async (c) => {
            await record(c);
            if (c.side === 'pr') h.claims.egress.push({ claimId: c.claimId, host: `${seedRow.core}.exfil.example.test`, port: 53, phase: 'test' });
        };
        await seed(h.projection, req);

        const result = await runRuntimeRun(req, h.deps);

        expect(result).toMatchObject({ state: 'halted', verdictState: 'regression', conclusion: 'failure' });
        expect(result.title).toBe('1 regression · 1 blocked outbound request · security event');
        expect((await h.projection.get(req.runId))!.securityEvent!.where).toBe('egress');
        assertNoCanary(await everything(h, req.runId, req.organizationId), req);
    });

    it('S-29/S-48: the canaries the cell planted, sent out by the PR, halt the Run end to end', async () => {
        const req = shopRunRequest();
        const h = inMemoryRunDeps({ canaries: vault });
        // The cell: it only knows what claim.acquire handed it, and the PR's code reads the
        // planted env var (the config slot) and sends it out as a name to resolve.
        const handed: Record<string, { slot: string; value: string }[] | undefined> = {};
        const acquire = h.deps.env.acquire.bind(h.deps.env);
        h.deps.env.acquire = async (r) => {
            handed[r.ref.side] = r.canaries;
            const claim = await acquire(r);
            const planted = r.canaries?.find((c) => c.slot === 'config');
            if (r.ref.side === 'pr' && planted && 'claimId' in claim) {
                h.claims.egress.push({ claimId: claim.claimId, host: `${planted.value.toLowerCase().replace(/_/g, '-')}.exfil.example.test`, port: 53, phase: 'test' });
            }
            return claim;
        };
        // What every durable step recorded: a DBOS checkpoint never holds a canary.
        const outputs: unknown[] = [];
        const step = h.deps.step;
        h.deps.step = async (name, fn) => {
            const out = await step(name, fn);
            outputs.push(out);
            return out;
        };
        await seed(h.projection, req);

        const result = await runRuntimeRun(req, h.deps);

        // Both sides got the Run's decoys, values only, one per slot.
        const expected = vault.forRun(req).map((c) => ({ slot: c.slot, value: c.value }));
        expect(handed.base).toEqual(expected);
        expect(handed.pr).toEqual(expected);
        expect(result).toMatchObject({ state: 'halted', conclusion: 'failure' });
        expect(result.title).toContain('security event');
        const run = await h.projection.get(req.runId);
        expect(run).toMatchObject({ state: 'halted', securityEvent: { kind: 'canary', where: 'egress' } });
        const events = (await h.stream.read(req.organizationId, req.runId))!.events;
        expect(events.find((e) => e.type === 'security')!.data).toEqual({ kind: 'canary', where: 'egress' });
        // What is published names the security event, never the decoy or the host that carried it.
        const out = finalOnly(h.published);
        expect(out.map((p) => p.kind)).toEqual(['check', 'comment']);
        expect(out[1].report!.securityEvent).toBe(true);
        assertNoCanary(await everything(h, req.runId, req.organizationId), req);
        assertNoCanary(JSON.stringify(outputs), req);
        expect([...h.claims.claims.values()].every((c) => c.released)).toBe(true);
    });

    it('a canary in a test run output halts the Run', async () => {
        const req = shopRunRequest();
        const [npm] = vault.forRun(req);
        const plan = JSON.parse(shopTurns[1].text);
        plan.tests = [{ id: 'orders-spec', path: 'test/orders.e2e-spec.ts', command: 'npx jest test/orders.e2e-spec.ts', entryPoint: 'POST /orders' }];
        const env = new FakeEnvironmentRuntime(
            { ...SCENARIOS, shop: { ...SCENARIOS.shop, exec: (cmd) => (cmd.includes('jest') ? { stdout: `token ${npm.value}` } : { stdout: '' }) } },
            () => new Date(),
        );
        const h = inMemoryRunDeps({ env, canaries: vault, turns: [shopTurns[0], { ...shopTurns[1], text: JSON.stringify(plan) }, shopTurns[2]] as any });
        await seed(h.projection, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result).toMatchObject({ state: 'halted', verdictState: 'regression', title: '1 regression · security event' });
        expect((await h.projection.get(req.runId))!.securityEvent!.where).toBe('exec_output');
        assertNoCanary(await everything(h, req.runId, req.organizationId), req);
    });

    it('a canary in what the comment is built from is redacted and halts the Run', async () => {
        const req = shopRunRequest();
        const [npm] = vault.forRun(req);
        const plan = JSON.parse(shopTurns[1].text);
        plan.probes[1].probe.id = `orders-list-${npm.core}`;
        const h = inMemoryRunDeps({ canaries: vault, turns: [shopTurns[0], { ...shopTurns[1], text: JSON.stringify(plan) }, shopTurns[2]] as any });
        await seed(h.projection, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result.state).toBe('halted');
        expect(result.title).toContain('security event');
        expect((await h.projection.get(req.runId))!.securityEvent!.where).toBe('publish');
        assertNoCanary(await everything(h, req.runId, req.organizationId), req);
    });
});

describe('fork PRs', () => {
    const forkReq = () => shopRunRequest({ pullRequest: { ...shopRunRequest().pullRequest, fork: true } });
    /** The gate (its own workflow, off the queue), then the Run it enqueues once approved. */
    const gateThenRun = async (deps: ReturnType<typeof inMemoryRunDeps>['deps'], req: ReturnType<typeof forkReq>, approvals: { has: () => Promise<boolean>; wait: () => Promise<{ headSha: string } | null> }) => {
        const gate = await awaitForkApproval(req, { ...deps, approvals });
        return 'approved' in gate ? runRuntimeRun(gate.approved, deps, { forkApproved: true, queuedAt: new Date().toISOString() }) : gate;
    };

    it('wait for a maintainer, then run on the approved head', async () => {
        const { deps, projection, stream } = inMemoryRunDeps();
        const req = forkReq();
        await seed(projection, req);
        const result = await gateThenRun(deps, req, { has: async () => false, wait: async () => ({ headSha: req.pullRequest.headSha }) });
        expect(result.state).toBe('regression');
        const states = (await stream.read(req.organizationId, req.runId))!.events.filter((e) => e.type === 'state').map((e) => e.data.state);
        expect(states.slice(0, 3)).toEqual(['awaiting_approval', 'queued', 'booting']);
    });

    it('publishes the waiting check under its own key, with a structured report, then the verdict under the final key', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = forkReq();
        await seed(projection, req);
        await gateThenRun(deps, req, { has: async () => false, wait: async () => ({ headSha: req.pullRequest.headSha }) });
        expect(finalOnly(published).map((p) => [p.kind, p.key])).toEqual([
            ['check', `${req.runId}:1:check:awaiting_approval`],
            ['check', `${req.runId}:1:check`],
            ['comment', `${req.runId}:1:comment`],
        ]);
        expect(published[0].check).toMatchObject({ status: 'completed', conclusion: 'action_required', title: 'Waiting for a maintainer' });
        expect(published[0].report).toBeDefined();
        expect(finalOnly(published)[1].check).toMatchObject({ status: 'completed', conclusion: 'failure' });
    });

    it('without an approval, the waiting check is followed by a cancelled check and no comment', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = forkReq();
        await seed(projection, req);
        const result = await gateThenRun(deps, req, { has: async () => false, wait: async () => null });
        expect(result).toMatchObject({ state: 'cancelled' });
        expect(published.map((p) => [p.kind, p.key, p.check?.conclusion])).toEqual([
            ['check', `${req.runId}:1:check:awaiting_approval`, 'action_required'],
            ['check', `${req.runId}:1:check`, 'cancelled'],
        ]);
    });

    it('an approval already recorded skips the waiting check', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = forkReq();
        await seed(projection, req);
        await gateThenRun(deps, req, { has: async () => true, wait: async () => null });
        expect(published.some((p) => p.key.endsWith(':awaiting_approval'))).toBe(false);
    });

    it('an approval for another head cancels the Run', async () => {
        const { deps, projection } = inMemoryRunDeps();
        const req = forkReq();
        await seed(projection, req);
        expect(await gateThenRun(deps, req, { has: async () => false, wait: async () => ({ headSha: 'e'.repeat(40) }) })).toMatchObject({ state: 'cancelled' });
    });

    it('fork code never boots when the Run is started without the gate', async () => {
        const { deps, projection, env } = inMemoryRunDeps();
        const acquire = jest.spyOn(env, 'acquire');
        const req = forkReq();
        await seed(projection, req);
        expect(await runRuntimeRun(req, deps)).toMatchObject({ state: 'cancelled' });
        expect(acquire).not.toHaveBeenCalled();
    });

    it("a fork the environment's policy runs at once (forkApprovalRequired false) boots without the gate", async () => {
        const { deps, projection, env } = inMemoryRunDeps();
        const acquire = jest.spyOn(env, 'acquire');
        const req = shopRunRequest({ pullRequest: { ...shopRunRequest().pullRequest, fork: true, forkApprovalRequired: false } });
        await seed(projection, req);
        expect((await runRuntimeRun(req, deps)).state).toBe('regression');
        expect(acquire).toHaveBeenCalled();
    });

    it('a forkApprovalRequired true is the same as absent: no boot without the gate', async () => {
        const { deps, projection, env } = inMemoryRunDeps();
        const acquire = jest.spyOn(env, 'acquire');
        const req = shopRunRequest({ pullRequest: { ...shopRunRequest().pullRequest, fork: true, forkApprovalRequired: true } });
        await seed(projection, req);
        expect(await runRuntimeRun(req, deps)).toMatchObject({ state: 'cancelled' });
        expect(acquire).not.toHaveBeenCalled();
    });

    it("the approval's fresh tokens replace the ones the Run was requested with", async () => {
        const { deps, projection } = inMemoryRunDeps();
        const req = forkReq();
        await seed(projection, req);
        const tokens = { repoToken: 'sealed:v1:fresh-repo', runToken: 'sealed:v1:fresh-run' };
        const gate = await awaitForkApproval(req, { ...deps, approvals: { has: async () => false, wait: async () => ({ headSha: req.pullRequest.headSha, tokens }) } });
        expect(gate).toEqual({ approved: { ...req, ...tokens } });
        // Without tokens in the approval, the request's own stay.
        const old = await awaitForkApproval(req, { ...deps, approvals: { has: async () => true, wait: async () => null } });
        expect(old).toEqual({ approved: req });
    });
});

describe('simulation on a past PR', () => {
    it('runs to a verdict and posts nothing: no progress comment, no check, no result', async () => {
        const { deps, projection, published } = inMemoryRunDeps();
        const req = shopRunRequest({ trigger: 'simulate' });
        await seed(projection, req);
        const result = await runRuntimeRun(req, deps);
        expect(result.state).toBe('regression');
        expect(published).toEqual([]);
        expect((await projection.get(req.runId))!.check).toMatchObject({ conclusion: 'failure' });
    });
});

it('passes the active durable-step cancellation signal to the planner', async () => {
    const h = inMemoryRunDeps(), req = shopRunRequest(), controller = new AbortController();
    await seed(h.projection, req);
    h.deps.cancellationSignal = () => controller.signal;
    const plan = jest.spyOn(h.deps.agent, 'plan');
    await runRuntimeRun(req, h.deps);
    expect(plan).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
});
