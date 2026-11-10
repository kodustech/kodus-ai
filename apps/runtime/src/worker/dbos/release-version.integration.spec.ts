import { randomUUID } from 'crypto';

import { DBOS } from '@dbos-inc/dbos-sdk';

// Public SDK contract for the explicit release identity (#2465). This proves
// queued version selection, not compatibility of journals across code changes.
const url = process.env.RUNTIME_IT_DATABASE_URL ?? '';
const skip = !url || process.env.SKIP_INTEGRATION === 'true';

(skip ? describe.skip : describe)('DBOS release selection (integration, isolated Postgres)', () => {
    const suffix = randomUUID();
    const app = `release-proof-${suffix}`;
    const queue = `release-proof-${suffix}`;
    const oldRelease = `v1-${suffix}`;
    const newRelease = `v2-${suffix}`;

    async function launch(release: string) {
        const workflow = DBOS.registerWorkflow(async () => {
            return DBOS.runStep(async () => release, { name: 'executing-release' });
        }, { name: 'it_release_selection' });
        DBOS.setConfig({ name: app, systemDatabaseUrl: url, applicationVersion: release, logLevel: 'error' });
        await DBOS.launch();
        await DBOS.registerQueue(queue, { globalConcurrency: 1, minPollingIntervalMs: 25, onConflict: 'always_update' });
        return workflow;
    }

    afterAll(async () => DBOS.shutdown({ deregister: true }));

    it('leaves old-version work for an old compatible worker while new work progresses', async () => {
        const oldId = `old-${suffix}`;
        const newId = `new-${suffix}`;
        const oldWorkflow = await launch(oldRelease);
        await DBOS.startWorkflow(oldWorkflow, {
            workflowID: oldId,
            queueName: queue,
            enqueueOptions: { delaySeconds: 60 },
        })();
        expect(await DBOS.getWorkflowStatus(oldId)).toMatchObject({ status: 'DELAYED', applicationVersion: oldRelease });
        await DBOS.shutdown({ deregister: true });

        const newWorkflow = await launch(newRelease);
        await DBOS.setWorkflowDelay(oldId, { delaySeconds: 0.1 });
        for (let i = 0; i < 100 && (await DBOS.getWorkflowStatus(oldId))?.status === 'DELAYED'; i++) {
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(await DBOS.getWorkflowStatus(oldId)).toMatchObject({ status: 'ENQUEUED' });
        const next = await DBOS.startWorkflow(newWorkflow, { workflowID: newId, queueName: queue })();
        expect(await next.getResult()).toBe(newRelease);
        expect(await DBOS.getWorkflowStatus(newId)).toMatchObject({ status: 'SUCCESS', applicationVersion: newRelease });
        // V2's dequeuer has processed the queue, but must not run V1's earlier row.
        const old = await DBOS.getWorkflowStatus(oldId);
        expect(old).toMatchObject({ applicationVersion: oldRelease });
        expect(old?.status).toBe('ENQUEUED');
        await DBOS.shutdown({ deregister: true });

        await launch(oldRelease);
        expect(await DBOS.retrieveWorkflow<string>(oldId).getResult()).toBe(oldRelease);
        expect(await DBOS.getWorkflowStatus(oldId)).toMatchObject({ status: 'SUCCESS', applicationVersion: oldRelease });
    }, 30_000);
});
