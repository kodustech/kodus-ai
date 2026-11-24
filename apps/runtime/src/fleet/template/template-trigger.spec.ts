import { parseHostPool } from '@libs/runtime/fleet/pool';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { InMemoryTemplateStore } from '../testing';
import { RequestingSetupHost, TemplateBuildTrigger, TriggeringTemplateResolver } from './template-trigger';

const FP = 'c'.repeat(64);
const pool = parseHostPool({ kind: 'HostPool', name: 'boat-perrun', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'c', provider: 'boat', boat: { type: 'large' } } });
const record = (over: Partial<EnvironmentSetupRecord> = {}) => ({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'r', key: 'k', state: 'active', steps: [], blockers: [], refSource: 'default_branch', bakeRefsDigest: FP, ...over }) as EnvironmentSetupRecord;
const demand = { organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', provider: 'boat' };

function world(rec: EnvironmentSetupRecord | null = record()) {
    const store = new InMemoryTemplateStore();
    const builds: any[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const trigger = new TemplateBuildTrigger({
        store,
        setups: { get: async () => rec },
        poolOf: async (poolId) => ({ poolId, pool }),
        boatPoolsOf: async () => [{ poolId: 'p', pool }],
        build: async (req) => {
            builds.push(req);
            await gate;
            return { ok: true, name: 'n', reused: false };
        },
    });
    return { store, builds, trigger, release };
}

// docs/runtime/e2e-suites.md section 2.1: when a template turns ready, the environment's main commit gets a baseline
// suite run. The fleet only records the request (it holds no repository credentials); the product issues the command.
describe('when a template turns ready', () => {
    const recipeOf = (suite: string): Partial<EnvironmentSetupRecord> => ({ recipe: { path: '.kodus/workspace.yaml', sha: 'd'.repeat(40), state: 'found', content: `version: 1\n${suite}` } });
    const SUITE = 'suite:\n  runner: cypress\n  command: npx cypress run --spec "{specs}"\n  specs: "cypress/e2e/**/*.cy.ts"\n';
    const withSuite = (over: Partial<EnvironmentSetupRecord> = {}) => record({ sha: 'd'.repeat(40), repositoryId: 'repo-9', ...recipeOf(SUITE), ...over });
    function readyWorld(result: { ok: true; name: string; reused: boolean } | { ok: false; reason: 'bake_failed' }, rec: EnvironmentSetupRecord = withSuite()) {
        const asked: any[] = [];
        let fail = false;
        const logs: string[] = [];
        const trigger = new TemplateBuildTrigger({
            store: new InMemoryTemplateStore(),
            setups: { get: async () => rec },
            poolOf: async (poolId) => ({ poolId, pool }),
            boatPoolsOf: async () => [{ poolId: 'p', pool }],
            build: async () => result as any,
            baselines: { request: async (r) => (fail ? Promise.reject(new Error('db down')) : void asked.push(r)) },
            log: (m) => void logs.push(m),
        });
        return { asked, trigger, logs, breakStore: () => (fail = true) };
    }
    const settle = () => new Promise((r) => setImmediate(r));

    it("asks for a baseline of the environment's main commit, of the fingerprint the template holds", async () => {
        const w = readyWorld({ ok: true, name: 'n', reused: false });
        await w.trigger.onSetupFinished(withSuite());
        await settle();
        expect(w.asked).toEqual([{ organizationId: 'org-1', environmentId: 'env-1', repositoryId: 'repo-9', mainSha: 'd'.repeat(40), fingerprint: FP }]);
    });

    it('asks for nothing when the template was already there, or the build failed', async () => {
        const reused = readyWorld({ ok: true, name: 'n', reused: true });
        await reused.trigger.onSetupFinished(record());
        const failed = readyWorld({ ok: false, reason: 'bake_failed' });
        await failed.trigger.onSetupFinished(record());
        await settle();
        expect([...reused.asked, ...failed.asked]).toEqual([]);
    });

    it('never lets a request that could not be recorded undo the template, and says so', async () => {
        const w = readyWorld({ ok: true, name: 'n', reused: false });
        w.breakStore();
        await w.trigger.onSetupFinished(withSuite());
        await settle();
        expect(w.logs).toContain('template.baseline_request_failed');
    });

    it('asks for nothing when the setup does not name the main commit', async () => {
        const w = readyWorld({ ok: true, name: 'n', reused: false }, withSuite({ sha: undefined }));
        await w.trigger.onSetupFinished(withSuite());
        await settle();
        expect(w.asked).toEqual([]);
    });

    it('asks for nothing for an environment whose recipe declares no suite, or one that turned its baseline off', async () => {
        const none = readyWorld({ ok: true, name: 'n', reused: false }, withSuite({ recipe: { path: 'p', sha: 'd'.repeat(40), state: 'found', content: 'version: 1\n' } }));
        await none.trigger.onSetupFinished(withSuite());
        const off = readyWorld({ ok: true, name: 'n', reused: false }, withSuite(recipeOf(`${SUITE}  baseline: false\n`)));
        await off.trigger.onSetupFinished(withSuite());
        const broken = readyWorld({ ok: true, name: 'n', reused: false }, withSuite(recipeOf('suite: {')));
        await broken.trigger.onSetupFinished(withSuite());
        await settle();
        expect([...none.asked, ...off.asked, ...broken.asked]).toEqual([]);
    });
});

describe('when an environment template is built', () => {
    it('starts one build, without waiting for it, when a Run has demand and the environment has no ready template', async () => {
        const w = world();
        await w.trigger.onDemand(demand);
        expect(w.builds).toEqual([expect.objectContaining({ organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP })]);
        w.release();
    });
    it('starts at most one build per environment at a time', async () => {
        const w = world();
        await w.trigger.onDemand(demand);
        await w.trigger.onDemand(demand);
        await w.trigger.onSetupFinished(record());
        expect(w.builds).toHaveLength(1);
        w.release();
    });
    it('builds nothing when the template is ready, the environment is unknown, or the setup is not an active default-branch one', async () => {
        const ready = world();
        await ready.store.begin({ organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP, name: 'n' });
        await ready.store.promote({ organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP });
        await ready.trigger.onDemand(demand);
        await ready.trigger.onSetupFinished(record());
        await world().trigger.onDemand({ ...demand, environmentId: null });
        const blocked = world(record({ state: 'blocked' }));
        await blocked.trigger.onDemand(demand);
        const override = world(record({ refSource: 'dev_override' }));
        await override.trigger.onSetupFinished(record({ refSource: 'dev_override' }));
        expect([ready.builds, blocked.builds, override.builds].flat()).toEqual([]);
    });
    it('starts a build when an environment setup finishes on the default branch with a fingerprint no template holds', async () => {
        const w = world();
        await w.trigger.onSetupFinished(record());
        expect(w.builds).toHaveLength(1);
        w.release();
    });
    it('lets the Run boot from the cell base while the build starts, and never throws into it', async () => {
        const w = world();
        const resolver = new TriggeringTemplateResolver({ resolve: async () => null }, w.trigger);
        expect(await resolver.resolve(demand)).toBeNull();
        await new Promise((r) => setImmediate(r));
        expect(w.builds).toHaveLength(1);
        w.release();
    });
    it('asks the setup request path for the environment bound to its template once the setup host is booted', async () => {
        const calls: string[] = [];
        const host = new RequestingSetupHost(
            { boot: async () => (calls.push('boot'), { providerId: 'pid' }), waitForBake: async () => ({ ok: false, reason: 'x' }), seal: async () => undefined, destroy: async () => undefined },
            { request: async (r) => void calls.push(`${r.boundKey}|${r.key}`) },
        );
        await host.boot({ hostId: 'tpl-1', organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP, base: 'b' });
        expect(calls).toEqual(['boot', 'template:org-1/env-1|template:org-1/env-1:tpl-1']);
    });
});
