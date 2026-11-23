import { renewalConnectionConfig } from './lease-renewer';

describe('renewal thread connection', () => {
    it('uses the same TLS settings as the app pool (managed Postgres that requires TLS)', () => {
        expect(
            renewalConnectionConfig(
                {
                    host: 'db.rds.example',
                    port: 5432,
                    username: 'kodus',
                    password: 's3cret',
                    database: 'kodus_db',
                    ssl: true,
                    extra: { ssl: { rejectUnauthorized: false } },
                },
                {},
            ),
        ).toMatchObject({
            host: 'db.rds.example',
            port: 5432,
            user: 'kodus',
            password: 's3cret',
            database: 'kodus_db',
            ssl: { rejectUnauthorized: false },
        });
    });

    it('turns a bare `ssl: true` into an encrypted connection without a CA check, like the pool', () => {
        expect(
            renewalConnectionConfig({ host: 'db', ssl: true }, {}).ssl,
        ).toEqual({ rejectUnauthorized: false });
    });

    it('sends no TLS option when the app pool has none, and leaves it to the URL when the URL sets sslmode', () => {
        expect(renewalConnectionConfig({ host: 'db' }, {})).not.toHaveProperty(
            'ssl',
        );
        const viaUrl = renewalConnectionConfig(
            {
                url: 'postgres://u:p@db:5432/x?sslmode=no-verify',
                ssl: true,
            },
            {},
        );
        expect(viaUrl).toMatchObject({
            connectionString: 'postgres://u:p@db:5432/x?sslmode=no-verify',
        });
        expect(viaUrl).not.toHaveProperty('ssl');
        expect(viaUrl).not.toHaveProperty('host');
    });

    it('names itself, keeps the socket alive, bounds the connect, and sends the session timeouts', () => {
        expect(
            renewalConnectionConfig(
                { host: 'db' },
                {
                    DB_STATEMENT_TIMEOUT_MS: '5000',
                    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
                },
            ),
        ).toEqual({
            host: 'db',
            port: undefined,
            user: undefined,
            password: undefined,
            database: undefined,
            application_name: 'kodus-lock-renewer',
            keepAlive: true,
            connectionTimeoutMillis: 10_000,
            statement_timeout: 5000,
        });
    });
});
