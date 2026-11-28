import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';
import type { EnvironmentSetupRecord } from '@libs/runtime/run';
import type { EnvironmentRuntime } from '@libs/runtime/environment';

import { capacityBlocked } from '../env/hub-environment-runtime';
import { EnvironmentSetupService } from './environment-setup.service';
import { TemplateRoutingSetupStore, type TemplateSetupRecords } from './template-routing-setup.store';
import { InMemoryEnvironmentSetupStore } from './testing';

const TEMPLATE_KEY = 'template:org-1/env-1:tpl-host';
const cmd = (key: string): RuntimeEnvironmentSetupRequested => ({
    environmentId: 'env-1', organizationId: 'org-1', teamId: 'team-1', repositoryId: 'repo-1', repositoryName: 'shop',
    requestedBy: { userId: 'user-1' }, requestedAt: '2026-11-07T12:00:00Z', key, boundKey: 'template:org-1/env-1', ref: { sha: 'c'.repeat(40), branch: 'main' },
} as RuntimeEnvironmentSetupRequested);
// The host's cell never connects: the setup ends blocked.
const neverConnects = (): EnvironmentRuntime => ({ acquire: jest.fn(async () => capacityBlocked({ refused: 'no_capacity' })), probe: jest.fn(), exec: jest.fn(), reset: jest.fn(), release: jest.fn() });

class MemoryTemplateRecords implements TemplateSetupRecords {
    readonly byKey = new Map<string, EnvironmentSetupRecord>();
    async get(key: string) { return this.byKey.get(key) ?? null; }
    async save(r: EnvironmentSetupRecord) { this.byKey.set(r.key, JSON.parse(JSON.stringify(r))); }
    async saveProgress() {}
}

const activeOwn = { environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'repo-1', key: 'own-setup', state: 'active', steps: [], blockers: [], imageId: 'img-live', requestedAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' } as EnvironmentSetupRecord;

describe('a template build\'s setup record', () => {
    const setup = async () => {
        const own = new InMemoryEnvironmentSetupStore();
        await own.save(activeOwn);
        const templates = new MemoryTemplateRecords();
        return { own, templates, store: new TemplateRoutingSetupStore(own, templates) };
    };

    it('is kept in the template store and leaves the environment\'s active record as it was when the setup blocks', async () => {
        const { own, templates, store } = await setup();
        const service = new EnvironmentSetupService({ envForSetup: () => neverConnects() }, store, { capacityWaitMs: 0 });

        const result = await service.run(cmd(TEMPLATE_KEY));

        expect(result.state).toBe('blocked');
        expect(templates.byKey.get(TEMPLATE_KEY)?.state).toBe('blocked');
        expect(await own.get('env-1')).toEqual(activeOwn);
        expect(own.saved).toHaveLength(1);
    });

    it('is kept in the template store when the setup succeeds, and the environment\'s record is still untouched', async () => {
        const { own, templates, store } = await setup();
        await store.save({ ...activeOwn, key: TEMPLATE_KEY, state: 'active' });
        expect(templates.byKey.get(TEMPLATE_KEY)?.state).toBe('active');
        expect(await own.get('env-1')).toEqual(activeOwn);
    });

    it('is not rerun when its command is delivered again after it ended', async () => {
        const { templates, store } = await setup();
        const done = { ...activeOwn, key: TEMPLATE_KEY, state: 'blocked' } as EnvironmentSetupRecord;
        templates.byKey.set(TEMPLATE_KEY, done);
        const envForSetup = jest.fn(() => neverConnects());

        expect(await new EnvironmentSetupService({ envForSetup }, store).run(cmd(TEMPLATE_KEY))).toEqual(done);
        expect(envForSetup).not.toHaveBeenCalled();
    });

    it('is not the route of an ordinary setup, a Run\'s key or another org\'s template key', async () => {
        const { own, templates, store } = await setup();
        for (const key of ['ordinary', 'template:org-2/env-1:tpl', 'template:org-1/']) await store.save({ ...activeOwn, key, state: 'blocked' });
        expect(templates.byKey.size).toBe(0);
        expect(own.saved).toHaveLength(4);
    });
});
