import {
    describeConnection,
    resolveDirectConnection,
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

        it('refuses a malformed value and names the variable', () => {
            expect(() =>
                resolveSessionTimeouts({ DB_STATEMENT_TIMEOUT_MS: '30s' }),
            ).toThrow(/DB_STATEMENT_TIMEOUT_MS/);
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
});
