import { ConfigService } from '@nestjs/config';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const repository = { id: '42', name: 'api', owner: 'acme' };

function build(getCollaboratorPermissionLevel: jest.Mock): GithubService {
    const service = new GithubService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        { get: jest.fn() } as unknown as ConfigService,
    );
    jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
        authMode: AuthMode.OAUTH,
        org: 'acme',
        accountType: 'organization',
    } as any);
    (service as any).instanceOctokit = jest.fn().mockResolvedValue({
        rest: { repos: { getCollaboratorPermissionLevel } },
    });
    return service;
}

const answering = (permission: string) =>
    jest.fn().mockResolvedValue({ data: { permission } });

describe('GithubService.userCanWrite', () => {
    it('reads the permission on the repository, by login', async () => {
        const lookup = answering('write');
        await expect(
            build(lookup).userCanWrite({
                organizationAndTeamData,
                repository,
                login: 'nina',
            }),
        ).resolves.toBe(true);
        expect(lookup).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'api',
            username: 'nina',
        });
    });

    it('counts admin and write, not read or none', async () => {
        const can = (permission: string) =>
            build(answering(permission)).userCanWrite({
                organizationAndTeamData,
                repository,
                login: 'nina',
            });
        await expect(can('admin')).resolves.toBe(true);
        await expect(can('write')).resolves.toBe(true);
        // A read-only collaborator, and triage, which GitHub folds into read.
        await expect(can('read')).resolves.toBe(false);
        await expect(can('none')).resolves.toBe(false);
    });

    it("can't say when the lookup fails: the credential couldn't look, not a no", async () => {
        const failing = (status: number) =>
            build(
                jest
                    .fn()
                    .mockRejectedValue(
                        Object.assign(new Error('nope'), { status }),
                    ),
            ).userCanWrite({
                organizationAndTeamData,
                repository,
                login: 'nina',
            });
        // Someone who isn't a collaborator answers 200 with `none`.
        await expect(failing(404)).resolves.toBeUndefined();
        await expect(failing(403)).resolves.toBeUndefined();
        await expect(failing(502)).resolves.toBeUndefined();
    });

    it('logs why it could not say, with the repository and the user', async () => {
        const service = build(
            jest.fn().mockRejectedValue(
                Object.assign(new Error('Resource not accessible'), {
                    status: 403,
                }),
            ),
        );
        const warn = jest
            .spyOn((service as any).logger, 'warn')
            .mockImplementation(() => undefined);

        await service.userCanWrite({
            organizationAndTeamData,
            repository,
            login: 'nina',
        });

        expect(warn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    repositoryId: '42',
                    login: 'nina',
                    reason: expect.stringContaining('403'),
                }),
            }),
        );
    });

    it('cannot say without a login', async () => {
        const lookup = answering('admin');
        await expect(
            build(lookup).userCanWrite({ organizationAndTeamData, repository }),
        ).resolves.toBeUndefined();
        expect(lookup).not.toHaveBeenCalled();
    });
});
