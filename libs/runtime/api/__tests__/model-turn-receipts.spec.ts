import {
    MongoModelTurnReceipts,
    MODEL_TURN_RECEIPTS_COLLECTION,
} from '../infrastructure/mongo-model-turn-receipts.store';

/** Stateful Mongo boundary: adapters may restart; the unique _id remains in storage. */
function mongo() {
    const documents = new Map<string, any>();
    const collection = {
        createIndex: jest.fn(async () => 'expiresAt_1'),
        insertOne: jest.fn(async (document: any) => {
            if (documents.has(document._id))
                throw Object.assign(new Error('duplicate'), { code: 11000 });
            documents.set(document._id, structuredClone(document));
        }),
        findOne: jest.fn(
            async (query: any) => documents.get(query._id) ?? null,
        ),
        updateOne: jest.fn(async (query: any, change: any) => {
            const row = documents.get(query._id);
            if (!row || row.fingerprint !== query.fingerprint || row.response)
                return { modifiedCount: 0 };
            Object.assign(row, structuredClone(change.$set));
            return { modifiedCount: 1 };
        }),
    };
    const db = { collection: jest.fn(() => collection) };
    return {
        db,
        collection,
        adapter: () => new MongoModelTurnReceipts(async () => db as any),
    };
}
it('atomically refuses a second in-flight turn across separate product instances and keeps a completed receipt after adapter restart', async () => {
    const h = mongo(),
        expiry = new Date('2026-11-10T00:00:00Z');
    const [one, two] = await Promise.all([
        h.adapter().claim('turn', 'fingerprint', expiry),
        h.adapter().claim('turn', 'fingerprint', expiry),
    ]);
    expect([one, two].filter((result) => result.fresh)).toHaveLength(1);
    const response: any = { safe: 'bounded fixture response' };
    await h.adapter().complete('turn', 'fingerprint', response);
    expect(await h.adapter().claim('turn', 'fingerprint', expiry)).toEqual({
        fresh: false,
        fingerprint: 'fingerprint',
        response,
    });
    await expect(
        h.adapter().complete('turn', 'fingerprint', { changed: true } as any),
    ).rejects.toThrow('conflict');
    expect(h.db.collection).toHaveBeenCalledWith(
        MODEL_TURN_RECEIPTS_COLLECTION,
    );
    expect(h.collection.createIndex).toHaveBeenCalledWith(
        { expiresAt: 1 },
        { expireAfterSeconds: 0 },
    );
});
it('does not complete a different fingerprint or persist an oversized response', async () => {
    const h = mongo(),
        adapter = h.adapter();
    await adapter.claim('turn', 'fingerprint', new Date());
    await expect(
        adapter.complete('turn', 'different', {} as any),
    ).rejects.toThrow('conflict');
    await expect(
        adapter.complete('turn', 'fingerprint', {
            text: 'x'.repeat(1_000_001),
        } as any),
    ).rejects.toThrow('too large');
    expect(await adapter.claim('turn', 'fingerprint', new Date())).toEqual({
        fresh: false,
        fingerprint: 'fingerprint',
    });
});
