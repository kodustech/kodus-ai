import { parseHostPool } from '@libs/runtime/fleet/pool';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { InMemoryTemplateStore } from '../testing';
import type { TemplateFreshnessPolicy } from '../../shared/config';
import { TemplateRebuildPass } from './template-rebuild';
import { templateKeyOf } from '@libs/runtime/run/build-inputs';

const FP = 'c'.repeat(64);
const pool = parseHostPool({ kind: 'HostPool', name: 'boat-perrun', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'c', provider: 'boat', boat: { type: 'large' } } });
const record = (over: Partial<EnvironmentSetupRecord> = {}) => ({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'r', key: 'k', state: 'active', steps: [], blockers: [], refSource: 'default_branch', bakeRefsDigest: FP, ...over }) as EnvironmentSetupRecord;
const tpl = { organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP, name: 'n', cellBase: '' };

function world(recs: EnvironmentSetupRecord[], onPool = pool, liveSetupHosts?: () => Promise<Set<string> | null>, freshness?: TemplateFreshnessPolicy) {
    const templates = new InMemoryTemplateStore();
    const finished: EnvironmentSetupRecord[] = [];
    const opts: Array<{ refresh?: string } | undefined> = [];
    const locks = { withLock: async (_k: string, fn: () => Promise<any>) => fn(), tryWithLock: async (_k: string, fn: () => Promise<any>) => fn() };
    const pass = new TemplateRebuildPass(locks, {
        setups: { activeSince: async () => recs },
        templates,
        boatPools: async () => [{ poolId: 'p', pool: onPool }],
        liveSetupHosts,
        freshness,
        trigger: { onSetupFinished: async (r, o) => void (finished.push(r), opts.push(o)) },
        now: () => Date.now(),
    });
    return { templates, finished, opts, pass };
}

describe('the template rebuild pass', () => {
    it('builds a template when an environment finished its default-branch setup with a fingerprint no template holds', async () => {
        const w = world([record()]);
        await w.pass.tick();
        expect(w.finished).toHaveLength(1);
        expect(w.finished[0].environmentId).toBe('env-1');
    });
    it("leaves a template build's own setup alone", async () => {
        const w = world([record({ key: 'template:org-1/env-1:tpl-1' })]);
        await w.pass.tick();
        expect(w.finished).toEqual([]);
    });
    it('leaves a setup that is not on the default branch alone', async () => {
        const w = world([record({ refSource: 'dev_override' }), record({ environmentId: 'env-2', refSource: undefined })]);
        await w.pass.tick();
        expect(w.finished).toEqual([]);
    });
    it('builds nothing when a ready or building template already holds the fingerprint', async () => {
        const ready = world([record()]);
        await ready.templates.begin(tpl);
        await ready.templates.promote(tpl);
        await ready.pass.tick();
        const building = world([record()]);
        await building.templates.begin(tpl);
        await building.pass.tick();
        expect(ready.finished).toEqual([]);
        expect(building.finished).toEqual([]);
    });
    it('builds the template again when the pool moved to a new cell base: the ready one holds the old cell', async () => {
        const v10 = parseHostPool({ ...pool, hostClass: { ...pool.hostClass, boat: { type: 'large', base: 'kodus-cell-v10' } } } as any);
        const w = world([record()], v10);
        await w.templates.begin({ ...tpl, cellBase: 'kodus-cell-v9' });
        await w.templates.promote(tpl);
        await w.pass.tick();
        expect(w.finished).toHaveLength(1);
        const same = world([record()], v10);
        await same.templates.begin({ ...tpl, cellBase: 'kodus-cell-v10' });
        await same.templates.promote(tpl);
        await same.pass.tick();
        expect(same.finished).toEqual([]);
    });
    it('waits out the backoff after a failed build, then tries again', async () => {
        const w = world([record()]);
        await w.templates.begin(tpl);
        await w.templates.fail(tpl, 'x');
        await w.pass.tick();
        expect(w.finished).toEqual([]);
        w.templates.rows[0].failedAt = Date.now() - 31 * 60_000;
        await w.pass.tick();
        expect(w.finished).toHaveLength(1);
    });
    it('builds nothing for an org no boat pool admits', async () => {
        const admitted = parseHostPool({ ...pool, admission: { allowOrgs: ['org-other'] } } as any);
        const finished: EnvironmentSetupRecord[] = [];
        const pass = new TemplateRebuildPass({ withLock: async (_k, fn) => fn(), tryWithLock: async (_k, fn) => fn() }, {
            setups: { activeSince: async () => [record()] },
            templates: new InMemoryTemplateStore(),
            boatPools: async () => [{ poolId: 'p', pool: admitted }],
            trigger: { onSetupFinished: async (r) => void finished.push(r) },
            now: () => Date.now(),
        });
        await pass.tick();
        expect(finished).toEqual([]);
    });

    describe('the watchdog', () => {
        const aged = (w: ReturnType<typeof world>, ms: number) => void (w.templates.rows[0].touchedAt = Date.now() - ms);

        it('ends a building row whose setup host the provider does not list and builds it again in the same pass, with no failure backoff', async () => {
            const w = world([record()], pool, async () => new Set());
            await w.templates.begin({ ...tpl, setupHostId: 'tpl-dead' });
            aged(w, 90 * 60_000);
            await w.pass.tick();
            expect(w.templates.rows[0]).toMatchObject({ state: 'failed', failure: 'watchdog:setup_host_gone' });
            expect(w.finished).toHaveLength(1);
        });
        it('leaves a building row alone while its setup host is listed', async () => {
            const w = world([record()], pool, async () => new Set(['tpl-live']));
            await w.templates.begin({ ...tpl, setupHostId: 'tpl-live' });
            aged(w, 90 * 60_000);
            await w.pass.tick();
            expect(w.templates.rows[0].state).toBe('building');
            expect(w.finished).toEqual([]);
        });
        it('leaves a fresh building row alone even before its host exists', async () => {
            const w = world([record()], pool, async () => new Set());
            await w.templates.begin({ ...tpl, setupHostId: 'tpl-new' });
            await w.pass.tick();
            expect(w.templates.rows[0].state).toBe('building');
        });
        it('ends a building row past the ceiling even when the provider could not be asked', async () => {
            const w = world([record()], pool, async () => null);
            await w.templates.begin({ ...tpl, setupHostId: 'tpl-x' });
            aged(w, 3 * 3_600_000);
            await w.pass.tick();
            expect(w.templates.rows[0]).toMatchObject({ state: 'failed', failure: 'watchdog:build_timeout' });
        });
        it('retires a building row on the pool\'s former cell base and builds it again on the new one', async () => {
            const v30 = parseHostPool({ ...pool, hostClass: { ...pool.hostClass, boat: { type: 'large', base: 'kodus-cell-v30' } } } as any);
            const w = world([record()], v30, async () => new Set(['tpl-old']));
            await w.templates.begin({ ...tpl, cellBase: 'kodus-cell-v29', setupHostId: 'tpl-old' });
            await w.pass.tick();
            expect(w.templates.rows[0]).toMatchObject({ state: 'failed', failure: 'watchdog:cell_base_changed' });
            expect(w.finished).toHaveLength(1);
        });
        it('does not touch a building row of a pool this fleet does not control', async () => {
            const w = world([record()], pool, async () => new Set());
            await w.templates.begin({ ...tpl, poolId: 'other', setupHostId: 'tpl-z' });
            aged(w, 3 * 3_600_000);
            await w.pass.tick();
            expect(w.templates.rows[0].state).toBe('building');
        });
    });
});

// docs/runtime/host-providers.md §8.2.2: the template's key is the recipe and the build inputs, so main moving is not a rebuild.
describe('the template rebuild pass, keyed by build inputs', () => {
    const INPUTS_A = 'a'.repeat(64);
    const INPUTS_B = 'b'.repeat(64);
    const RECIPE = `sha256:${'d'.repeat(64)}`;
    const main = (sha: string, inputs = INPUTS_A, recipe = RECIPE) =>
        record({ bakeRefsDigest: undefined, imageId: 'latest', sha, buildInputsDigest: inputs, recipe: { path: '.kodus/workspace.yaml', sha, state: 'found', digest: recipe } });
    const keyA = templateKeyOf(RECIPE, INPUTS_A)!;
    const row = { ...tpl, fingerprint: keyA };
    const policy = { maxAgeDays: 14, maxMainCommits: 3 };
    const withReadyTemplate = async (recs: EnvironmentSetupRecord[], freshness = policy) => {
        const w = world(recs, pool, undefined, freshness);
        await w.templates.begin(row);
        await w.templates.promote(row, 'a'.repeat(40));
        return w;
    };

    it('keeps the template when a main push changed only app source: same recipe, same build inputs, another commit', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40))]);
        await w.pass.tick();
        expect(w.finished).toEqual([]);
    });
    it('builds a template when a main push changed a build input (the inputs digest differs)', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40), INPUTS_B)]);
        await w.pass.tick();
        expect(w.finished).toHaveLength(1);
        expect(w.opts).toEqual([undefined]);
    });
    it('builds a template when the recipe changed with the same build inputs', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40), INPUTS_A, `sha256:${'e'.repeat(64)}`)]);
        await w.pass.tick();
        expect(w.finished).toHaveLength(1);
    });
    it('rebuilds a ready template older than the age bound although its key is unchanged, saying why', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40))]);
        w.templates.ageMs = 14 * 86_400_000;
        await w.pass.tick();
        expect(w.opts).toEqual([{ refresh: 'max_age' }]);
    });
    it('does not rebuild a template one millisecond short of the age bound', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40))]);
        w.templates.ageMs = 14 * 86_400_000 - 1;
        await w.pass.tick();
        expect(w.finished).toEqual([]);
    });
    it('counts each distinct main commit once and rebuilds when the template is the bound behind main', async () => {
        const w = await withReadyTemplate([main('1'.repeat(40))]);
        await w.pass.tick();
        await w.pass.tick();
        expect(w.templates.rows[0].behind).toBe(1);
        for (const sha of ['2', '3']) {
            w.finished.length = 0;
            (w.pass as any).d.setups = { activeSince: async () => [main(sha.repeat(40))] };
            await w.pass.tick();
        }
        expect(w.templates.rows[0].behind).toBe(3);
        (w.pass as any).d.setups = { activeSince: async () => [main('3'.repeat(40))] };
        await w.pass.tick();
        expect(w.opts.at(-1)).toEqual({ refresh: 'max_main_commits' });
    });
    it('does not count the commit the template was built at as behind', async () => {
        const w = await withReadyTemplate([main('a'.repeat(40))]);
        await w.pass.tick();
        expect(w.templates.rows[0].behind).toBe(0);
    });
    it('does not start a second freshness rebuild while one is building, nor right after one failed', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40))]);
        w.templates.ageMs = 15 * 86_400_000;
        await w.templates.begin({ ...row, fingerprint: 'f'.repeat(64), inputKey: keyA, name: 'refresh-1' });
        await w.pass.tick();
        expect(w.finished).toEqual([]);
        await w.templates.fail({ ...row, fingerprint: 'f'.repeat(64) }, 'save_failed');
        await w.pass.tick();
        expect(w.finished).toEqual([]);
        w.templates.rows.find((r) => r.fingerprint === 'f'.repeat(64))!.failedAt = Date.now() - 31 * 60_000;
        await w.pass.tick();
        expect(w.opts).toEqual([{ refresh: 'max_age' }]);
    });
    it('never rebuilds for freshness when both bounds are 0', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40))], { maxAgeDays: 0, maxMainCommits: 0 });
        w.templates.ageMs = 3650 * 86_400_000;
        w.templates.rows[0].behind = 100_000;
        await w.pass.tick();
        expect(w.finished).toEqual([]);
    });
    it('holds the key while a freshness rebuild of it has replaced the original ready row', async () => {
        const w = await withReadyTemplate([main('b'.repeat(40))]);
        const refreshed = { ...row, fingerprint: 'f'.repeat(64), inputKey: keyA, name: 'refresh-1' };
        await w.templates.begin(refreshed);
        await w.templates.promote(refreshed, 'b'.repeat(40));
        await w.pass.tick();
        expect(w.finished).toEqual([]);
        expect(await w.templates.readyName('org-1', 'env-1', 'p', '')).toBe('refresh-1');
    });
});
