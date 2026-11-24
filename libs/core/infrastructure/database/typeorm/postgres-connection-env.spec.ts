import {
    describeConnection,
    resolveDirectConnection,
    resolvePooledConnection,
    resolveSessionConnection,
    resolveSessionTimeouts,
} from './postgres-connection-env';

const discreteVars = {
    API_PG_DB_HOST: 'pgbouncer',
    API_PG_DB_PORT: '6432',
    API_PG_DB_USERNAME: 'kodus',
    API_PG_DB_PASSWORD: 's3cret',
    API_PG_DB_DATABASE: 'kodus_db',
};

describe('Postgres connection settings', () => {
    describe('session timeouts sent at connect', () => {
        it('keeps the 30s statement and 60s idle-in-transaction limits by default', () => {
            expect(resolveSessionTimeouts({})).toEqual({
                statement_timeout: 30_000,
                idle_in_transaction_session_timeout: 60_000,
            });
        });

        it('sends neither when both are 0, so a pooler that refuses unknown startup parameters accepts the connection', () => {
            expect(
                resolveSessionTimeouts({
                    DB_STATEMENT_TIMEOUT_MS: '0',
                    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '0',
                }),
            ).toEqual({});
        });

        it('treats an empty value from docker-compose as unset', () => {
            expect(
                resolveSessionTimeouts({ DB_STATEMENT_TIMEOUT_MS: '  ' }),
            ).toMatchObject({ statement_timeout: 30_000 });
        });

        it('accepts any whole number of milliseconds, ignoring surrounding spaces', () => {
            expect(
                resolveSessionTimeouts({
                    DB_STATEMENT_TIMEOUT_MS: ' 45000 ',
                    DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '120000',
                }),
            ).toEqual({
                statement_timeout: 45000,
                idle_in_transaction_session_timeout: 120000,
            });
        });

        it('refuses a value that merely ends in digits', () => {
            expect(() =>
                resolveSessionTimeouts({ DB_STATEMENT_TIMEOUT_MS: 'x5' }),
            ).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
        });

        it('refuses a malformed value and names the variable', () => {
            expect(() =>
                resolveSessionTimeouts({ DB_STATEMENT_TIMEOUT_MS: '30s' }),
            ).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
        });
    });

    describe('pooled connection, as the app has always resolved it', () => {
        it('reads API_PG_DB_URL when DATABASE_URL is unset', () => {
            expect(
                resolvePooledConnection({
                    ...discreteVars,
                    API_PG_DB_URL: 'postgres://u:p@pooler:6432/kodus_db',
                }),
            ).toEqual({ url: 'postgres://u:p@pooler:6432/kodus_db' });
        });

        it('in production or homolog a missing host stays missing instead of becoming localhost', () => {
            for (const env of [
                { API_NODE_ENV: 'production' },
                { API_DATABASE_ENV: 'production' },
                { API_DATABASE_ENV: 'homolog', API_NODE_ENV: 'development' },
            ]) {
                expect(resolvePooledConnection(env).host).toBeUndefined();
            }
        });

        it('elsewhere a missing host means localhost, and API_DATABASE_ENV wins over API_NODE_ENV', () => {
            expect(
                resolvePooledConnection({
                    API_DATABASE_ENV: 'development',
                    API_NODE_ENV: 'production',
                }).host,
            ).toBe('localhost');
            expect(resolvePooledConnection({}).host).toBe('localhost');
        });
    });

    describe('direct connection for migrations and LISTEN', () => {
        it('without one, migrations and LISTEN use the pooled connection, as before', () => {
            expect(resolveDirectConnection(discreteVars)).toBeUndefined();
            expect(resolveSessionConnection(discreteVars)).toMatchObject({
                host: 'pgbouncer',
                port: 6432,
            });
        });

        it('a direct host reuses the pooled credentials and database', () => {
            expect(
                resolveSessionConnection({
                    ...discreteVars,
                    API_PG_DB_DIRECT_HOST: 'postgres-primary',
                    API_PG_DB_DIRECT_PORT: '5432',
                }),
            ).toEqual({
                host: 'postgres-primary',
                port: 5432,
                username: 'kodus',
                password: 's3cret',
                database: 'kodus_db',
            });
        });

        it("a direct host defaults to PostgreSQL's port, not the pooler's", () => {
            expect(
                resolveDirectConnection({
                    ...discreteVars,
                    API_PG_DB_DIRECT_HOST: 'postgres-primary',
                }),
            ).toMatchObject({ host: 'postgres-primary', port: 5432 });
        });

        it('a direct host borrows credentials from DATABASE_URL when the app is configured by URL', () => {
            const direct = resolveDirectConnection({
                DATABASE_URL:
                    'postgres://kodus:s3cret@pgbouncer:6432/kodus_db?sslmode=disable',
                API_PG_DB_DIRECT_HOST: 'postgres-primary',
                API_PG_DB_DIRECT_PORT: '5432',
            });
            expect(direct?.url).toBe(
                'postgres://kodus:s3cret@postgres-primary:5432/kodus_db?sslmode=disable',
            );
        });

        it('DATABASE_DIRECT_URL wins over the host form', () => {
            expect(
                resolveDirectConnection({
                    ...discreteVars,
                    DATABASE_DIRECT_URL: 'postgres://u:p@db:5432/x',
                    API_PG_DB_DIRECT_HOST: 'ignored',
                }),
            ).toEqual({ url: 'postgres://u:p@db:5432/x' });
        });

        it('empty compose vars do not count as a direct connection', () => {
            expect(
                resolveDirectConnection({
                    ...discreteVars,
                    DATABASE_DIRECT_URL: '',
                    API_PG_DB_DIRECT_HOST: '',
                }),
            ).toBeUndefined();
        });

        it('a direct host uses API_PG_DB_DIRECT_PORT when given', () => {
            expect(
                resolveDirectConnection({
                    ...discreteVars,
                    API_PG_DB_DIRECT_HOST: 'pg-primary',
                    API_PG_DB_DIRECT_PORT: '5433',
                }),
            ).toMatchObject({ host: 'pg-primary', port: 5433 });
        });

        it.each(['abc', '70000', '0', '54 32', '5432x'])(
            'refuses API_PG_DB_DIRECT_PORT=%p instead of silently keeping the pooled port',
            (port) => {
                for (const pooled of [
                    discreteVars,
                    {
                        DATABASE_URL:
                            'postgres://kodus:s3cret@pgbouncer:6432/kodus_db',
                    },
                ]) {
                    expect(() =>
                        resolveDirectConnection({
                            ...pooled,
                            API_PG_DB_DIRECT_HOST: 'pg-primary',
                            API_PG_DB_DIRECT_PORT: port,
                        }),
                    ).toThrow(/API_PG_DB_DIRECT_PORT/);
                }
            },
        );

        it('a direct host cannot borrow credentials from an unparseable DATABASE_URL, and says what to set instead', () => {
            expect(() =>
                resolveDirectConnection({
                    DATABASE_URL: 'not a url',
                    API_PG_DB_DIRECT_HOST: 'pg-primary',
                }),
            ).toThrow(/DATABASE_DIRECT_URL/);
        });

        it('refuses a direct URL in another scheme', () => {
            expect(() =>
                resolveDirectConnection({
                    DATABASE_DIRECT_URL: 'jdbc:postgresql://db:5432/kodus_db',
                }),
            ).toThrow(/DATABASE_DIRECT_URL/);
        });

        it('refuses a DATABASE_DIRECT_URL that is not a postgres:// URL, naming the variable', () => {
            expect(() =>
                resolveDirectConnection({
                    ...discreteVars,
                    DATABASE_DIRECT_URL: 'preview-disabled',
                }),
            ).toThrow(/DATABASE_DIRECT_URL/);
        });
    });

    it('describes a connection for logs without its credentials', () => {
        const described = [
            describeConnection({
                url: 'postgres://kodus:s3cret@db:5432/kodus_db',
            }),
            describeConnection({
                host: 'db',
                port: 5432,
                username: 'kodus',
                password: 's3cret',
                database: 'kodus_db',
            }),
        ];
        expect(described).toEqual(['db:5432/kodus_db', 'db:5432/kodus_db']);
        expect(described.join(' ')).not.toContain('s3cret');
    });

    it("describes a connection with no port at PostgreSQL's default port", () => {
        expect(
            describeConnection({ url: 'postgres://kodus:s3cret@db/kodus_db' }),
        ).toBe('db:5432/kodus_db');
        expect(describeConnection({ host: 'db', database: 'kodus_db' })).toBe(
            'db:5432/kodus_db',
        );
        expect(describeConnection({})).toBe('?:5432/?');
    });

    it('describes a URL missing its // without printing the credentials that end up in its path', () => {
        const described = describeConnection({
            url: 'postgres:kodus:s3cret@db/kodus_db',
        });
        expect(described).not.toContain('s3cret');
        expect(described).toBe('connection URL without a host');
    });

    it('describes an unparseable URL as such, without echoing it', () => {
        expect(describeConnection({ url: 'postgres://u:s3cret@' })).toBe(
            'unparseable connection URL',
        );
    });
});
