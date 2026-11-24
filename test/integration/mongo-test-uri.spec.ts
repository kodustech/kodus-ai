import { resolveMongoTestGate } from './mongo-test-uri';

describe('resolveMongoTestGate', () => {
    const originalEnv = { ...process.env };

    beforeEach(() => {
        // The job that runs this spec sets some of these itself.
        delete process.env.CI;
        delete process.env.SKIP_INTEGRATION;
        delete process.env.TEST_MONGODB_URI;
        delete process.env.API_MG_DB_HOST;
    });

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    it.each([
        ['a dev machine without a Mongo URI', {}],
        [
            'SKIP_INTEGRATION=true on a dev machine',
            { SKIP_INTEGRATION: 'true' },
        ],
        [
            'SKIP_INTEGRATION=true in CI',
            { SKIP_INTEGRATION: 'true', CI: 'true' },
        ],
        [
            'SKIP_INTEGRATION=true in CI, even with a Mongo URI',
            {
                SKIP_INTEGRATION: 'true',
                CI: 'true',
                TEST_MONGODB_URI: 'mongodb://localhost:27017/x',
            },
        ],
    ])('skips on %s', (_name, env) => {
        Object.assign(process.env, env);

        expect(resolveMongoTestGate()).toEqual({
            shouldSkip: true,
            mongoUri: '',
        });
    });

    it.each(['true', '1'])(
        'fails loudly in CI=%s without a Mongo URI',
        (ci) => {
            process.env.CI = ci;

            expect(() => resolveMongoTestGate()).toThrow(
                /TEST_MONGODB_URI is not set/,
            );
        },
    );

    it('still fails in CI when only the host fallback is set and the suite refuses it', () => {
        process.env.CI = 'true';
        process.env.API_MG_DB_HOST = 'db_mongodb';

        expect(() => resolveMongoTestGate('kodus_test', false)).toThrow(
            /TEST_MONGODB_URI is not set/,
        );
    });

    it.each(['false', '', '1', 'TRUE'])(
        'does not treat SKIP_INTEGRATION=%p as the opt-out',
        (value) => {
            process.env.CI = 'true';
            process.env.SKIP_INTEGRATION = value;

            expect(() => resolveMongoTestGate()).toThrow(
                /TEST_MONGODB_URI is not set/,
            );
        },
    );

    describe('with a Mongo URI', () => {
        it('runs against a full connection string as given', () => {
            process.env.CI = 'true';
            process.env.TEST_MONGODB_URI =
                'mongodb://user:pass@localhost:27017/kodus_ci?authSource=admin';

            expect(resolveMongoTestGate()).toEqual({
                shouldSkip: false,
                mongoUri:
                    'mongodb://user:pass@localhost:27017/kodus_ci?authSource=admin',
            });
        });

        it('builds the connection string from a bare host and the suite database', () => {
            process.env.API_MG_DB_HOST = 'localhost';

            expect(resolveMongoTestGate('kodus_test_1107')).toEqual({
                shouldSkip: false,
                mongoUri: 'mongodb://localhost:27017/kodus_test_1107',
            });
        });

        it('prefers TEST_MONGODB_URI over the host fallback', () => {
            process.env.TEST_MONGODB_URI = 'mongodb://a:27017/one';
            process.env.API_MG_DB_HOST = 'b';

            expect(resolveMongoTestGate().mongoUri).toBe(
                'mongodb://a:27017/one',
            );
        });
    });
});
