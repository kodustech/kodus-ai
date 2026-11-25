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
        expect(restriction?.allowsRepository({ id: '8' })).toBe(false);
        expect(restriction?.allowsRepository({ name: 'group/other' })).toBe(
            false,
        );
        expect(restriction?.allowsRepository({})).toBe(false);
    });
});
