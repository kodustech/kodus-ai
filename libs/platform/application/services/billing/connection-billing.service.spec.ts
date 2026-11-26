import { ConnectionBillingService } from './connection-billing.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const workspace = { organizationId: 'org-1', teamId: 'team-1' };

const connection = (uuid: string, createdAt: string) => ({
    uuid,
    createdAt: new Date(createdAt),
});

const make = (opts: {
    connections: Array<{ uuid: string; createdAt: Date }>;
    primaryConnectionId?: string | null;
    ownLicenceConnectionIds?: string[];
    read?: 'fail';
}) => {
    let primary = opts.primaryConnectionId ?? null;
    const own = new Set(opts.ownLicenceConnectionIds ?? []);
    const integrationService = {
        find: jest.fn().mockResolvedValue(opts.connections),
    };
    const licenseService = {
        getConnectionLicenses: jest.fn(async () =>
            opts.read === 'fail'
                ? null
                : {
                      primaryConnectionId: primary,
                      ownLicenceConnectionIds: [...own],
                  },
        ),
        releaseConnection: jest.fn(async (_w, id: string) => {
            if (primary !== id) return 'not_held';
            primary = null;
            return 'released';
        }),
        bindPrimaryConnection: jest.fn(async (_w, id: string) => {
            if (primary == null && !own.has(id)) primary = id;
            return { ok: true, licensed: true, primaryConnectionId: primary };
        }),
        attributeLegacySeats: jest.fn(async () => undefined),
    };
    const service = new ConnectionBillingService(
        integrationService as any,
        licenseService as any,
    );
    return { service, licenseService, integrationService };
};

describe('ConnectionBillingService.ensurePrimary', () => {
    const a = connection('gh-a', '2026-01-01');
    const b = connection('gl-b', '2026-02-01');
    const c = connection('bb-c', '2026-03-01');

    it('keeps a live primary as it is, writing nothing', async () => {
        const { service, licenseService } = make({
            connections: [a, b],
            primaryConnectionId: 'gh-a',
        });

        await expect(service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'bound',
            primaryConnectionId: 'gh-a',
        });
        expect(licenseService.releaseConnection).not.toHaveBeenCalled();
        expect(licenseService.bindPrimaryConnection).not.toHaveBeenCalled();
    });

    it('frees a primary that left the workspace and binds the oldest live connection', async () => {
        const { service, licenseService } = make({
            connections: [b, c],
            primaryConnectionId: 'gone',
        });

        await expect(service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'bound',
            primaryConnectionId: 'gl-b',
        });
        expect(licenseService.releaseConnection).toHaveBeenCalledWith(
            workspace,
            'gone',
        );
    });

    it('skips a connection billed on its own licence when picking the next primary', async () => {
        const { service } = make({
            connections: [b, c],
            ownLicenceConnectionIds: ['gl-b'],
        });

        await expect(service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'bound',
            primaryConnectionId: 'bb-c',
        });
    });

    it('binds nothing for a single connection, which reads the workspace licence while none is named', async () => {
        const { service, licenseService } = make({
            connections: [b],
            primaryConnectionId: 'gone',
        });

        await expect(service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'unbound',
        });
        expect(licenseService.releaseConnection).toHaveBeenCalledWith(
            workspace,
            'gone',
        );
        expect(licenseService.bindPrimaryConnection).not.toHaveBeenCalled();
    });

    it('binds the existing connection before another is added', async () => {
        const { service } = make({ connections: [a] });

        await expect(
            service.ensurePrimary(workspace, { beforeAddingConnection: true }),
        ).resolves.toEqual({ status: 'bound', primaryConnectionId: 'gh-a' });
    });

    it('leaves the workspace unbound when every connection has its own licence', async () => {
        const { service } = make({
            connections: [a, b],
            ownLicenceConnectionIds: ['gh-a', 'gl-b'],
        });

        await expect(service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'unbound',
        });
    });

    it('answers unbound when billing has no licence for the workspace', async () => {
        const { service, licenseService } = make({ connections: [a, b] });
        licenseService.bindPrimaryConnection.mockResolvedValue({
            ok: true,
            licensed: false,
        });

        await expect(service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'unbound',
        });
    });

    it('fails, changing nothing further, when billing cannot be read, released or bound', async () => {
        const unreadable = make({ connections: [a, b], read: 'fail' });
        await expect(
            unreadable.service.ensurePrimary(workspace),
        ).resolves.toEqual({ status: 'failed' });
        expect(
            unreadable.licenseService.bindPrimaryConnection,
        ).not.toHaveBeenCalled();

        const stuck = make({
            connections: [a, b],
            primaryConnectionId: 'gone',
        });
        stuck.licenseService.releaseConnection.mockResolvedValue('failed');
        await expect(stuck.service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'failed',
        });
        expect(
            stuck.licenseService.bindPrimaryConnection,
        ).not.toHaveBeenCalled();

        const down = make({ connections: [a, b] });
        down.licenseService.bindPrimaryConnection.mockResolvedValue({
            ok: false,
        });
        await expect(down.service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'failed',
        });
    });

    it('accepts a live primary another request bound meanwhile', async () => {
        const { service, licenseService } = make({ connections: [a, b] });
        licenseService.bindPrimaryConnection.mockResolvedValue({
            ok: true,
            licensed: true,
            primaryConnectionId: 'gl-b',
        });

        await expect(service.ensurePrimary(workspace)).resolves.toEqual({
            status: 'bound',
            primaryConnectionId: 'gl-b',
        });
    });
});

describe('ConnectionBillingService.releaseBeforeRemoving', () => {
    it('lets a removal go ahead once billing freed the slot or the connection held none', async () => {
        const { service, licenseService } = make({
            connections: [],
            primaryConnectionId: 'gh-a',
        });

        await expect(
            service.releaseBeforeRemoving(workspace, 'gh-a'),
        ).resolves.toBe(true);
        await expect(
            service.releaseBeforeRemoving(workspace, 'gl-b'),
        ).resolves.toBe(true);

        licenseService.releaseConnection.mockResolvedValue('failed');
        await expect(
            service.releaseBeforeRemoving(workspace, 'gh-a'),
        ).resolves.toBe(false);
    });
});

describe('ConnectionBillingService.workspaceConnections', () => {
    it("lists the workspace's active Git connections, oldest first", async () => {
        const { service, integrationService } = make({
            connections: [
                connection('new', '2026-05-01'),
                connection('old', '2026-01-01'),
            ],
        });

        const listed = await service.workspaceConnections(workspace);

        expect(listed.map((c) => c.uuid)).toEqual(['old', 'new']);
        expect(integrationService.find).toHaveBeenCalledWith({
            organization: { uuid: 'org-1' },
            team: { uuid: 'team-1' },
            integrationCategory: 'CODE_MANAGEMENT',
            status: true,
        });
    });
});

describe('ConnectionBillingService.attributeLegacySeatsBeforeAdding', () => {
    const one = [{ uuid: 'gl-a', platform: 'GITLAB', createdAt: new Date() }];

    it("records the seats from before connections as the organization's only connection's", async () => {
        const { service, licenseService, integrationService } = make({
            connections: one as any,
        });

        await service.attributeLegacySeatsBeforeAdding(workspace);

        expect(integrationService.find).toHaveBeenCalledWith({
            organization: { uuid: 'org-1' },
            integrationCategory: 'CODE_MANAGEMENT',
            status: true,
        });
        expect(licenseService.attributeLegacySeats).toHaveBeenCalledWith(
            workspace,
            { uuid: 'gl-a', platform: 'GITLAB' },
        );
    });

    it('attributes nothing when the organization has no connection, or already several', async () => {
        const none = make({ connections: [] });
        await none.service.attributeLegacySeatsBeforeAdding(workspace);

        const several = make({
            connections: [
                { uuid: 'a', createdAt: new Date() },
                { uuid: 'b', createdAt: new Date() },
            ],
        });
        await several.service.attributeLegacySeatsBeforeAdding(workspace);

        expect(none.licenseService.attributeLegacySeats).not.toHaveBeenCalled();
        expect(
            several.licenseService.attributeLegacySeats,
        ).not.toHaveBeenCalled();
    });

    it('never blocks adding a connection when the seats cannot be attributed', async () => {
        const { service, licenseService } = make({ connections: one as any });
        licenseService.attributeLegacySeats.mockRejectedValue(new Error('db'));

        await expect(
            service.attributeLegacySeatsBeforeAdding(workspace),
        ).resolves.toBeUndefined();
    });
});
