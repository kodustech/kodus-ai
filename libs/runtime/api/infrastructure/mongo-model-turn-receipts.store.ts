import type { Collection, Db } from 'mongodb';
import type { ModelTurnResponse } from '@libs/runtime/contracts/model-turn';
import { MODEL_TURN_LIMITS } from '@libs/runtime/contracts/model-turn';
import type { RuntimeModelTurnReceipts } from '../domain/model-turn';

export const MODEL_TURN_RECEIPTS_COLLECTION = 'runtime_model_turn_receipts';
type Receipt = {
    _id: string;
    fingerprint: string;
    expiresAt: Date;
    response?: ModelTurnResponse;
};
/** Product-owned receipts survive request loss and process restart; a pending turn is never retried. */
export class MongoModelTurnReceipts implements RuntimeModelTurnReceipts {
    private ready?: Promise<Collection<Receipt>>;
    constructor(private readonly db: () => Promise<Db>) {}
    private collection() {
        this.ready ??= (async () => {
            const coll = (await this.db()).collection<Receipt>(
                MODEL_TURN_RECEIPTS_COLLECTION,
            );
            await coll.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
            return coll;
        })().catch((e) => {
            this.ready = undefined;
            throw e;
        });
        return this.ready;
    }
    async claim(key: string, fingerprint: string, expiresAt: Date) {
        const coll = await this.collection();
        try {
            await coll.insertOne({ _id: key, fingerprint, expiresAt });
            return { fresh: true as const };
        } catch (e) {
            if ((e as { code?: number }).code !== 11000) throw e;
        }
        const existing = await coll.findOne({ _id: key });
        if (!existing) throw Error('model turn receipt unavailable');
        return {
            fresh: false as const,
            fingerprint: existing.fingerprint,
            ...(existing.response ? { response: existing.response } : {}),
        };
    }
    async complete(
        key: string,
        fingerprint: string,
        response: ModelTurnResponse,
    ) {
        if (
            Buffer.byteLength(JSON.stringify(response), 'utf8') >
            MODEL_TURN_LIMITS.responseBytes
        )
            throw Error('model turn response too large');
        const updated = await (
            await this.collection()
        ).updateOne(
            { _id: key, fingerprint, response: { $exists: false } },
            { $set: { response } },
        );
        if (updated.modifiedCount !== 1)
            throw Error('model turn receipt conflict');
    }
}
