import { randomUUID } from 'crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';
import { Pool } from 'pg';

import { isolatedDatabase } from '../../testing/isolated-database';

import { dbosWorkflowHistory, pruneWorkflowHistory } from './workflow-retention';

// The SDK contract the hourly retention stands on (dbosWorkflowHistory): listWorkflows by terminal status and
// creation time, then deleteWorkflows, removes a workflow with its step outputs, and never one still waiting
// or one whose Run is still live in the projection.
const database = isolatedDatabase(process.env.RUNTIME_IT_DATABASE_URL ?? '', 'workflow_retention');
const url = database.url;
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('DBOS workflow retention (integration, isolated Postgres)', () => {
    const suffix = randomUUID();
    let pool: Pool;

    beforeAll(async () => {
        await database.create();
        pool = new Pool({ connectionString: url, max: 2 });
    });
    afterAll(async () => {
        await DBOS.shutdown({ deregister: true });
        await pool?.end();
        await database.drop();
    });

    it("deletes a terminal workflow created 30 days ago with its steps, and keeps a recent one, a waiting one and a live Run's", async () => {
        const step = (n: number) => DBOS.runStep(async () => n * 2, { name: 'double' });
        const workflow = DBOS.registerWorkflow(async (wait: boolean) => {
            await step(1);
            if (wait) await DBOS.recv<string>('go', 60);
            return 'ok';
        }, { name: 'it_workflow_retention' });
        DBOS.setConfig({ name: `workflow-retention-${suffix}`, systemDatabaseUrl: url, logLevel: 'error' });
        await DBOS.launch();
        const [old, live, recent, waiting] = [`old-${suffix}`, `live-${suffix}`, `recent-${suffix}`, `waiting-${suffix}`];
        await (await DBOS.startWorkflow(workflow, { workflowID: old })(false)).getResult();
        // The approved fork Run of a Run still live in the projection (`:run`): its workflow is read by the sweep.
        await (await DBOS.startWorkflow(workflow, { workflowID: `${live}:run` })(false)).getResult();
        await (await DBOS.startWorkflow(workflow, { workflowID: recent })(false)).getResult();
        const handle = await DBOS.startWorkflow(workflow, { workflowID: waiting })(true);
        // Created 31 days ago, as DBOS records it (epoch milliseconds); the waiting one too, so only its status keeps it.
        await pool.query(`UPDATE dbos.workflow_status SET created_at = created_at - 31 * 86400000::bigint WHERE workflow_uuid = ANY($1::text[])`, [[old, `${live}:run`, waiting]]);

        const r = await pruneWorkflowHistory(dbosWorkflowHistory, { now: new Date(), isLive: (runId) => runId === live });
        expect(r).toMatchObject({ deleted: 1, kept: 1, more: false });

        const left = (await pool.query(`SELECT workflow_uuid FROM dbos.workflow_status WHERE workflow_uuid = ANY($1::text[]) ORDER BY 1`, [[old, `${live}:run`, recent, waiting]])).rows.map((x) => x.workflow_uuid);
        expect(left).toEqual([`${live}:run`, recent, waiting].sort());
        expect((await pool.query(`SELECT count(*)::int AS n FROM dbos.operation_outputs WHERE workflow_uuid = $1`, [old])).rows[0].n).toBe(0);
        await DBOS.send(waiting, 'now', 'go');
        expect(await handle.getResult()).toBe('ok');
    });
});
