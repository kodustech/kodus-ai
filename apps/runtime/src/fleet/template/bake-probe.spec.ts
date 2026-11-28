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
    // kr-mono on dev: an environment of one repository records no refs digest and the image tag `latest`, so it had no
    // fingerprint and never got a template.
    it('names the bake of a setup of one repository by its commit and recipe', () => {
        const one = { bakeRefsDigest: undefined, imageId: 'latest', sha: 'a'.repeat(40), recipe: { path: '.kodus/workspace.yaml', sha: 'a'.repeat(40), state: 'found', digest: `sha256:${'d'.repeat(64)}` } } as const;
        const fp = bakeFingerprintOf(one);
        expect(fp).toMatch(/^[0-9a-f]{64}$/);
        // The same commit and recipe, the same bake; another commit or recipe, another one.
        expect(bakeFingerprintOf({ ...one })).toBe(fp);
        expect(bakeFingerprintOf({ ...one, sha: 'b'.repeat(40) })).not.toBe(fp);
        expect(bakeFingerprintOf({ ...one, recipe: { ...one.recipe, digest: `sha256:${'e'.repeat(64)}` } })).not.toBe(fp);
        // Not baked (no image id): no fingerprint.
        expect(bakeFingerprintOf({ ...one, imageId: undefined })).toBeNull();
    });
    it('is done with the bare hex fingerprint when the template setup recorded a sha256: digest', async () => {
        expect(await probe(rec({ bakeRefsDigest: `sha256:${FP}` })).read(req)).toEqual({ state: 'done', fingerprint: FP, ref: 'default_branch' });
    });
    it("ignores another org's record", async () => {
        expect(await probe(rec({ organizationId: 'org-2' })).read(req)).toEqual({ state: 'running' });
    });
});

// docs/runtime/host-providers.md §8.2.2: the key of a setup of one repository is its recipe and its build inputs, not its commit.
describe('the template key of a setup of one repository', () => {
    const recipe = (digest: string) => ({ path: '.kodus/workspace.yaml', sha: 'a'.repeat(40), state: 'found', digest }) as const;
    const R = `sha256:${'d'.repeat(64)}`;
    const I = 'e'.repeat(64);
    const one = { bakeRefsDigest: undefined, imageId: 'latest', sha: 'a'.repeat(40), buildInputsDigest: I, recipe: recipe(R) };

    it('is unchanged by a new commit when the recipe and the build inputs are the same', () => {
        expect(bakeFingerprintOf({ ...one, sha: 'b'.repeat(40) })).toBe(bakeFingerprintOf(one));
    });
    it('changes when the build inputs change, and when the recipe changes', () => {
        const k = bakeFingerprintOf(one);
        expect(bakeFingerprintOf({ ...one, buildInputsDigest: 'f'.repeat(64) })).not.toBe(k);
        expect(bakeFingerprintOf({ ...one, recipe: recipe(`sha256:${'9'.repeat(64)}`) })).not.toBe(k);
    });
    it('falls back to the commit and the recipe when the product sent no build inputs: any new commit changes the key', () => {
        const noInputs = { ...one, buildInputsDigest: undefined };
        expect(bakeFingerprintOf(noInputs)).toMatch(/^[0-9a-f]{64}$/);
        expect(bakeFingerprintOf({ ...noInputs, sha: 'b'.repeat(40) })).not.toBe(bakeFingerprintOf(noInputs));
        expect(bakeFingerprintOf(noInputs)).not.toBe(bakeFingerprintOf(one));
    });
    it('is none when the setup baked nothing, even with build inputs', () => {
        expect(bakeFingerprintOf({ ...one, imageId: undefined })).toBeNull();
    });
    it("keeps a multi-repository setup's key as its refs digest, whatever the build inputs say", () => {
        expect(bakeFingerprintOf({ ...one, bakeRefsDigest: `sha256:${FP}` })).toBe(FP);
    });
    it("reports the commit the template setup booted, so the template records the main commit it holds", async () => {
        const r = rec({ bakeRefsDigest: undefined, imageId: 'latest', sha: 'a'.repeat(40), buildInputsDigest: I, recipe: recipe(R), cellId: 'c' });
        expect(await probe(r).read(req)).toMatchObject({ state: 'done', sha: 'a'.repeat(40), fingerprint: bakeFingerprintOf(one) });
    });
});

