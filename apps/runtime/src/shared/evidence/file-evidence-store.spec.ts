import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { evidenceKey } from '@libs/runtime/contracts/evidence';

import { FileEvidenceStore } from './file-evidence-store';

const STEP = '0b6f2c1e-7a4d-4c3b-9f1e-2d8a5c6b7e90';

describe('file evidence store retention sweep', () => {
    let dir: string;

    beforeEach(async () => {
        dir = await fs.mkdtemp(join(tmpdir(), 'kr-evidence-sweep-'));
    });

    afterEach(async () => {
        jest.restoreAllMocks();
        await fs.rm(dir, { recursive: true, force: true });
    });

    it('fails when the evidence directory cannot be read, instead of reporting that nothing was past retention', async () => {
        const store = new FileEvidenceStore(dir);
        await store.put(evidenceKey({ organizationId: 'org-a', runId: 'run-1', side: 'pr', stepId: STEP, type: 'output' }), 'old', 'text/plain');
        jest.spyOn(fs, 'readdir').mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
        await expect(store.sweep()).rejects.toMatchObject({ code: 'EACCES' });
    });

    it('sweeps a store whose directory does not exist yet as empty', async () => {
        expect(await new FileEvidenceStore(join(dir, 'not-created')).sweep()).toBe(0);
    });
});

describe('file evidence store deletePrefix (the purge of an organization)', () => {
    let dir: string;
    const key = (organizationId: string, runId: string, type = 'output') => evidenceKey({ organizationId, runId, side: 'pr', stepId: STEP, type });

    beforeEach(async () => {
        dir = await fs.mkdtemp(join(tmpdir(), 'kr-evidence-purge-'));
    });
    afterEach(async () => {
        await fs.rm(dir, { recursive: true, force: true });
    });

    it("removes an organization's directory with its objects and counts them, and keeps another organization's", async () => {
        const store = new FileEvidenceStore(dir);
        await store.put(key('org-1', 'run-1'), 'a', 'text/plain');
        await store.put(key('org-1', 'run-2', 'logs'), 'b', 'text/plain');
        await store.put(key('org-10', 'run-1'), 'c', 'text/plain');

        expect(await store.deletePrefix('org-1/')).toBe(2);

        expect(await store.get(key('org-1', 'run-1'))).toBeNull();
        expect((await store.get(key('org-10', 'run-1')))?.body.toString()).toBe('c');
        await expect(fs.stat(join(dir, 'org-1'))).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('removes one Run only, and returns 0 for a prefix that is not there', async () => {
        const store = new FileEvidenceStore(dir);
        await store.put(key('org-1', 'run-1'), 'a', 'text/plain');
        await store.put(key('org-1', 'run-2'), 'b', 'text/plain');
        expect(await store.deletePrefix('org-1/run-1/')).toBe(1);
        expect(await store.get(key('org-1', 'run-2'))).not.toBeNull();
        expect(await store.deletePrefix('org-9/')).toBe(0);
        expect(await new FileEvidenceStore(join(dir, 'not-created')).deletePrefix('org-1/')).toBe(0);
    });

    it('refuses a prefix that is empty, wide or climbs out of the store', async () => {
        const store = new FileEvidenceStore(dir);
        await store.put(key('org-1', 'run-1'), 'a', 'text/plain');
        for (const bad of ['', '/', 'org-1', '../', '..//', 'org-1/../', 'org-1/run-1/pr/']) await expect(store.deletePrefix(bad)).rejects.toThrow(/prefix/);
        expect(await store.get(key('org-1', 'run-1'))).not.toBeNull();
    });
});
