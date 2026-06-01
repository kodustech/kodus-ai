import { HeartbeatCollectorService } from '@libs/telemetry/application/services/heartbeat-collector.service';

type MockDataSource = {
    query: jest.Mock;
};

type MockMongoModel = {
    countDocuments: jest.Mock;
};

function makeMongoModel(count = 0): MockMongoModel {
    return {
        countDocuments: jest.fn().mockReturnValue({
            exec: jest.fn().mockResolvedValue(count),
        }),
    };
}

function build(opts: {
    dsHandler: (sql: string) => unknown;
    pullRequests?: number;
    kodyRules?: number;
}): {
    service: HeartbeatCollectorService;
    pullRequests: MockMongoModel;
    kodyRules: MockMongoModel;
} {
    const dataSource: MockDataSource = {
        query: jest.fn().mockImplementation(opts.dsHandler),
    };
    const pullRequests = makeMongoModel(opts.pullRequests ?? 0);
    const kodyRules = makeMongoModel(opts.kodyRules ?? 0);

    const service = new HeartbeatCollectorService(
        dataSource as never,
        pullRequests as never,
        kodyRules as never,
    );

    return { service, pullRequests, kodyRules };
}

describe('HeartbeatCollectorService.collect', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
    });

    function dsRouter(map: {
        version?: string;
        organizations?: number;
        teams?: number;
        repositories?: number;
        activeUsers?: number;
        integrations?: string[];
    }): (sql: string) => unknown {
        return (sql: string) => {
            if (sql.includes('SELECT version()')) {
                return [{ version: map.version ?? 'PostgreSQL 15.4 (Ubuntu)' }];
            }
            if (sql.includes('FROM "organizations"')) {
                return [{ count: map.organizations ?? 0 }];
            }
            if (sql.includes('FROM "teams"')) {
                return [{ count: map.teams ?? 0 }];
            }
            if (sql.includes('FROM "repositories"')) {
                return [{ count: map.repositories ?? 0 }];
            }
            if (sql.includes('FROM auth')) {
                return [{ count: map.activeUsers ?? 0 }];
            }
            if (sql.includes('FROM integrations')) {
                return (map.integrations ?? []).map((platform) => ({ platform }));
            }
            return [];
        };
    }

    it('returns real values for runtime / version metadata', async () => {
        const { service } = build({ dsHandler: dsRouter({}) });

        const metrics = await service.collect({
            firstSeenAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
        });

        // Reads from package.json — must look like a semver string and not
        // be the placeholder fallback.
        expect(metrics.kodus.version).toMatch(/^\d+\.\d+\.\d+/);
        expect(metrics.kodus.version).not.toBe('0.0.0');
        expect(metrics.kodus.uptime_hours).toBe(5);
        expect(metrics.runtime.node_version).toBe(process.version);
        expect(metrics.runtime.cpu_count).toBeGreaterThan(0);
        expect(metrics.runtime.db_type).toBe('postgres');
    });

    it('truncates Postgres version() output to first two tokens', async () => {
        const { service } = build({
            dsHandler: dsRouter({ version: 'PostgreSQL 15.4 (Ubuntu 15.4-1)' }),
        });

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.runtime.db_version).toBe('PostgreSQL 15.4');
    });

    it('aggregates Postgres counts from each table', async () => {
        const { service } = build({
            dsHandler: dsRouter({
                organizations: 1,
                teams: 2,
                repositories: 9,
                activeUsers: 3,
            }),
        });

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.usage_7d.organizations).toBe(1);
        expect(metrics.usage_7d.teams).toBe(2);
        expect(metrics.usage_7d.repos_connected).toBe(9);
        expect(metrics.usage_7d.active_users).toBe(3);
    });

    it('counts PRs from the Mongo collection (last 7 days)', async () => {
        const { service, pullRequests } = build({
            dsHandler: dsRouter({}),
            pullRequests: 42,
        });

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.usage_7d.prs_reviewed).toBe(42);
        expect(pullRequests.countDocuments).toHaveBeenCalledWith(
            expect.objectContaining({
                updatedAt: expect.objectContaining({ $gte: expect.any(Date) }),
            }),
        );
    });

    it('reports kody_rules_enabled true when at least one document has rules', async () => {
        const { service } = build({ dsHandler: dsRouter({}), kodyRules: 1 });

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.config.kody_rules_enabled).toBe(true);
    });

    it('reports kody_rules_enabled false when none exist', async () => {
        const { service } = build({ dsHandler: dsRouter({}), kodyRules: 0 });

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.config.kody_rules_enabled).toBe(false);
    });

    it('normalises integrations to a closed enum and buckets unknowns as "other"', async () => {
        const { service } = build({
            dsHandler: dsRouter({
                integrations: ['github', 'slack', 'acme-custom-webhook'],
            }),
        });

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.config.integrations.sort()).toEqual(
            ['github', 'other', 'slack'].sort(),
        );
    });

    it('falls back to safe defaults when individual queries throw', async () => {
        const { service } = build({
            dsHandler: () => {
                throw new Error('postgres unavailable');
            },
            pullRequests: 0,
            kodyRules: 0,
        });

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.runtime.db_version).toBe('unknown');
        expect(metrics.usage_7d.organizations).toBe(0);
        expect(metrics.usage_7d.teams).toBe(0);
        expect(metrics.usage_7d.repos_connected).toBe(0);
        expect(metrics.usage_7d.active_users).toBe(0);
        expect(metrics.config.integrations).toEqual([]);
    });

    it('detects k8s deployment via KUBERNETES_SERVICE_HOST', async () => {
        const { service } = build({ dsHandler: dsRouter({}) });
        process.env.KUBERNETES_SERVICE_HOST = '10.0.0.1';

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.kodus.deployment).toBe('k8s');
    });

    it('falls back to "unknown" when no deployment hint is present', async () => {
        const { service } = build({ dsHandler: dsRouter({}) });
        delete process.env.KUBERNETES_SERVICE_HOST;
        // Tests run on the host filesystem — `/.dockerenv` should not exist.

        const metrics = await service.collect({ firstSeenAt: new Date() });

        expect(metrics.kodus.deployment).toBe('unknown');
    });
});
