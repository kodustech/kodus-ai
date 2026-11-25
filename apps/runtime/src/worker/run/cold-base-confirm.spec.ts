import { type AcquireRequest, type Blocked, FakeEnvironmentRuntime } from '@libs/runtime/environment';

import { shopRunRequest } from '../../e2e/fixtures';
import { SCENARIOS } from '../../fake-cell/scenarios';
import { runRuntimeRun } from './run-orchestrator';
import { inMemoryRunDeps } from './testing';

// A base that booted from the bake never ran the build the PR failed, so "the PR does not boot while the base does" is not
// yet a fair comparison. Before the Run publishes a regression it boots a base built cold (claim.acquire skipBake): a base
// that fails too is not the PR's fault; one that boots leaves the regression as it was. The PR's own log decides nothing.

const APT_SEGFAULT = 'compose up: exit 1\n#9 RUN apt-get install -y ca-certificates\n#9 ERROR: process "/bin/sh -c apt-get install -y ca-certificates" did not complete successfully: exit code: 139';
const prBlocked: Blocked = { status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'compose_up', message: APT_SEGFAULT }] };

const seed = async (projection: any, req: ReturnType<typeof shopRunRequest>) =>
    projection.upsert(req.runId, { attempt: req.attempt, correlationId: req.correlationId, organizationId: req.organizationId, teamId: req.teamId, repositoryId: req.repository.id, repositoryName: req.repository.name, prNumber: req.pullRequest.number, headSha: req.pullRequest.headSha, baseSha: req.pullRequest.baseSha, environmentId: req.environment.environmentId, imageId: req.environment.imageId, state: 'queued', requestedAt: req.requestedAt });

/** The PR side fails its build; the base boots (from the bake, a concrete image) and the cold base answers `cold`. */
function fixture(cold: (r: AcquireRequest) => Blocked | undefined, opts: { baseImageId?: string } = {}) {
    const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
    const acquire = env.acquire.bind(env);
    const asked: AcquireRequest[] = [];
    const coldClaims: string[] = [];
    env.acquire = async (r) => {
        asked.push(r);
        if (r.skipBake) {
            const out = cold(r) ?? (await acquire(r));
            if (!('status' in out)) coldClaims.push(out.claimId);
            return out;
        }
        if (r.ref.side === 'pr') return prBlocked;
        const claim = await acquire(r);
        return opts.baseImageId && 'manifest' in claim ? { ...claim, manifest: { ...claim.manifest, imageId: opts.baseImageId } } : claim;
    };
    const released: string[] = [];
    const release = env.release.bind(env);
    env.release = async (id) => {
        released.push(id);
        return release(id);
    };
    const h = inMemoryRunDeps({ env });
    return { ...h, asked, coldClaims, released };
}

describe('a PR boot failure confirmed against a base built cold', () => {
    it('is not the PR\'s when the cold base fails to boot too: partly tested, no finding, every path untested, the cold claim given back', async () => {
        const h = fixture(() => ({ status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'compose_up', message: APT_SEGFAULT }] }));
        const req = shopRunRequest();
        await seed(h.projection, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result.state).toBe('partly_tested');
        const run = (await h.projection.get(req.runId))!;
        expect(run.findings ?? []).toEqual([]);
        expect(run.reason).toBe('the base fails to build here too; not attributed to the PR');
        expect(run.uncovered!.length).toBeGreaterThan(0);
        expect(run.uncovered!.every((u) => u.reason === 'blocker')).toBe(true);
        const cold = h.asked.filter((r) => r.skipBake);
        expect(cold).toHaveLength(1);
        expect(cold[0]).toMatchObject({ skipBake: true, ref: { side: 'base' }, consumer: 'runtime' });
        expect(cold[0].idempotencyKey).toBe(`${req.runId}:base:${req.attempt}:cold`);
    });

    it('stands as a regression when the cold base boots, and the cold claim is given back', async () => {
        const h = fixture(() => undefined);
        const req = shopRunRequest();
        await seed(h.projection, req);
        const result = await runRuntimeRun(req, h.deps);
        expect(result).toMatchObject({ state: 'regression', conclusion: 'failure' });
        expect((await h.projection.get(req.runId))!.findings![0]).toMatchObject({ entryPoint: 'boot', findingKind: 'pr_destabilizes_machine' });
        expect(h.asked.filter((r) => r.skipBake)).toHaveLength(1);
        expect(h.coldClaims).toHaveLength(1);
        expect(h.released).toContain(h.coldClaims[0]);
        expect(await h.claims.forRun(req.organizationId, req.runId)).toEqual([]);
    });

    it.each([
        ['a cell that cannot build without its bake', 'skip_bake_unsupported'],
        ['a cell lost while it built', 'cell_lost'],
    ])('stands as a regression when the cold base could not be tried: %s', async (_label, signature) => {
        const h = fixture(() => ({ status: 'blocked', blockers: [{ kind: 'platform', signature, message: 'x' }] }));
        const req = shopRunRequest();
        await seed(h.projection, req);
        expect((await runRuntimeRun(req, h.deps)).state).toBe('regression');
    });

    it('stands as a regression when the cold acquire throws', async () => {
        const h = fixture(() => {
            throw new Error('hub unreachable');
        });
        const req = shopRunRequest();
        await seed(h.projection, req);
        expect((await runRuntimeRun(req, h.deps)).state).toBe('regression');
    });

    it('asks nothing of a base that was already built cold: its boot is the fair comparison', async () => {
        const h = fixture(() => ({ status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'x' }] }), { baseImageId: 'latest' });
        const req = shopRunRequest();
        await seed(h.projection, req);
        expect((await runRuntimeRun(req, h.deps)).state).toBe('regression');
        expect(h.asked.filter((r) => r.skipBake)).toHaveLength(0);
    });

    it('asks nothing when the egress proxy denied the PR a host: that stays the approve-host card', async () => {
        const h = fixture(() => ({ status: 'blocked', blockers: [{ kind: 'toolchain', signature: 'compose_up', message: 'x' }] }));
        const req = shopRunRequest({ organizationId: 'org-1' });
        await seed(h.projection, req);
        h.claims.egress.push({ claimId: 'pr-claim', organizationId: 'org-1', runId: req.runId, side: 'pr', host: 'api.vendor.test', port: 443, phase: 'build' });
        const result = await runRuntimeRun(req, h.deps);
        expect(result).toMatchObject({ state: 'partly_tested', conclusion: 'action_required' });
        expect(h.asked.filter((r) => r.skipBake)).toHaveLength(0);
    });

    it('asks nothing for a boot failure the cell itself declared: that was never the PR\'s', async () => {
        const env = new FakeEnvironmentRuntime(SCENARIOS, () => new Date());
        const acquire = env.acquire.bind(env);
        const asked: AcquireRequest[] = [];
        env.acquire = async (r) => {
            asked.push(r);
            return r.ref.side === 'pr' ? { status: 'blocked', blockers: [{ kind: 'platform', signature: 'builder_failed', message: 'x' }] } : acquire(r);
        };
        const h = inMemoryRunDeps({ env });
        const req = shopRunRequest();
        await seed(h.projection, req);
        expect((await runRuntimeRun(req, h.deps)).state).toBe('partly_tested');
        expect(asked.filter((r) => r.skipBake)).toHaveLength(0);
    });
});
