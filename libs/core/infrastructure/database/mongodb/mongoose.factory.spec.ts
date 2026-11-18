import { MongooseFactory } from './mongoose.factory';

describe('MongooseFactory connection options', () => {
    const KEYS = ['COMPONENT_TYPE', 'MONGO_AUTO_INDEX', 'MG_POOL_MIN_API'];
    let saved: Record<string, string | undefined>;

    const options = () =>
        new MongooseFactory({
            get: (key: string, fallback?: unknown) =>
                key === 'mongoDatabase'
                    ? { url: 'mongodb://h:27017', database: 'kodus' }
                    : fallback,
        } as any).createMongooseOptions() as Record<string, unknown>;

    beforeEach(() => {
        saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
        KEYS.forEach((k) => delete process.env[k]);
    });
    afterEach(() => {
        for (const [k, v] of Object.entries(saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    it('builds schema indexes on boot unless production turns it off', () => {
        expect(options().autoIndex).toBe(true);
        process.env.MONGO_AUTO_INDEX = 'false';
        expect(options().autoIndex).toBe(false);
    });

    it('keeps one idle connection per member for an API task, overridable', () => {
        process.env.COMPONENT_TYPE = 'api';
        expect(options().minPoolSize).toBe(1);
        process.env.MG_POOL_MIN_API = '3';
        expect(options().minPoolSize).toBe(3);
    });

    it('fails a request that cannot get a connection instead of queueing it forever', () => {
        expect(options().waitQueueTimeoutMS).toBeGreaterThan(0);
        expect(options().serverSelectionTimeoutMS).toBeGreaterThan(0);
    });
});
