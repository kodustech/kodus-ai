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
