import mongoose, { Query } from 'mongoose';

import {
    SandboxCapacityStateSchema,
    SandboxCapacityTicketSchema,
} from '../repositories/schemas/sandbox-capacity.model';
import { MongoCapacityStore } from './sandbox-capacity-mongo.store';

// Mongoose 9 validates the update before any I/O: an aggregation-pipeline
// update without `updatePipeline: true` throws. This runs the production call
// on real Mongoose models (no database), so that bug fails here, in every CI
// job, not only where a Mongo is available.
describe('MongoCapacityStore.tryAdmit (Mongoose-strict, no database)', () => {
    afterEach(() => jest.restoreAllMocks());

    it('passes the pipeline update with updatePipeline so Mongoose accepts it', async () => {
        const connection = mongoose.createConnection();
        const store = new MongoCapacityStore(
            connection.model('T', SandboxCapacityTicketSchema),
            connection.model('S', SandboxCapacityStateSchema),
        );
        jest.spyOn(Query.prototype, 'exec').mockResolvedValue({
            slots: [{ ticketId: 't1' }],
        } as any);

        const now = new Date();
        await expect(
            store.tryAdmit('t1', 1, now, new Date(now.getTime() - 45_000)),
        ).resolves.toBe(true);
    });
});
