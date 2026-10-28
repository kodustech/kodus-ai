import { Gitlab } from '@gitbeaker/rest';
import { ConfigService } from '@nestjs/config';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GitlabService } from '../gitlab.service';

jest.mock('@gitbeaker/rest', () => ({
    Gitlab: jest.fn(),
}));
jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const mockedGitlab = Gitlab as unknown as jest.Mock;
const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };

function build(show: jest.Mock): GitlabService {
    mockedGitlab.mockReturnValue({ ProjectMembers: { show } });
    const service = new GitlabService(
        { findOne: jest.fn() } as any,
        {} as any,
        {} as any,
        { get: jest.fn() } as unknown as ConfigService,
        {} as any,
    );
    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
        accessToken: 'oauth-token',
        authMode: AuthMode.OAUTH,
        host: 'https://gitlab.example.com',
    });
    return service;
}

const canWrite = (show: jest.Mock) =>
    build(show).userCanWrite({
        organizationAndTeamData,
        repository: { id: '42' },
        userId: 7,
    });

const failing = (status: number) =>
    jest
        .fn()
        .mockRejectedValue(
            Object.assign(new Error('nope'), {
                cause: { response: { status } },
            }),
        );

describe('GitlabService.userCanWrite', () => {
    it('counts Developer and above, inherited from the group too', async () => {
        const show = jest.fn().mockResolvedValue({ access_level: 30 });
        await expect(canWrite(show)).resolves.toBe(true);
        expect(show).toHaveBeenCalledWith('42', 7, { includeInherited: true });
        await expect(
            canWrite(jest.fn().mockResolvedValue({ access_level: 20 })),
        ).resolves.toBe(false);
    });

    it('is a no for someone who is not a member (404)', async () => {
        await expect(canWrite(failing(404))).resolves.toBe(false);
    });

    it("can't say when the credential can't look (401/403) or GitLab fails", async () => {
        await expect(canWrite(failing(401))).resolves.toBeUndefined();
        await expect(canWrite(failing(403))).resolves.toBeUndefined();
        await expect(canWrite(failing(502))).resolves.toBeUndefined();
    });
});
