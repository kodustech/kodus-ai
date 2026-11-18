import { randomUUID } from 'crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { isolatedDatabase } from '../../testing/isolated-database';

// The SDK contract the sweep stands on (run-engine.service.ts sweep): listWorkflows with
// workflowIDs and status returns the rows that match both, whatever their age.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'sweep_lookup');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('DBOS lookup of the sweep (integration, isolated Postgres)', () => {
    const suffix = randomUUID();

    beforeAll(() => database.create());
    afterAll(async () => {
        await DBOS.shutdown({ deregister: true });
        await database.drop();
    });

    it('returns, of the ids asked, only the workflows in a stopped status', async () => {
        const workflow = DBOS.registerWorkflow(async (fail: boolean) => {
            if (fail) throw new Error('synthetic');
            return 'ok';
        }, { name: 'it_sweep_lookup' });
        DBOS.setConfig({ name: `sweep-lookup-${suffix}`, systemDatabaseUrl: url, logLevel: 'error' });
        await DBOS.launch();
        const failed = `failed-${suffix}`;
        const done = `done-${suffix}`;
        const other = `other-${suffix}`;
        await expect((await DBOS.startWorkflow(workflow, { workflowID: failed })(true)).getResult()).rejects.toThrow('synthetic');
        await (await DBOS.startWorkflow(workflow, { workflowID: done })(false)).getResult();
        await expect((await DBOS.startWorkflow(workflow, { workflowID: other })(true)).getResult()).rejects.toThrow('synthetic');

        const rows = await DBOS.listWorkflows({ workflowIDs: [failed, done, `${failed}:run`], status: ['CANCELLED', 'ERROR', 'ENQUEUED'], loadInput: false, loadOutput: false });
        expect(rows.map((r) => [r.workflowID, r.status, r.workflowName])).toEqual([[failed, 'ERROR', 'it_sweep_lookup']]);
    });
});
