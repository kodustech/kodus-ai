import type { EnvironmentSetupProgress, EnvironmentSetupRecord } from '@libs/runtime/run';

export const ENVIRONMENT_SETUP_STORE = Symbol('ENVIRONMENT_SETUP_STORE');

/** The latest setup of each environment (Environment Health reads it; a Run boots with its recipe). */
export interface EnvironmentSetupStore {
    get(environmentId: string): Promise<EnvironmentSetupRecord | null>;
    save(record: EnvironmentSetupRecord): Promise<void>;
    /**
     * Sets only the running boot's progress of that setup (key), outside the
     * workflow's journal: a live view, best effort; the setup's own saves
     * carry it from the boot's end.
     */
    saveProgress?(environmentId: string, key: string, progress: EnvironmentSetupProgress): Promise<void>;
}

/** The Mongo calls the store makes (a Collection<EnvironmentSetupRecord> satisfies it). */
export interface SetupCollection {
    findOne(filter: { environmentId: string }, options: { projection: { _id: 0 } }): Promise<unknown>;
    replaceOne(filter: { environmentId: string }, doc: EnvironmentSetupRecord, options: { upsert: true }): Promise<unknown>;
    updateOne?(filter: { environmentId: string; key: string; state: 'setting_up' }, update: { $set: { progress: EnvironmentSetupProgress } }): Promise<unknown>;
}

/** Mongo store, one document per environment (the latest setup). */
export class MongoEnvironmentSetupStore implements EnvironmentSetupStore {
    constructor(private readonly coll: SetupCollection) {}

    static async ensureIndexes(coll: { createIndex(spec: Record<string, 1 | -1>, options?: { unique?: boolean }): Promise<unknown> }) {
        await coll.createIndex({ environmentId: 1 }, { unique: true });
        await coll.createIndex({ organizationId: 1, updatedAt: -1 });
    }

    async get(environmentId: string) {
        return (await this.coll.findOne({ environmentId }, { projection: { _id: 0 } })) as EnvironmentSetupRecord | null;
    }

    async save(record: EnvironmentSetupRecord) {
        await this.coll.replaceOne({ environmentId: record.environmentId }, { ...record, steps: [...record.steps], blockers: [...record.blockers] }, { upsert: true });
    }

    async saveProgress(environmentId: string, key: string, progress: EnvironmentSetupProgress) {
        // Only the setup still running: a late poll never writes over a finished one.
        await this.coll.updateOne?.({ environmentId, key, state: 'setting_up' }, { $set: { progress } });
    }
}

export class InMemoryEnvironmentSetupStore implements EnvironmentSetupStore {
    readonly saved: EnvironmentSetupRecord[] = [];
    private readonly byId = new Map<string, EnvironmentSetupRecord>();

    async get(environmentId: string) {
        return this.byId.get(environmentId) ?? null;
    }

    async save(record: EnvironmentSetupRecord) {
        const copy = JSON.parse(JSON.stringify(record)) as EnvironmentSetupRecord;
        this.byId.set(record.environmentId, copy);
        this.saved.push(copy);
    }

    async saveProgress(environmentId: string, key: string, progress: EnvironmentSetupProgress) {
        const r = this.byId.get(environmentId);
        if (r && r.key === key && r.state === 'setting_up') r.progress = JSON.parse(JSON.stringify(progress));
    }
}

