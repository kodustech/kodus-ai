import { ConfigService } from '@nestjs/config';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const repository = { id: '42', name: 'api', owner: 'acme' };
const SHA = 'c'.repeat(40);

function build(rest: Record<string, jest.Mock>): GithubService {
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
    (service as any).instanceOctokit = jest
        .fn()
        .mockResolvedValue({ rest: { repos: rest } });
    return service;
}

const notFound = () =>
    jest
        .fn()
        .mockRejectedValue(
            Object.assign(new Error('Not Found'), { status: 404 }),
        );

describe('GithubService.getDefaultBranchHead', () => {
    it('reads the default branch, then the SHA at its head', async () => {
        const get = jest
            .fn()
            .mockResolvedValue({ data: { default_branch: 'trunk' } });
        const getBranch = jest
            .fn()
            .mockResolvedValue({ data: { commit: { sha: SHA } } });
        await expect(
            build({ get, getBranch }).getDefaultBranchHead({
                organizationAndTeamData,
                repository,
            }),
        ).resolves.toEqual({ branch: 'trunk', sha: SHA });
        expect(getBranch).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'api',
            branch: 'trunk',
        });
    });

    it('is null for a missing repo or an empty one, and rethrows anything else', async () => {
        await expect(
            build({
                get: notFound(),
                getBranch: jest.fn(),
            }).getDefaultBranchHead({ organizationAndTeamData, repository }),
        ).resolves.toBeNull();
        const get = jest
            .fn()
            .mockResolvedValue({ data: { default_branch: 'main' } });
        await expect(
            build({ get, getBranch: notFound() }).getDefaultBranchHead({
                organizationAndTeamData,
                repository,
            }),
        ).resolves.toBeNull();
        const failing = jest
            .fn()
            .mockRejectedValue(
                Object.assign(new Error('boom'), { status: 502 }),
            );
        await expect(
            build({ get: failing, getBranch: jest.fn() }).getDefaultBranchHead({
                organizationAndTeamData,
                repository,
            }),
        ).rejects.toThrow('boom');
    });
});

describe('GithubService.getFileContentAtRef', () => {
    const read = (getContent: jest.Mock, maxBytes = 1_024) =>
        build({ getContent }).getFileContentAtRef({
            organizationAndTeamData,
            repository,
            path: '.kodus/workspace.yaml',
            ref: SHA,
            maxBytes,
        });

    it('reads the file at the exact commit and decodes it', async () => {
        const getContent = jest.fn().mockResolvedValue({
            data: {
                type: 'file',
                size: 11,
                encoding: 'base64',
                content: Buffer.from('version: 1\n').toString('base64'),
            },
        });
        await expect(read(getContent)).resolves.toBe('version: 1\n');
        expect(getContent).toHaveBeenCalledWith({
            owner: 'acme',
            repo: 'api',
            path: '.kodus/workspace.yaml',
            ref: SHA,
        });
    });

    it('is null when the file is not there or is a directory', async () => {
        await expect(read(notFound())).resolves.toBeNull();
        await expect(
            read(jest.fn().mockResolvedValue({ data: [] })),
        ).resolves.toBeNull();
    });

    it('refuses a file larger than asked instead of truncating it', async () => {
        const getContent = jest
            .fn()
            .mockResolvedValue({
                data: {
                    type: 'file',
                    size: 4_096,
                    encoding: 'base64',
                    content: '',
                },
            });
        await expect(read(getContent, 1_024)).rejects.toThrow('more than 1024');
    });
});
