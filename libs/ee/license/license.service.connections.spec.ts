import { createServer } from 'http';
import { AddressInfo } from 'net';

import { LicenseService } from './license.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

describe('LicenseService per Git connection', () => {
    const connection = {
        organizationId: 'org-1',
        teamId: 'team-1',
        integrationId: 'gl-b',
    };
    const workspace = { organizationId: 'org-1', teamId: 'team-1' };

    const makeService = () => {
        const get = jest.fn().mockResolvedValue({ valid: true });
        const post = jest
            .fn()
            .mockResolvedValue({ successful: [], failed: [] });
        const service = new LicenseService();
        (service as any).licenseRequest = { get, post };
        return { service, get, post };
    };

    it('validates the licence of the connection the call is routed to', async () => {
        const { service, get } = makeService();

        await service.validateOrganizationLicense(connection);

        expect(get).toHaveBeenCalledWith('validate-org-license', {
            params: {
                organizationId: 'org-1',
                teamId: 'team-1',
                connectionId: 'gl-b',
            },
        });
    });

    it('keeps the workspace call unchanged when no connection is named', async () => {
        const { service, get } = makeService();

        await service.validateOrganizationLicense(workspace);

        expect(get).toHaveBeenCalledWith('validate-org-license', {
            params: { organizationId: 'org-1', teamId: 'team-1' },
        });
    });

    it('lists, assigns and releases the seats of the named connection', async () => {
        const { service, get, post } = makeService();
        get.mockResolvedValue([]);

        await service.getAllUsersWithLicense(connection);
        await service.assignLicense(connection, '42', 'gitlab');
        await service.unassignLicenses(connection, ['42'], 'gitlab');

        expect(get).toHaveBeenCalledWith('users-with-license', {
            params: expect.objectContaining({ connectionId: 'gl-b' }),
        });
        expect(post).toHaveBeenNthCalledWith(
            1,
            'assign-license',
            expect.objectContaining({ connectionId: 'gl-b' }),
        );
        expect(post).toHaveBeenNthCalledWith(
            2,
            'assign-license',
            expect.objectContaining({ connectionId: 'gl-b' }),
        );
    });

    it("binds the workspace primary connection and answers billing's primary", async () => {
        const { service, post } = makeService();
        post.mockResolvedValue({ found: true, primaryConnectionId: 'gh-a' });

        await expect(
            service.bindPrimaryConnection(workspace, 'gh-a'),
        ).resolves.toEqual({
            ok: true,
            licensed: true,
            primaryConnectionId: 'gh-a',
        });
        expect(post).toHaveBeenCalledWith('connections/primary', {
            organizationId: 'org-1',
            teamId: 'team-1',
            connectionId: 'gh-a',
        });
    });

    it('answers the primary billing kept when it would not bind the connection', async () => {
        const { service, post } = makeService();
        post.mockResolvedValue({ found: true, primaryConnectionId: null });

        await expect(
            service.bindPrimaryConnection(workspace, 'gl-b'),
        ).resolves.toEqual({
            ok: true,
            licensed: true,
            primaryConnectionId: null,
        });
    });

    it('reports a failed bind, so a second connection is not added on an unbound workspace', async () => {
        const { service, post } = makeService();
        post.mockRejectedValue(new Error('billing down'));

        await expect(
            service.bindPrimaryConnection(workspace, 'gh-a'),
        ).resolves.toEqual({ ok: false });
    });

    it('treats a workspace billing has no licence for as nothing to bind', async () => {
        const { service, post } = makeService();
        post.mockRejectedValue({
            response: { status: 404, data: { error: 'LICENSE_NOT_FOUND' } },
        });

        await expect(
            service.bindPrimaryConnection(workspace, 'gh-a'),
        ).resolves.toEqual({ ok: true, licensed: false });
    });

    it('treats a billing service without the bind route as a failed bind', async () => {
        const { service, post } = makeService();
        post.mockRejectedValue({
            response: {
                status: 404,
                data: 'Cannot POST /api/billing/connections/primary',
            },
        });

        await expect(
            service.bindPrimaryConnection(workspace, 'gh-a'),
        ).resolves.toEqual({ ok: false });
    });

    it('tells a release that freed the slot, one with nothing to free, and one billing never answered', async () => {
        const { service, post } = makeService();

        post.mockResolvedValueOnce({ released: true });
        await expect(
            service.releaseConnection(workspace, 'gh-a'),
        ).resolves.toBe('released');

        post.mockResolvedValueOnce({ released: false });
        await expect(
            service.releaseConnection(workspace, 'gh-a'),
        ).resolves.toBe('not_held');

        post.mockRejectedValueOnce(new Error('billing down'));
        await expect(
            service.releaseConnection(workspace, 'gh-a'),
        ).resolves.toBe('failed');
    });

    it('reads the workspace primary and the connections billed on their own licence', async () => {
        const { service, get } = makeService();
        get.mockResolvedValue({
            primaryConnectionId: 'gh-a',
            // A licence row left by a failed seat call or an abandoned
            // checkout holds no subscription: that connection can still
            // take the workspace plan.
            connections: [
                { connectionId: 'gl-b', ownSubscription: true },
                { connectionId: 'fj-c', ownSubscription: false },
            ],
        });

        await expect(service.getConnectionLicenses(workspace)).resolves.toEqual(
            {
                primaryConnectionId: 'gh-a',
                ownLicenceConnectionIds: ['gl-b'],
            },
        );
        expect(get).toHaveBeenCalledWith('connections', {
            params: { organizationId: 'org-1', teamId: 'team-1' },
        });

        get.mockRejectedValue(new Error('billing down'));
        await expect(
            service.getConnectionLicenses(workspace),
        ).resolves.toBeNull();
    });

    it('gives up on a billing that does not answer within the call’s own timeout, answering unreadable', async () => {
        // A billing that accepts the request and never answers.
        const server = createServer(() => undefined);
        await new Promise<void>((resolve) =>
            server.listen(0, '127.0.0.1', resolve),
        );
        const { port } = server.address() as AddressInfo;
        const previous = process.env.GLOBAL_KODUS_SERVICE_BILLING;
        process.env.GLOBAL_KODUS_SERVICE_BILLING = `http://127.0.0.1:${port}`;
        try {
            const service = new LicenseService();
            const started = Date.now();

            await expect(
                service.getConnectionLicenses(workspace, { timeoutMs: 100 }),
            ).resolves.toBeNull();
            expect(Date.now() - started).toBeLessThan(2000);
        } finally {
            process.env.GLOBAL_KODUS_SERVICE_BILLING = previous;
            server.closeAllConnections();
            await new Promise((resolve) => server.close(resolve));
        }
    });

    it('answers unreadable when billing does not say whether a connection has its own subscription', async () => {
        const { service, get } = makeService();
        // A billing that predates the flag.
        get.mockResolvedValue({
            primaryConnectionId: null,
            connections: [
                { connectionId: 'gl-b', ownSubscription: true },
                { connectionId: 'az-d' },
            ],
        });

        await expect(
            service.getConnectionLicenses(workspace),
        ).resolves.toBeNull();

        // A subscription billing cannot tie to a connection.
        get.mockResolvedValue({
            primaryConnectionId: null,
            connections: [{ ownSubscription: true }],
        });
        await expect(
            service.getConnectionLicenses(workspace),
        ).resolves.toBeNull();
    });
});
