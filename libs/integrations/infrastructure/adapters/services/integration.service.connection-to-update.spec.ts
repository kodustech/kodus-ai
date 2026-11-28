import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { AmbiguousConnectionException } from '@libs/integrations/domain/integrations/errors/ambiguous-connection.exception';

import { IntegrationService } from './integration.service';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ log: jest.fn(), warn: jest.fn(), error: jest.fn() }),
}));

const workspace = { organizationId: 'org-1', teamId: 'team-1' };
const scope = {
    organization: { uuid: 'org-1' },
    team: { uuid: 'team-1' },
    platform: PlatformType.GITLAB,
};

const build = (rows: Array<{ uuid: string; status: boolean }>) => {
    const repository = {
        find: jest.fn().mockResolvedValue(rows),
        findOne: jest.fn(async (filter: { uuid?: string }) =>
            rows.find((row) => row.uuid === filter.uuid),
        ),
    };
    return {
        service: new IntegrationService(repository as any, {} as any),
        repository,
    };
};

describe('IntegrationService.connectionToUpdate', () => {
    it('answers the named connection', async () => {
        const { service, repository } = build([
            { uuid: 'gl-a', status: true },
            { uuid: 'gl-b', status: true },
        ]);

        await expect(
            service.connectionToUpdate(
                { ...workspace, integrationId: 'gl-b' },
                PlatformType.GITLAB,
            ),
        ).resolves.toEqual({ uuid: 'gl-b', status: true });
        expect(repository.findOne).toHaveBeenCalledWith({
            ...scope,
            uuid: 'gl-b',
        });
    });

    it('answers none when the caller adds a new connection', async () => {
        const { service, repository } = build([{ uuid: 'gl-a', status: true }]);

        await expect(
            service.connectionToUpdate(workspace, PlatformType.GITLAB, true),
        ).resolves.toBeUndefined();
        expect(repository.find).not.toHaveBeenCalled();
    });

    it("answers the workspace's only active connection of the platform, else its oldest inactive one", async () => {
        const one = build([
            { uuid: 'gl-old', status: false },
            { uuid: 'gl-a', status: true },
        ]);
        await expect(
            one.service.connectionToUpdate(workspace, PlatformType.GITLAB),
        ).resolves.toEqual({ uuid: 'gl-a', status: true });
        expect(one.repository.find).toHaveBeenCalledWith(scope);

        const none = build([{ uuid: 'gl-old', status: false }]);
        await expect(
            none.service.connectionToUpdate(workspace, PlatformType.GITLAB),
        ).resolves.toEqual({ uuid: 'gl-old', status: false });
    });

    it('refuses to pick one of several active connections when none is named, instead of rewriting the oldest', async () => {
        const { service } = build([
            { uuid: 'gl-self-hosted', status: true },
            { uuid: 'gl-com', status: true },
        ]);

        await expect(
            service.connectionToUpdate(workspace, PlatformType.GITLAB),
        ).rejects.toBeInstanceOf(AmbiguousConnectionException);
    });
});
