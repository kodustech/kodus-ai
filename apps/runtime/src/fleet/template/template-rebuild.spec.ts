import { parseHostPool } from '@libs/runtime/fleet/pool';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { InMemoryTemplateStore } from '../testing';
import { TemplateRebuildPass } from './template-rebuild';

const FP = 'c'.repeat(64);
const pool = parseHostPool({ kind: 'HostPool', name: 'boat-perrun', scope: 'kodus', provider: 'boat', lifecycle: 'perRun', hostClass: { kind: 'HostClass', name: 'c', provider: 'boat', boat: { type: 'large' } } });
const record = (over: Partial<EnvironmentSetupRecord> = {}) => ({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'r', key: 'k', state: 'active', steps: [], blockers: [], refSource: 'default_branch', bakeRefsDigest: FP, ...over }) as EnvironmentSetupRecord;
const tpl = { organizationId: 'org-1', environmentId: 'env-1', poolId: 'p', fingerprint: FP, name: 'n' };

function world(recs: EnvironmentSetupRecord[]) {
    const templates = new InMemoryTemplateStore();
    const finished: EnvironmentSetupRecord[] = [];
    const locks = { withLock: async (_k: string, fn: () => Promise<any>) => fn(), tryWithLock: async (_k: string, fn: () => Promise<any>) => fn() };
    const pass = new TemplateRebuildPass(locks, {
        setups: { activeSince: async () => recs },
        templates,
        boatPools: async () => [{ poolId: 'p', pool }],
        trigger: { onSetupFinished: async (r) => void finished.push(r) },
        now: () => Date.now(),
    });
    return { templates, finished, pass };
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
});
