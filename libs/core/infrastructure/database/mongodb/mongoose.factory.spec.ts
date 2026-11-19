import { MongooseFactory } from './mongoose.factory';

describe('MongooseFactory connection options', () => {
    const KEYS = [
        'COMPONENT_TYPE',
        'MONGO_AUTO_INDEX',
        'MG_POOL_MIN_API',
        'MG_POOL_MAX_API',
        'MG_POOL_MIN_WEBHOOK',
        'MG_POOL_MAX_WEBHOOK',
        'MG_POOL_MIN_WORKER',
        'MG_POOL_MAX_WORKER',
        'MG_SERVER_SELECTION_TIMEOUT_MS',
        'MG_WAIT_QUEUE_TIMEOUT_MS',
    ];
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

    it('falls back to the default for a zero, blank or unparseable limit', () => {
        process.env.COMPONENT_TYPE = 'api';
        for (const value of ['0', '', 'abc']) {
            process.env.MG_POOL_MAX_API = value;
            process.env.MG_WAIT_QUEUE_TIMEOUT_MS = value;
            expect(options().maxPoolSize).toBe(30);
            expect(options().waitQueueTimeoutMS).toBe(30_000);
        }
    });

    it('accepts a pool minimum of zero, and falls back for an unparseable one', () => {
        process.env.COMPONENT_TYPE = 'api';
        process.env.MG_POOL_MIN_API = '0';
        expect(options().minPoolSize).toBe(0);
        // Previously forwarded to the driver as NaN.
        process.env.MG_POOL_MIN_API = 'abc';
        expect(options().minPoolSize).toBe(1);
    });

    it.each([
        ['webhook', 'MG_POOL_MAX_WEBHOOK', 'maxPoolSize'],
        ['webhook', 'MG_POOL_MIN_WEBHOOK', 'minPoolSize'],
        ['api', 'MG_POOL_MAX_API', 'maxPoolSize'],
        ['worker', 'MG_POOL_MAX_WORKER', 'maxPoolSize'],
        ['worker', 'MG_POOL_MIN_WORKER', 'minPoolSize'],
        ['api', 'MG_SERVER_SELECTION_TIMEOUT_MS', 'serverSelectionTimeoutMS'],
        ['api', 'MG_WAIT_QUEUE_TIMEOUT_MS', 'waitQueueTimeoutMS'],
    ])('a %s process reads %s into %s', (component, key, option) => {
        process.env.COMPONENT_TYPE = component;
        process.env[key] = '7';
        expect(options()[option]).toBe(7);
    });
});
