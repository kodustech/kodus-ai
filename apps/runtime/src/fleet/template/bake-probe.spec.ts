import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { SetupRecordBakeProbe, templateSetupCommandKey } from './bake-probe';

const FP = 'b'.repeat(64);
const req = { hostId: 'tpl-x', organizationId: 'org-1', environmentId: 'env-1' };
const rec = (over: Partial<EnvironmentSetupRecord>) => ({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'r', key: templateSetupCommandKey('org-1', 'env-1', FP), state: 'active', steps: [], blockers: [], refSource: 'default_branch', bakeRefsDigest: FP, ...over }) as EnvironmentSetupRecord;
const probe = (r: EnvironmentSetupRecord | null) => new SetupRecordBakeProbe({ get: async () => r });

describe('reading how the template host\'s setup ended (setup record)', () => {
    it('is running while there is no record, or the record is an ordinary setup, or it is still setting up', async () => {
        expect(await probe(null).read(req)).toEqual({ state: 'running' });
        expect(await probe(rec({ key: 'ordinary-key' })).read(req)).toEqual({ state: 'running' });
        expect(await probe(rec({ state: 'setting_up' })).read(req)).toEqual({ state: 'running' });
    });
    it('is done with the fingerprint and the default branch when the template setup is active', async () => {
        expect(await probe(rec({})).read(req)).toEqual({ state: 'done', fingerprint: FP, ref: 'default_branch' });
    });
    it('reports another ref when the setup did not boot the default branch', async () => {
        expect(await probe(rec({ refSource: 'dev_override' })).read(req)).toMatchObject({ state: 'done', ref: 'other' });
    });
    it('is failed when the setup is blocked, or active with no fingerprint', async () => {
        expect(await probe(rec({ state: 'blocked' })).read(req)).toEqual({ state: 'failed', reason: 'bake_failed' });
        expect(await probe(rec({ bakeRefsDigest: undefined, imageId: undefined })).read(req)).toEqual({ state: 'failed', reason: 'bake_failed' });
    });
    it("ignores another org's record", async () => {
        expect(await probe(rec({ organizationId: 'org-2' })).read(req)).toEqual({ state: 'running' });
    });
});
