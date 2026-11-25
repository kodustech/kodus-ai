import { ConnectionAccessService } from './connection-access.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const user = { uuid: 'user-1', organization: { uuid: 'org-1' } };

const build = (opts: {
    connections: string[];
    granted: string[];
    reposByConnection?: Record<string, Array<{ id: string | number }>>;
}) => {
    const query = jest.fn(async (sql: string, params: unknown[]) => {
        if (
            sql.includes('FROM "integrations"') &&
            !sql.includes('integration_configs')
        ) {
            return opts.connections.map((uuid) => ({ uuid }));
        }
        if (sql.includes('FROM "user_connection_access"')) {
            return opts.granted.map((integration_id) => ({ integration_id }));
        }
        if (sql.includes('integration_configs')) {
            const ids = params[1] as string[];
            return ids.map((id) => ({
                configValue: opts.reposByConnection?.[id] ?? [],
            }));
        }
        return [];
    });
    const repository = {
        manager: { query },
        insert: jest.fn(),
        delete: jest.fn(),
        createQueryBuilder: jest.fn(),
    };
    return { service: new ConnectionAccessService(repository as any), query };
};

describe('ConnectionAccessService.readScopeFor', () => {
    it('reads the whole organization when every connection is granted', async () => {
        const { service } = build({
            connections: ['gh-a', 'gl-b'],
            granted: ['gh-a', 'gl-b'],
        });

        await expect(service.readScopeFor(user)).resolves.toEqual({
            kind: 'all',
        });
    });

    it('reads the whole organization while it has no Git connection', async () => {
        const { service } = build({ connections: [], granted: [] });

        await expect(service.readScopeFor(user)).resolves.toEqual({
            kind: 'all',
        });
    });

    it('narrows reads to the repositories of the granted connections', async () => {
        const { service } = build({
            connections: ['gh-a', 'gl-b'],
            granted: ['gh-a'],
            reposByConnection: { 'gh-a': [{ id: 1 }, { id: '2' }] },
        });

        await expect(service.readScopeFor(user)).resolves.toEqual({
            kind: 'connections',
            connectionIds: ['gh-a'],
            repositoryIds: ['1', '2'],
            repositoryNames: [],
        });
    });

    it('reads nothing repository-scoped without any grant', async () => {
        const { service } = build({
            connections: ['gh-a'],
            granted: [],
        });

        await expect(service.readScopeFor(user)).resolves.toEqual({
            kind: 'connections',
            connectionIds: [],
            repositoryIds: [],
            repositoryNames: [],
        });
    });

    it('answers a repeated read for the same user from memory', async () => {
        const { service, query } = build({
            connections: ['gh-a'],
            granted: ['gh-a'],
        });

        await service.readScopeFor(user);
        const calls = query.mock.calls.length;
        await service.readScopeFor(user);

        expect(query.mock.calls.length).toBe(calls);
    });
});

describe('ConnectionAccessService.restrictionFor', () => {
    it('restricts nothing for an owner or a member granted every connection', async () => {
        const { service } = build({
            connections: ['gh-a', 'gl-b'],
            granted: ['gh-a'],
        });

        await expect(
            service.restrictionFor({ ...user, role: 'owner' }),
        ).resolves.toBeNull();

        const full = build({
            connections: ['gh-a'],
            granted: ['gh-a'],
        });
        await expect(
            full.service.restrictionFor({ ...user, role: 'contributor' }),
        ).resolves.toBeNull();
    });

    it("limits a partially granted member to the granted connections' repositories, by id and by name", async () => {
        const { service } = build({
            connections: ['gh-a', 'gl-b'],
            granted: ['gh-a'],
            reposByConnection: {
                'gh-a': [
                    {
                        id: 7,
                        name: 'api',
                        full_name: 'Acme/API',
                        organizationName: 'acme',
                    } as any,
                ],
            },
        });

        const restriction = await service.restrictionFor({
            ...user,
            role: 'contributor',
        });

        expect(restriction?.allowsRepository({ id: '7' })).toBe(true);
        expect(restriction?.allowsRepository({ name: 'acme/api' })).toBe(true);
        expect(restriction?.allowsRepository({ name: 'Acme/API' })).toBe(true);
        // A bare name could be another connection's repository of the same name.
        expect(restriction?.allowsRepository({ name: 'api' })).toBe(false);
        expect(restriction?.allowsRepository({ id: '8' })).toBe(false);
        expect(restriction?.allowsRepository({ name: 'group/other' })).toBe(
            false,
        );
        expect(restriction?.allowsRepository({})).toBe(false);
    });
});

describe('ConnectionAccessService.replaceGrants', () => {
    const buildTx = (current: string[]) => {
        const calls: string[] = [];
        const tx = {
            query: jest.fn(async (sql: string) => {
                calls.push(sql);
                if (sql.includes('pg_advisory_xact_lock')) return [];
                if (sql.startsWith('SELECT')) {
                    return current.map((user_id) => ({ user_id }));
                }
                return [];
            }),
        };
        const repository = {
            manager: {
                query: jest.fn(),
                transaction: jest.fn(async (work: (m: unknown) => unknown) =>
                    work(tx),
                ),
            },
        };
        return {
            service: new ConnectionAccessService(repository as any),
            tx,
            calls,
            repository,
        };
    };

    it('applies the target set in one transaction, locked per connection before reading', async () => {
        const { service, tx, calls, repository } = buildTx(['u1', 'u2']);

        const diff = await service.replaceGrants('conn-1', ['u2', 'u3']);

        expect(repository.manager.transaction).toHaveBeenCalledTimes(1);
        expect(calls[0]).toContain('pg_advisory_xact_lock');
        expect(calls[1]).toMatch(/^SELECT/);
        expect(diff).toEqual({ granted: ['u3'], revoked: ['u1'] });
        expect(tx.query).toHaveBeenCalledWith(
            expect.stringContaining('INSERT INTO "user_connection_access"'),
            ['conn-1', ['u3']],
        );
        expect(tx.query).toHaveBeenCalledWith(
            expect.stringContaining('DELETE FROM "user_connection_access"'),
            ['conn-1', ['u1']],
        );
    });

    it('writes nothing when the set is unchanged', async () => {
        const { service, tx } = buildTx(['u1']);

        await expect(service.replaceGrants('conn-1', ['u1'])).resolves.toEqual({
            granted: [],
            revoked: [],
        });
        expect(tx.query).toHaveBeenCalledTimes(2);
    });
});
