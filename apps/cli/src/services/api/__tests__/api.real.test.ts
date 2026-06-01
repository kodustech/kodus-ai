import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../types/errors.js';

const deviceMocks = vi.hoisted(() => ({
    getDeviceIdentity: vi.fn(),
    updateDeviceToken: vi.fn(),
}));

const configMocks = vi.hoisted(() => ({
    loadConfig: vi.fn(),
}));

// api-core.ts now uses undici's fetch (not Node's global) so the custom
// long-lived Agent is actually honored. Tests must mock the undici module.
const undiciMocks = vi.hoisted(() => ({
    fetch: vi.fn(),
}));

vi.mock('undici', () => ({
    Agent: class MockAgent {
        constructor(_opts?: unknown) {}
    },
    fetch: undiciMocks.fetch,
}));

vi.mock('../../../utils/device.js', () => ({
    getDeviceIdentity: deviceMocks.getDeviceIdentity,
    updateDeviceToken: deviceMocks.updateDeviceToken,
}));

vi.mock('../../../utils/config.js', () => ({
    loadConfig: configMocks.loadConfig,
}));

import { RealApi, _resetConfigCache } from '../api.real.js';

describe('RealApi request headers', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        _resetConfigCache();
        configMocks.loadConfig.mockResolvedValue(null);
        fetchMock = undiciMocks.fetch;
        fetchMock.mockReset();
        deviceMocks.getDeviceIdentity.mockResolvedValue({
            deviceId: '11111111-1111-4111-8111-111111111111',
            deviceToken: 'device-token-123',
        });
        deviceMocks.updateDeviceToken.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete process.env.KODUS_API_URL;
        delete process.env.CF_ACCESS_CLIENT_ID;
        delete process.env.CF_ACCESS_CLIENT_SECRET;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('includes X-Kodus-Device-Id and X-Kodus-Device-Token in API requests', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        fingerprint: 'fp',
                        reviewsUsed: 0,
                        reviewsLimit: 5,
                        filesLimit: 10,
                        linesLimit: 500,
                        resetsAt: new Date().toISOString(),
                        isLimited: false,
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.trial.getStatus('fp');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers['X-Kodus-Device-Id']).toBe(
            '11111111-1111-4111-8111-111111111111',
        );
        expect(options.headers['X-Kodus-Device-Token']).toBe(
            'device-token-123',
        );
    });

    it('updates stored device token from response header', async () => {
        deviceMocks.getDeviceIdentity.mockResolvedValue({
            deviceId: '11111111-1111-4111-8111-111111111111',
        });

        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        reviewsUsed: 0,
                        reviewsLimit: 5,
                        filesLimit: 10,
                        linesLimit: 500,
                        resetsAt: new Date().toISOString(),
                        isLimited: false,
                    },
                }),
                {
                    status: 200,
                    headers: {
                        'Content-Type': 'application/json',
                        'x-kodus-device-token': 'server-issued-token',
                    },
                },
            ),
        );

        const api = new RealApi();
        await api.trial.getStatus('fp');

        expect(deviceMocks.updateDeviceToken).toHaveBeenCalledWith(
            'server-issued-token',
        );
    });

    it('maps DEVICE_LIMIT_REACHED to a user-friendly message', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 5, current: 5 },
                }),
                {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await expect(api.trial.getStatus('fp')).rejects.toThrow(
            'Device limit reached (5/5).',
        );
    });

    it('keeps compatibility with legacy activeDevices field', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    code: 'DEVICE_LIMIT_REACHED',
                    details: { limit: 5, activeDevices: 5 },
                }),
                {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await expect(api.trial.getStatus('fp')).rejects.toThrow(
            'Device limit reached (5/5).',
        );
    });
});

describe('RealApi review.getPullRequestSuggestions', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        _resetConfigCache();
        configMocks.loadConfig.mockResolvedValue(null);
        fetchMock = undiciMocks.fetch;
        fetchMock.mockReset();
        deviceMocks.getDeviceIdentity.mockResolvedValue({
            deviceId: '11111111-1111-4111-8111-111111111111',
        });
        deviceMocks.updateDeviceToken.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete process.env.KODUS_API_URL;
        delete process.env.CF_ACCESS_CLIENT_ID;
        delete process.env.CF_ACCESS_CLIENT_SECRET;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends X-Team-Key header when using team key', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        summary: 'ok',
                        issues: [],
                        filesAnalyzed: 0,
                        duration: 0,
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.review.getPullRequestSuggestions('kodus_team_key', {
            prUrl: 'https://github.com/acme/repo/pull/1',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers['X-Team-Key']).toBe('kodus_team_key');
        expect(options.headers.Authorization).toBeUndefined();
    });

    it('sends Authorization header when using bearer token', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        summary: 'ok',
                        issues: [],
                        filesAnalyzed: 0,
                        duration: 0,
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.review.getPullRequestSuggestions('eyJ.test.token', {
            prUrl: 'https://github.com/acme/repo/pull/1',
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers.Authorization).toBe('Bearer eyJ.test.token');
        expect(options.headers['X-Team-Key']).toBeUndefined();
    });

    it('normalizes API auth errors to default CLI English message', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    message: 'Team key required by backend',
                }),
                {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();

        await expect(
            api.review.getPullRequestSuggestions('eyJ.test.token', {
                prUrl: 'https://github.com/acme/repo/pull/1',
            }),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'ApiError',
                statusCode: 401,
                message:
                    'Authentication failed while fetching pull request suggestions. Run: kodus auth login or configure a valid team key.',
            } satisfies Partial<ApiError>),
        );
    });
});

describe('RealApi config repository methods', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        _resetConfigCache();
        configMocks.loadConfig.mockResolvedValue(null);
        fetchMock = undiciMocks.fetch;
        fetchMock.mockReset();
        deviceMocks.getDeviceIdentity.mockResolvedValue({
            deviceId: '11111111-1111-4111-8111-111111111111',
        });
        deviceMocks.updateDeviceToken.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends X-Team-Key when listing available repositories', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: 'repo-1',
                            name: 'cli',
                            full_name: 'kodustech/cli',
                            organizationName: 'kodustech',
                            selected: false,
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.getAvailableRepositories('kodus_team_key');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/cli/config/repositories/available');
        expect(url).not.toContain('teamId=');
        expect(options.headers['X-Team-Key']).toBe('kodus_team_key');
        expect(options.headers.Authorization).toBeUndefined();
    });

    it('sends X-Team-Key when adding repositories', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        status: true,
                        addedRepositoryIds: ['repo-1'],
                        totalSelected: 1,
                    },
                }),
                {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.addRepositories('kodus_team_key', ['repo-1']);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/cli/config/repositories');
        expect(options.method).toBe('POST');
        expect(options.headers['X-Team-Key']).toBe('kodus_team_key');
        expect(options.body).toBe(
            JSON.stringify({
                repositoryIds: ['repo-1'],
            }),
        );
    });

    it('sends X-Team-Key when listing selected repositories', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: 'repo-1',
                            name: 'cli',
                            full_name: 'kodustech/cli',
                            organizationName: 'kodustech',
                            selected: true,
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.getSelectedRepositories('kodus_team_key');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/cli/config/repositories/selected');
        expect(url).not.toContain('teamId=');
        expect(options.headers['X-Team-Key']).toBe('kodus_team_key');
    });

    it('lists teams with bearer auth for repository settings flows', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: [
                        {
                            uuid: 'team-1',
                            name: 'Platform Team',
                            status: 'ACTIVE',
                        },
                    ],
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.getTeams('eyJ.test.token');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/team/');
        expect(options.method).toBeUndefined();
        expect(options.headers.Authorization).toBe('Bearer eyJ.test.token');
        expect(options.headers['X-Team-Key']).toBeUndefined();
    });

    it('reads code review parameter data with bearer auth', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        uuid: 'param-1',
                        configKey: 'CODE_REVIEW_CONFIG',
                        configValue: {
                            repositories: [
                                {
                                    id: 'repo-1',
                                    name: 'cli',
                                    configs: {
                                        automatedReviewActive: true,
                                    },
                                },
                            ],
                        },
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.getCodeReviewParameter(
            'eyJ.test.token',
            'team-1',
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/parameters/find-by-key');
        expect(url).toContain('key=CODE_REVIEW_CONFIG');
        expect(url).toContain('teamId=team-1');
        expect(options.headers.Authorization).toBe('Bearer eyJ.test.token');
        expect(options.headers['X-Team-Key']).toBeUndefined();
    });

    it('updates code review parameter data with bearer auth', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        uuid: 'param-1',
                        configKey: 'CODE_REVIEW_CONFIG',
                        configValue: {
                            automatedReviewActive: true,
                        },
                    },
                }),
                {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.createOrUpdateCodeReviewParameter(
            'eyJ.test.token',
            {
                teamId: 'team-1',
                repositoryId: 'repo-1',
                configValue: {
                    automatedReviewActive: true,
                    pullRequestApprovalActive: false,
                },
            },
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/parameters/create-or-update-code-review');
        expect(options.method).toBe('POST');
        expect(options.headers.Authorization).toBe('Bearer eyJ.test.token');
        expect(options.headers['X-Team-Key']).toBeUndefined();
        expect(options.body).toBe(
            JSON.stringify({
                configValue: {
                    automatedReviewActive: true,
                    pullRequestApprovalActive: false,
                },
                organizationAndTeamData: {
                    teamId: 'team-1',
                },
                repositoryId: 'repo-1',
            }),
        );
    });

    it('syncs repository settings repositories with bearer auth', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        status: true,
                    },
                }),
                {
                    status: 201,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.updateCodeReviewParameterRepositories(
            'eyJ.test.token',
            'team-1',
        );

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/parameters/update-code-review-parameter-repositories');
        expect(options.method).toBe('POST');
        expect(options.headers.Authorization).toBe('Bearer eyJ.test.token');
        expect(options.body).toBe(
            JSON.stringify({
                organizationAndTeamData: {
                    teamId: 'team-1',
                },
            }),
        );
    });

    it('surfaces repository config permission errors from the API', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    statusCode: 403,
                    path: '/cli/config/repositories/available',
                    error: 'Forbidden',
                    message:
                        'This CLI key is not allowed to configure repositories',
                }),
                {
                    status: 403,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();

        await expect(
            api.config.getAvailableRepositories('kodus_team_key'),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'ApiError',
                statusCode: 403,
                message:
                    'Repository configuration access denied: This CLI key is not allowed to configure repositories',
            } satisfies Partial<ApiError>),
        );
    });

    it('explains that repository config requires team-key auth on 401', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    statusCode: 401,
                    path: '/cli/config/repositories/available',
                    error: 'Unauthorized',
                    message: 'Unauthorized',
                }),
                {
                    status: 401,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();

        await expect(
            api.config.getAvailableRepositories('eyJ.test.token'),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'ApiError',
                statusCode: 401,
                message:
                    'Repository configuration requires team-key auth. Run: kodus auth team-key --key <your-key>.',
            } satisfies Partial<ApiError>),
        );
    });

    it('sends X-Team-Key when getting repository settings', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        reviewEnabled: true,
                        autoApproveEnabled: false,
                        requestChangesMinSeverity: 'critical',
                        ignoredFilePatterns: ['**/*.lock'],
                        baseBranchPatterns: ['main', 'release/*'],
                        ignoredTitlePatterns: ['wip*'],
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.getRepositorySettings('kodus_team_key', 'repo-1');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/cli/config/repositories/repo-1/settings');
        expect(options.method).toBeUndefined();
        expect(options.headers['X-Team-Key']).toBe('kodus_team_key');
        expect(options.headers.Authorization).toBeUndefined();
    });

    it('surfaces missing repository settings endpoints clearly', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    statusCode: 404,
                    path: '/cli/config/repositories/repo-1/settings',
                    error: 'Not Found',
                    message: 'Cannot GET /cli/config/repositories/repo-1/settings',
                }),
                {
                    status: 404,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();

        await expect(
            api.config.getRepositorySettings('kodus_team_key', 'repo-1'),
        ).rejects.toEqual(
            expect.objectContaining({
                name: 'ApiError',
                statusCode: 404,
                message:
                    'Repository settings are not available in this Kodus API environment. `config remote show`, `setup`, and `set` require the repository settings endpoint.',
            } satisfies Partial<ApiError>),
        );
    });

    it('sends Authorization when updating repository settings with bearer token', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        reviewEnabled: true,
                        autoApproveEnabled: true,
                        requestChangesMinSeverity: 'high',
                        ignoredFilePatterns: ['dist/**'],
                        baseBranchPatterns: ['main'],
                        ignoredTitlePatterns: ['draft*'],
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.config.updateRepositorySettings('eyJ.test.token', 'repo-1', {
            reviewEnabled: true,
            autoApproveEnabled: true,
            requestChangesMinSeverity: 'high',
            ignoredFilePatterns: ['dist/**'],
            baseBranchPatterns: ['main'],
            ignoredTitlePatterns: ['draft*'],
        });

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/cli/config/repositories/repo-1/settings');
        expect(options.method).toBe('PATCH');
        expect(options.headers.Authorization).toBe('Bearer eyJ.test.token');
        expect(options.headers['X-Team-Key']).toBeUndefined();
        expect(options.body).toBe(
            JSON.stringify({
                reviewEnabled: true,
                autoApproveEnabled: true,
                requestChangesMinSeverity: 'high',
                ignoredFilePatterns: ['dist/**'],
                baseBranchPatterns: ['main'],
                ignoredTitlePatterns: ['draft*'],
            }),
        );
    });
});

describe('RealApi review.analyze auth mode', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        _resetConfigCache();
        configMocks.loadConfig.mockResolvedValue(null);
        fetchMock = undiciMocks.fetch;
        fetchMock.mockReset();
        deviceMocks.getDeviceIdentity.mockResolvedValue({
            deviceId: '11111111-1111-4111-8111-111111111111',
        });
        deviceMocks.updateDeviceToken.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete process.env.KODUS_API_URL;
        delete process.env.CF_ACCESS_CLIENT_ID;
        delete process.env.CF_ACCESS_CLIENT_SECRET;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('sends Authorization header for user login token', async () => {
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    data: {
                        summary: 'ok',
                        issues: [],
                        filesAnalyzed: 0,
                        duration: 0,
                    },
                }),
                {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                },
            ),
        );

        const api = new RealApi();
        await api.review.analyze('diff --git a/file b/file', 'eyJ.test.token');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, options] = fetchMock.mock.calls[0];
        expect(url).toContain('/cli/review');
        expect(options.headers.Authorization).toBe('Bearer eyJ.test.token');
        expect(options.headers['X-Team-Key']).toBeUndefined();
    });
});

describe('Cloudflare Access headers from config', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        _resetConfigCache();
        configMocks.loadConfig.mockResolvedValue(null);
        fetchMock = undiciMocks.fetch;
        fetchMock.mockReset();
        deviceMocks.getDeviceIdentity.mockResolvedValue({
            deviceId: '11111111-1111-4111-8111-111111111111',
        });
        deviceMocks.updateDeviceToken.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete process.env.KODUS_API_URL;
        delete process.env.CF_ACCESS_CLIENT_ID;
        delete process.env.CF_ACCESS_CLIENT_SECRET;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function mockJsonResponse(data: any = {}) {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
    }

    it('sends CF headers when config has cfAccessClientId and cfAccessClientSecret', async () => {
        configMocks.loadConfig.mockResolvedValue({
            teamKey: 'kodus_abc',
            teamName: 'Team',
            organizationName: 'Org',
            cfAccessClientId: 'cf-id-from-config',
            cfAccessClientSecret: 'cf-secret-from-config',
        });
        mockJsonResponse({
            fingerprint: 'fp',
            reviewsUsed: 0,
            reviewsLimit: 5,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt: new Date().toISOString(),
            isLimited: false,
        });

        const api = new RealApi();
        await api.trial.getStatus('fp');

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers['CF-Access-Client-Id']).toBe(
            'cf-id-from-config',
        );
        expect(options.headers['CF-Access-Client-Secret']).toBe(
            'cf-secret-from-config',
        );
    });

    it('does not send CF headers when config has no CF fields', async () => {
        configMocks.loadConfig.mockResolvedValue({
            teamKey: 'kodus_abc',
            teamName: 'Team',
            organizationName: 'Org',
        });
        mockJsonResponse({
            fingerprint: 'fp',
            reviewsUsed: 0,
            reviewsLimit: 5,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt: new Date().toISOString(),
            isLimited: false,
        });

        const api = new RealApi();
        await api.trial.getStatus('fp');

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers['CF-Access-Client-Id']).toBeUndefined();
        expect(options.headers['CF-Access-Client-Secret']).toBeUndefined();
    });

    it('env vars take priority over config for CF headers', async () => {
        configMocks.loadConfig.mockResolvedValue({
            teamKey: 'kodus_abc',
            teamName: 'Team',
            organizationName: 'Org',
            cfAccessClientId: 'cf-id-from-config',
            cfAccessClientSecret: 'cf-secret-from-config',
        });
        process.env.CF_ACCESS_CLIENT_ID = 'cf-id-from-env';
        process.env.CF_ACCESS_CLIENT_SECRET = 'cf-secret-from-env';
        mockJsonResponse({
            fingerprint: 'fp',
            reviewsUsed: 0,
            reviewsLimit: 5,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt: new Date().toISOString(),
            isLimited: false,
        });

        const api = new RealApi();
        await api.trial.getStatus('fp');

        const [, options] = fetchMock.mock.calls[0];
        expect(options.headers['CF-Access-Client-Id']).toBe('cf-id-from-env');
        expect(options.headers['CF-Access-Client-Secret']).toBe(
            'cf-secret-from-env',
        );
    });
});

describe('API base URL from config', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        _resetConfigCache();
        configMocks.loadConfig.mockResolvedValue(null);
        fetchMock = undiciMocks.fetch;
        fetchMock.mockReset();
        deviceMocks.getDeviceIdentity.mockResolvedValue({
            deviceId: '11111111-1111-4111-8111-111111111111',
        });
        deviceMocks.updateDeviceToken.mockResolvedValue(undefined);
    });

    afterEach(() => {
        delete process.env.KODUS_API_URL;
        delete process.env.CF_ACCESS_CLIENT_ID;
        delete process.env.CF_ACCESS_CLIENT_SECRET;
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    function mockJsonResponse(data: any = {}) {
        fetchMock.mockResolvedValue(
            new Response(JSON.stringify({ data }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            }),
        );
    }

    it('uses apiUrl from config when KODUS_API_URL env var is not set', async () => {
        configMocks.loadConfig.mockResolvedValue({
            teamKey: 'kodus_abc',
            teamName: 'Team',
            organizationName: 'Org',
            apiUrl: 'https://custom.example.com',
        });
        mockJsonResponse({
            fingerprint: 'fp',
            reviewsUsed: 0,
            reviewsLimit: 5,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt: new Date().toISOString(),
            isLimited: false,
        });

        const api = new RealApi();
        await api.trial.getStatus('fp');

        const [url] = fetchMock.mock.calls[0];
        expect(url).toMatch(/^https:\/\/custom\.example\.com\//);
    });

    it('KODUS_API_URL env var takes priority over config apiUrl', async () => {
        configMocks.loadConfig.mockResolvedValue({
            teamKey: 'kodus_abc',
            teamName: 'Team',
            organizationName: 'Org',
            apiUrl: 'https://from-config.example.com',
        });
        process.env.KODUS_API_URL = 'https://from-env.example.com';
        mockJsonResponse({
            fingerprint: 'fp',
            reviewsUsed: 0,
            reviewsLimit: 5,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt: new Date().toISOString(),
            isLimited: false,
        });

        const api = new RealApi();
        await api.trial.getStatus('fp');

        const [url] = fetchMock.mock.calls[0];
        expect(url).toMatch(/^https:\/\/from-env\.example\.com\//);
    });

    it('falls back to default URL when no config and no env var', async () => {
        mockJsonResponse({
            fingerprint: 'fp',
            reviewsUsed: 0,
            reviewsLimit: 5,
            filesLimit: 10,
            linesLimit: 500,
            resetsAt: new Date().toISOString(),
            isLimited: false,
        });

        const api = new RealApi();
        await api.trial.getStatus('fp');

        const [url] = fetchMock.mock.calls[0];
        expect(url).toMatch(/^https:\/\/api\.kodus\.io\//);
    });
});
