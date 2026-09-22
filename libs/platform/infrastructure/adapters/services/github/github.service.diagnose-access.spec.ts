import { ConfigService } from '@nestjs/config';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const WEBHOOK = 'https://api.acme.dev/github/webhook';
const organizationAndTeamData = { organizationId: 'org-1', teamId: 'team-1' };
const repository = { id: '42', name: 'api', fullName: 'acme/api' };

function httpError(status: number, message = 'nope') {
    return Object.assign(new Error(message), { status });
}

function build(opts: {
    authMode: AuthMode;
    octokit: Record<string, any>;
}): GithubService {
    const service = new GithubService(
        {} as any,
        {} as any,
        {} as any,
        {} as any,
        {
            get: jest.fn((key: string) =>
                key === 'API_GITHUB_CODE_MANAGEMENT_WEBHOOK'
                    ? WEBHOOK
                    : undefined,
            ),
        } as unknown as ConfigService,
    );
    jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
        authMode: opts.authMode,
        org: 'acme',
        accountType: 'organization',
    } as any);
    (service as any).instanceOctokit = jest
        .fn()
        .mockResolvedValue(opts.octokit);
    return service;
}

function octokit(
    over: {
        listCommits?: jest.Mock;
        get?: jest.Mock;
        listWebhooks?: jest.Mock;
    } = {},
) {
    const listWebhooks =
        over.listWebhooks ??
        jest.fn().mockResolvedValue({
            data: [{ active: true, config: { url: WEBHOOK } }],
        });
    return {
        rest: {
            repos: {
                listCommits:
                    over.listCommits ??
                    jest.fn().mockResolvedValue({ data: [{}] }),
                get:
                    over.get ??
                    jest.fn().mockResolvedValue({
                        data: { private: true },
                        headers: { 'x-oauth-scopes': 'repo, read:org' },
                    }),
            },
        },
        repos: { listWebhooks },
    };
}

describe('GithubService.diagnoseRepositoryAccess', () => {
    it('PAT with push and our hook → all ok', async () => {
        const service = build({ authMode: AuthMode.TOKEN, octokit: octokit() });
        await expect(
            service.diagnoseRepositoryAccess({
                organizationAndTeamData,
                repository,
            }),
        ).resolves.toEqual({ read: 'ok', write: 'ok', hook: 'present' });
    });

    it('classic PAT without the repo scope on a private repo → write denied', async () => {
        const service = build({
            authMode: AuthMode.TOKEN,
            octokit: octokit({
                get: jest.fn().mockResolvedValue({
                    data: { private: true },
                    headers: { 'x-oauth-scopes': 'public_repo, read:org' },
                }),
            }),
        });
        const d = await service.diagnoseRepositoryAccess({
            organizationAndTeamData,
            repository,
        });
        expect(d.write).toBe('denied');
    });

    it('fine-grained PAT (no scopes header) → write unknown, never denied', async () => {
        const service = build({
            authMode: AuthMode.TOKEN,
            octokit: octokit({
                get: jest.fn().mockResolvedValue({
                    data: {
                        private: true,
                        permissions: { pull: true, push: false },
                    },
                    headers: {},
                }),
            }),
        });
        const d = await service.diagnoseRepositoryAccess({
            organizationAndTeamData,
            repository,
        });
        expect(d.write).toBe('unknown');
    });

    it('404 on commits → read denied, with the status in the error', async () => {
        const service = build({
            authMode: AuthMode.TOKEN,
            octokit: octokit({
                listCommits: jest
                    .fn()
                    .mockRejectedValue(httpError(404, 'Not Found')),
            }),
        });
        const d = await service.diagnoseRepositoryAccess({
            organizationAndTeamData,
            repository,
        });
        expect(d.read).toBe('denied');
        expect(d.error).toBe('404 Not Found');
    });

    it('hook pointing elsewhere → missing', async () => {
        const service = build({
            authMode: AuthMode.TOKEN,
            octokit: octokit({
                listWebhooks: jest.fn().mockResolvedValue({
                    data: [
                        {
                            active: true,
                            config: {
                                url: 'https://old.example/github/webhook',
                            },
                        },
                    ],
                }),
            }),
        });
        const d = await service.diagnoseRepositoryAccess({
            organizationAndTeamData,
            repository,
        });
        expect(d.hook).toBe('missing');
    });

    it('cannot list hooks (no admin) → hook unknown, not missing', async () => {
        const service = build({
            authMode: AuthMode.TOKEN,
            octokit: octokit({
                listWebhooks: jest.fn().mockRejectedValue(httpError(403)),
            }),
        });
        const d = await service.diagnoseRepositoryAccess({
            organizationAndTeamData,
            repository,
        });
        expect(d.hook).toBe('unknown');
    });

    it('GitHub App install → write from the installation permissions', async () => {
        const service = build({
            authMode: AuthMode.OAUTH,
            octokit: octokit({
                get: jest.fn().mockResolvedValue({ data: {}, headers: {} }),
            }),
        });
        jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
            authMode: AuthMode.OAUTH,
            org: 'acme',
            accountType: 'organization',
            installationId: '99',
        } as any);
        const getInstallation = jest.fn();
        (service as any).getInstallationAuthentication = getInstallation;

        getInstallation.mockResolvedValue({
            token: 't',
            permissions: { pull_requests: 'write' },
        });
        await expect(
            service.diagnoseRepositoryAccess({
                organizationAndTeamData,
                repository,
            }),
        ).resolves.toMatchObject({ write: 'ok', hook: 'app-level' });

        getInstallation.mockResolvedValue({
            token: 't',
            permissions: { pull_requests: 'read' },
        });
        await expect(
            service.diagnoseRepositoryAccess({
                organizationAndTeamData,
                repository,
            }),
        ).resolves.toMatchObject({ write: 'denied' });
    });

    it('GitHub App install without installation details → app-level hook, write unknown', async () => {
        const listWebhooks = jest.fn();
        const service = build({
            authMode: AuthMode.OAUTH,
            octokit: octokit({
                listWebhooks,
                get: jest.fn().mockResolvedValue({ data: {}, headers: {} }),
            }),
        });
        const d = await service.diagnoseRepositoryAccess({
            organizationAndTeamData,
            repository,
        });
        expect(d).toMatchObject({
            read: 'ok',
            write: 'unknown',
            hook: 'app-level',
        });
        expect(listWebhooks).not.toHaveBeenCalled();
    });

    it('never throws when the client cannot be built', async () => {
        const service = build({ authMode: AuthMode.TOKEN, octokit: octokit() });
        (service as any).instanceOctokit = jest
            .fn()
            .mockRejectedValue(new Error('Instalation not found'));
        await expect(
            service.diagnoseRepositoryAccess({
                organizationAndTeamData,
                repository,
            }),
        ).resolves.toMatchObject({
            read: 'unknown',
            error: 'Instalation not found',
        });
    });
});
