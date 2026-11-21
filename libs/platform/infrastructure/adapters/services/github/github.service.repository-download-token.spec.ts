// See github.service.cache.spec.ts: environment.ts only exists after the Docker build.
jest.mock(
    '../../../../../ee/configs/environment/environment',
    () => ({ environment: {} }),
    { virtual: true },
);

import { ConfigService } from '@nestjs/config';

import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';

import { GithubService } from './github.service';
import { devPatDownloadAllowed } from './repository-download-token';
import {
    downloadTokenProblem,
    RepositoryDownloadTokenError,
} from './repository-download-token';

const org = { organizationId: 'org-1', teamId: 'team-1' };
const TOKEN = 'ghs_fake_download_token';
const EXPIRES = '2026-10-30T13:00:00Z';

const narrow = (overrides: Record<string, unknown> = {}) => ({
    token: TOKEN,
    expires_at: EXPIRES,
    permissions: { contents: 'read', metadata: 'read' },
    repository_selection: 'selected',
    repositories: [{ id: 123456, full_name: 'acme/widgets' }],
    ...overrides,
});

function makeService(opts: {
    authDetail?: Record<string, unknown>;
    response?: Record<string, unknown>;
}) {
    const cacheService = {
        getFromCache: jest.fn(),
        addToCache: jest.fn(),
        removeFromCache: jest.fn(),
        clearCache: jest.fn(),
        cacheExists: jest.fn(),
        getMultipleFromCache: jest.fn(),
        deleteByKeyPattern: jest.fn(),
    };
    const service = new GithubService(
        { findOne: jest.fn() } as any,
        {} as any,
        { createOrUpdateConfig: jest.fn() } as any,
        cacheService as any,
        { get: jest.fn() } as unknown as ConfigService,
    );
    jest.spyOn(service, 'getGithubAuthDetails').mockResolvedValue({
        authToken: '',
        org: 'acme',
        authMode: AuthMode.OAUTH,
        installationId: '987',
        ...opts.authDetail,
    } as any);
    const request = jest
        .fn()
        .mockResolvedValue({ status: 201, data: opts.response ?? narrow() });
    const createOctokit = jest
        .spyOn(service as any, 'createOctokitInstance')
        .mockReturnValue({ request });
    const revoke = jest
        .spyOn(service as any, 'revokeInstallationToken')
        .mockResolvedValue(undefined);
    const installationAuth = jest.spyOn(
        service as any,
        'getInstallationAuthentication',
    );
    return {
        service,
        cacheService,
        request,
        createOctokit,
        revoke,
        installationAuth,
    };
}

function expectCacheUntouched(t: ReturnType<typeof makeService>) {
    expect(t.cacheService.getFromCache).not.toHaveBeenCalled();
    expect(t.cacheService.addToCache).not.toHaveBeenCalled();
    expect(t.cacheService.removeFromCache).not.toHaveBeenCalled();
    expect(t.installationAuth).not.toHaveBeenCalled();
}

describe('GithubService.issueRepositoryDownloadToken', () => {
    it('asks the app for one repository with contents:read only, outside the installation-token cache', async () => {
        const t = makeService({});

        const out = await t.service.issueRepositoryDownloadToken({
            organizationAndTeamData: org,
            repositoryId: '123456',
        });

        expect(out).toEqual({ token: TOKEN, expiresAt: EXPIRES });
        expect(t.request).toHaveBeenCalledTimes(1);
        const [route, body] = t.request.mock.calls[0];
        expect(route).toBe(
            'POST /app/installations/{installation_id}/access_tokens',
        );
        expect(body).toEqual({
            installation_id: 987,
            repository_ids: [123456],
            permissions: { contents: 'read' },
        });
        expect(body.repository_ids).toHaveLength(1);
        expect(body).not.toHaveProperty('repositories');
        expectCacheUntouched(t);
        expect(t.revoke).not.toHaveBeenCalled();
    });

    it('refuses PAT (token) auth: a personal token cannot be scoped to one repository', async () => {
        const t = makeService({
            authDetail: { authMode: AuthMode.TOKEN, installationId: undefined },
        });

        await expect(
            t.service.issueRepositoryDownloadToken({
                organizationAndTeamData: org,
                repositoryId: '123456',
            }),
        ).rejects.toMatchObject({ reason: 'unsupported_auth' });
        expect(t.createOctokit).not.toHaveBeenCalled();
        expectCacheUntouched(t);
    });

    it('refuses an app integration without installation id and a non-numeric repository id', async () => {
        const noInstall = makeService({ authDetail: { installationId: '' } });
        await expect(
            noInstall.service.issueRepositoryDownloadToken({
                organizationAndTeamData: org,
                repositoryId: '123456',
            }),
        ).rejects.toMatchObject({ reason: 'no_installation' });

        const badId = makeService({});
        await expect(
            badId.service.issueRepositoryDownloadToken({
                organizationAndTeamData: org,
                repositoryId: 'acme/widgets',
            }),
        ).rejects.toMatchObject({ reason: 'invalid_repository_id' });
        expect(badId.request).not.toHaveBeenCalled();
    });

    it.each([
        ['an extra permission', narrow({ permissions: { contents: 'read', pull_requests: 'write' } })],
        ['contents:write', narrow({ permissions: { contents: 'write' } })],
        ['a second repository', narrow({ repositories: [{ id: 123456 }, { id: 7 }] })],
        ['another repository', narrow({ repositories: [{ id: 7 }] })],
        ['all repositories', narrow({ repository_selection: 'all', repositories: undefined })],
    ])('refuses and revokes a widened response (%s) and never returns the token', async (_label, response) => {
        const t = makeService({ response });

        const error = await t.service
            .issueRepositoryDownloadToken({
                organizationAndTeamData: org,
                repositoryId: '123456',
            })
            .catch((e) => e);

        expect(error).toBeInstanceOf(RepositoryDownloadTokenError);
        expect(error.reason).toBe('unexpected_scope');
        expect(String(error.message)).not.toContain(TOKEN);
        expect(t.revoke).toHaveBeenCalledWith(TOKEN);
        expectCacheUntouched(t);
    });
});

// GitHub's answer to the mint itself: a removed or suspended App is a refusal an
// admin fixes (the trigger answers it), anything else may pass and is retried.
describe('GithubService.issueRepositoryDownloadToken when GitHub refuses the mint', () => {
    const httpError = (status: number, message: string, headers: Record<string, string> = {}) =>
        Object.assign(new Error(message), { status, response: { headers, data: { message } } });

    const mint = async (error: unknown) => {
        const t = makeService({});
        t.request.mockRejectedValue(error);
        const out = await t.service
            .issueRepositoryDownloadToken({ organizationAndTeamData: org, repositoryId: '123456' })
            .catch((e) => e);
        return { t, out };
    };

    it.each([
        ['404, the App was uninstalled', httpError(404, 'Not Found')],
        ['403, the installation is suspended', httpError(403, 'This installation has been suspended')],
        ['403, the App lacks the permission asked', httpError(403, 'Resource not accessible by integration')],
    ])('%s: no_installation, without the platform message', async (_label, error) => {
        const { t, out } = await mint(error);
        expect(out).toBeInstanceOf(RepositoryDownloadTokenError);
        expect(out.reason).toBe('no_installation');
        expect(out.message).not.toContain((error as Error).message);
        expectCacheUntouched(t);
    });

    it.each([
        ['403 rate limit', httpError(403, 'API rate limit exceeded for installation', { 'x-ratelimit-remaining': '0' })],
        ['403 secondary rate limit', httpError(403, 'You have exceeded a secondary rate limit', { 'retry-after': '60' })],
        ['401, the App credentials', httpError(401, 'Bad credentials')],
        ['502', httpError(502, 'Bad Gateway')],
        ['a network error', Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' })],
    ])('%s stays a transient failure, never a refusal', async (_label, error) => {
        const { out } = await mint(error);
        expect(out).toBe(error);
        expect(out).not.toBeInstanceOf(RepositoryDownloadTokenError);
    });
});

describe('downloadTokenProblem', () => {
    it('accepts exactly one repository with contents:read and the implicit metadata:read', () => {
        expect(downloadTokenProblem(narrow(), 123456)).toBeNull();
        expect(
            downloadTokenProblem(narrow({ permissions: { contents: 'read' } }), 123456),
        ).toBeNull();
    });

    it('refuses a response without token, expiry or contents:read', () => {
        expect(downloadTokenProblem(narrow({ token: '' }), 123456)).not.toBeNull();
        expect(downloadTokenProblem(narrow({ expires_at: 'x' }), 123456)).not.toBeNull();
        expect(
            downloadTokenProblem(narrow({ permissions: { metadata: 'read' } }), 123456),
        ).toBe('contents:read missing');
    });
});

describe('devPatDownloadAllowed (dev stacks connected with a PAT)', () => {
    it('allows the PAT as download token only with the flag, and never as production', () => {
        expect(devPatDownloadAllowed({})).toBe(false);
        expect(devPatDownloadAllowed({ RUNTIME_DEV_ALLOW_PAT_DOWNLOAD: 'true' })).toBe(true);
        for (const prod of [{ NODE_ENV: 'production' }, { RUNTIME_PRODUCTION_IMAGE: '1' }, { API_CLOUD_MODE: 'true' }]) {
            expect(devPatDownloadAllowed({ RUNTIME_DEV_ALLOW_PAT_DOWNLOAD: 'true', ...prod })).toBe(false);
        }
    });

    it('without the flag a PAT stays refused (the default)', async () => {
        delete process.env.RUNTIME_DEV_ALLOW_PAT_DOWNLOAD;
        expect(devPatDownloadAllowed(process.env)).toBe(false);
    });
});
