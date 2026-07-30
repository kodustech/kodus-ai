import { analyticsPostgresConfigLoader } from '@libs/core/infrastructure/config/loaders/analytics-postgres.config.loader';

const ANALYTICS_KEYS = [
    'ANALYTICS_PG_DB_HOST',
    'ANALYTICS_PG_DB_PORT',
    'ANALYTICS_PG_DB_USERNAME',
    'ANALYTICS_PG_DB_PASSWORD',
    'ANALYTICS_PG_DB_DATABASE',
    'ANALYTICS_PG_DB_SCHEMA',
    'API_PG_DB_HOST',
    'API_PG_DB_PORT',
    'API_PG_DB_USERNAME',
    'API_PG_DB_PASSWORD',
    'API_PG_DB_DATABASE',
    'API_DATABASE_ENV',
    'API_NODE_ENV',
];

describe('analyticsPostgresConfigLoader', () => {
    const snapshot: Record<string, string | undefined> = {};

    beforeAll(() => {
        for (const k of ANALYTICS_KEYS) snapshot[k] = process.env[k];
    });

    beforeEach(() => {
        for (const k of ANALYTICS_KEYS) delete process.env[k];
    });

    afterAll(() => {
        for (const k of ANALYTICS_KEYS) {
            if (snapshot[k] === undefined) delete process.env[k];
            else process.env[k] = snapshot[k];
        }
    });

    function load() {
        return analyticsPostgresConfigLoader();
    }

    it('uses the dedicated analytics host when set (cloud topology)', () => {
        process.env.ANALYTICS_PG_DB_HOST = 'analytics-db.internal';
        process.env.ANALYTICS_PG_DB_PORT = '6543';
        process.env.ANALYTICS_PG_DB_USERNAME = 'analytics';
        process.env.ANALYTICS_PG_DB_PASSWORD = 'secret';
        process.env.ANALYTICS_PG_DB_DATABASE = 'analytics_db';
        process.env.API_PG_DB_HOST = 'oltp.internal';

        const cfg = load();

        expect(cfg).toEqual({
            host: 'analytics-db.internal',
            port: 6543,
            username: 'analytics',
            password: 'secret',
            database: 'analytics_db',
            schema: 'analytics',
        });
    });

    it('cascades to API_PG_DB_* when ANALYTICS_PG_DB_HOST is unset (self-hosted)', () => {
        process.env.API_PG_DB_HOST = 'oltp.internal';
        process.env.API_PG_DB_PORT = '5432';
        process.env.API_PG_DB_USERNAME = 'kodus';
        process.env.API_PG_DB_PASSWORD = 'kodus';
        process.env.API_PG_DB_DATABASE = 'kodus_db';

        const cfg = load();

        expect(cfg.host).toBe('oltp.internal');
        expect(cfg.port).toBe(5432);
        expect(cfg.username).toBe('kodus');
        expect(cfg.password).toBe('kodus');
        expect(cfg.database).toBe('kodus_db');
        expect(cfg.schema).toBe('analytics');
    });

    it('treats an empty / whitespace ANALYTICS_PG_DB_HOST as unset and cascades (Bug #4 regression)', () => {
        // docker-compose writes unset vars as empty strings (`${VAR:-}`) and the
        // deploy docs tell self-hosted operators to leave ANALYTICS_PG_DB_HOST
        // empty. An empty string must NOT win the `??` chain — that resolved
        // host to '' → driver connects to 127.0.0.1 → ECONNREFUSED → the
        // analytics worker crash-loops.
        process.env.ANALYTICS_PG_DB_HOST = '';
        process.env.ANALYTICS_PG_DB_USERNAME = '   ';
        process.env.API_PG_DB_HOST = 'oltp.internal';
        process.env.API_PG_DB_USERNAME = 'kodus';
        process.env.API_PG_DB_PASSWORD = 'kodus';

        const cfg = load();
        expect(cfg.host).toBe('oltp.internal');
        expect(cfg.username).toBe('kodus');
        expect(cfg.password).toBe('kodus');
    });

    it('honors a custom schema override', () => {
        process.env.API_PG_DB_HOST = 'oltp';
        process.env.ANALYTICS_PG_DB_SCHEMA = 'warehouse';

        expect(load().schema).toBe('warehouse');
    });

    it('falls back to localhost in development when no host is set', () => {
        process.env.API_NODE_ENV = 'development';
        // No host set anywhere.

        expect(load().host).toBe('localhost');
    });

    it('does NOT default to localhost in production / homolog', () => {
        // Even if host is missing, prod paths must NOT silently bind to
        // localhost — that would be a footgun (worker connects to nothing).
        process.env.API_DATABASE_ENV = 'production';

        // host falls back to API_PG_DB_HOST (which is also unset → undefined)
        expect(load().host).toBeUndefined();
    });

    it('mixes ANALYTICS_PG_DB_USERNAME with API_PG_DB_PASSWORD when only one is set', () => {
        // Cascade is per-field: a partial override is allowed.
        process.env.ANALYTICS_PG_DB_USERNAME = 'analytics';
        process.env.API_PG_DB_USERNAME = 'kodus';
        process.env.API_PG_DB_PASSWORD = 'kodus_pw';

        const cfg = load();
        expect(cfg.username).toBe('analytics');
        expect(cfg.password).toBe('kodus_pw');
    });
});
