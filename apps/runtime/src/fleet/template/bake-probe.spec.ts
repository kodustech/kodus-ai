import type { EnvironmentSetupRecord } from '@libs/runtime/run';

import { bakeFingerprintOf, SetupRecordBakeProbe, templateSetupCommandKey } from './bake-probe';

const FP = 'b'.repeat(64);
const req = { hostId: 'tpl-x', organizationId: 'org-1', environmentId: 'env-1' };
const rec = (over: Partial<EnvironmentSetupRecord>) => ({ environmentId: 'env-1', organizationId: 'org-1', repositoryId: 'r', key: templateSetupCommandKey('org-1', 'env-1', 'tpl-x'), state: 'active', steps: [], blockers: [], refSource: 'default_branch', bakeRefsDigest: FP, ...over }) as EnvironmentSetupRecord;
// A store of template setup records, read by the exact key (runtime.runtime_template_setups).
const probe = (...rs: Array<EnvironmentSetupRecord | null>) => new SetupRecordBakeProbe({ get: async (key) => rs.find((r) => r?.key === key) ?? null });

describe('reading how the template host\'s setup ended (setup record)', () => {
    it('is running while there is no record for this host, or it is still setting up', async () => {
        expect(await probe(null).read(req)).toEqual({ state: 'running' });
        expect(await probe(rec({ key: 'ordinary-key' })).read(req)).toEqual({ state: 'running' });
        expect(await probe(rec({ state: 'setting_up' })).read(req)).toEqual({ state: 'running' });
    });
    it("is running while the record is an earlier attempt's template setup: only this host's own setup counts", async () => {
        expect(await probe(rec({ key: templateSetupCommandKey('org-1', 'env-1', 'tpl-earlier') })).read(req)).toEqual({ state: 'running' });
        expect(await probe(rec({ key: templateSetupCommandKey('org-1', 'env-1', 'tpl-earlier'), state: 'blocked' })).read(req)).toEqual({ state: 'running' });
    });
    it('is done with the fingerprint and the default branch when the template setup is active', async () => {
        expect(await probe(rec({ cellId: 'cell-tpl' })).read(req)).toEqual({ state: 'done', fingerprint: FP, ref: 'default_branch', cellId: 'cell-tpl' });
    });
    it('reports another ref when the setup did not boot the default branch', async () => {
        expect(await probe(rec({ refSource: 'dev_override' })).read(req)).toMatchObject({ state: 'done', ref: 'other' });
    });
    it('is failed when the setup is blocked, or active with no fingerprint', async () => {
        expect(await probe(rec({ state: 'blocked' })).read(req)).toEqual({ state: 'failed', reason: 'bake_failed' });
        expect(await probe(rec({ bakeRefsDigest: undefined, imageId: undefined })).read(req)).toEqual({ state: 'failed', reason: 'bake_failed' });
    });
    it('names the fingerprint as bare hex when the setup recorded a sha256: digest, and has none for a tag like latest', () => {
        expect(bakeFingerprintOf({ bakeRefsDigest: `sha256:${FP}`, imageId: 'latest' })).toBe(FP);
        expect(bakeFingerprintOf({ bakeRefsDigest: undefined, imageId: 'latest' })).toBeNull();
        expect(bakeFingerprintOf({ bakeRefsDigest: undefined, imageId: `sha256:${'c'.repeat(64)}` })).toBe('c'.repeat(64));
    });
    it('is done with the bare hex fingerprint when the template setup recorded a sha256: digest', async () => {
        expect(await probe(rec({ bakeRefsDigest: `sha256:${FP}` })).read(req)).toEqual({ state: 'done', fingerprint: FP, ref: 'default_branch' });
    });
    it("ignores another org's record", async () => {
        expect(await probe(rec({ organizationId: 'org-2' })).read(req)).toEqual({ state: 'running' });
    });
});
