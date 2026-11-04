import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/cockpit.api.js', () => ({
    cockpitApi: {
        get: vi.fn(),
        listSelectedRepositories: vi.fn(),
        getMetricsVisibility: vi.fn(),
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: {
        resolve: vi.fn(),
    },
}));

import { ApiError } from '../../types/errors.js';
import { cockpitApi } from '../api/cockpit.api.js';
import { cockpitService, resolveDateRange } from '../cockpit.service.js';
import { userContextService } from '../user-context.service.js';

const mockApi = vi.mocked(cockpitApi);
const mockContext = vi.mocked(userContextService);

const context = {
    accessToken: 'eyJ.user.token',
    organizationId: 'org-1',
    teamId: 'team-1',
    teamName: 'Platform',
};

const repositories = [
    {
        id: 'repo-1',
        name: 'api',
        full_name: 'acme/api',
        organizationName: 'acme',
    },
    {
        id: 'repo-2',
        name: 'web',
        full_name: 'acme/web',
        organizationName: 'acme',
    },
];

describe('resolveDateRange', () => {
    it('defaults to the last 15 days, like the Cockpit', () => {
        expect(resolveDateRange({}, new Date(2026, 10, 2, 15, 0))).toEqual({
            startDate: '2026-10-18',
            endDate: '2026-11-02',
        });
    });

    it('counts the default window back from --to', () => {
        expect(resolveDateRange({ to: '2026-03-31' })).toEqual({
            startDate: '2026-03-16',
            endDate: '2026-03-31',
        });
    });

    it('rejects a non ISO date and an inverted range', () => {
        expect(() => resolveDateRange({ from: '10/01/2026' })).toThrow(
            /Use YYYY-MM-DD/,
        );
        expect(() =>
            resolveDateRange({ from: '2026-10-10', to: '2026-10-01' }),
        ).toThrow(/after --to/);
    });
});

describe('cockpitService.getTab', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.resolve.mockResolvedValue(context);
        mockApi.listSelectedRepositories.mockResolvedValue(repositories);
        mockApi.getMetricsVisibility.mockResolvedValue(null);
        mockApi.get.mockImplementation(async (_token, path) => ({ path }));
    });

    it('productivity calls every endpoint the tab renders with the page params', async () => {
        const result = await cockpitService.getTab('productivity', {
            from: '2026-10-01',
            to: '2026-10-15',
            repo: 'acme/web',
            team: 'Platform',
        });

        expect(mockContext.resolve).toHaveBeenCalledWith('Cockpit', {
            team: 'Platform',
        });
        const paths = mockApi.get.mock.calls.map((call) => call[1]);
        expect(paths).toEqual([
            '/productivity/highlights/deploy-frequency',
            '/productivity/highlights/lead-time-for-change',
            '/code-health/highlights/bug-ratio',
            '/productivity/highlights/pr-size',
            '/productivity/charts/lead-time-breakdown',
            '/productivity/charts/lead-time-for-change',
            '/productivity/charts/pull-requests-opened-vs-closed',
            '/productivity/charts/pull-requests-by-developer',
            '/productivity/charts/developer-activity',
        ]);
        for (const call of mockApi.get.mock.calls) {
            expect(call[0]).toBe('eyJ.user.token');
            expect(call[2]).toEqual({
                organizationId: 'org-1',
                startDate: '2026-10-01',
                endDate: '2026-10-15',
                repository: 'acme/web',
            });
        }
        expect(result.repository).toEqual({
            id: 'repo-2',
            fullName: 'acme/web',
        });
        expect(result.metrics.deployFrequency).toEqual({
            path: '/productivity/highlights/deploy-frequency',
        });
        expect(result.errors).toEqual({});
    });

    it('kodus-review keeps the other cards when one endpoint fails', async () => {
        mockApi.get.mockImplementation(async (_token, path) => {
            if (path.endsWith('kody-rules-health')) {
                throw new ApiError(500, 'boom');
            }
            return [];
        });

        const result = await cockpitService.getTab('kodus-review', {});

        expect(mockApi.get).toHaveBeenCalledTimes(11);
        expect(result.metrics.kodyRulesHealth).toBeNull();
        expect(result.errors).toEqual({ kodyRulesHealth: 'boom' });
        expect(result.metrics.implementationRateWeekly).toEqual([]);
        expect(mockApi.get.mock.calls[0][2]).not.toHaveProperty(
            'repository',
            expect.anything(),
        );
    });

    it('surfaces a 403 (role or plan without Cockpit) as one clear error', async () => {
        mockApi.get.mockRejectedValue(
            new ApiError(
                403,
                'cockpit: organization is not on a supported tier',
            ),
        );

        await expect(
            cockpitService.getTab('productivity', {}),
        ).rejects.toMatchObject({
            code: 'API_REQUEST_FAILED',
            message: expect.stringContaining('not on a supported tier'),
        });
    });

    it('intent reads the business logic endpoint with team and repository', async () => {
        await cockpitService.getTab('intent', {
            from: '2026-10-01',
            to: '2026-10-15',
            repo: 'repo-1',
        });

        expect(mockApi.get).toHaveBeenCalledWith(
            'eyJ.user.token',
            '/business-logic/intent',
            {
                startDate: '2026-10-01',
                endDate: '2026-10-15',
                teamId: 'team-1',
                repository: 'acme/api',
            },
        );
    });

    it("code-areas maps the team's first repository when none is given", async () => {
        const result = await cockpitService.getTab('code-areas', {});

        expect(mockApi.get).toHaveBeenCalledWith(
            'eyJ.user.token',
            '/code-management/area-risk-map',
            { repositoryId: 'repo-1', teamId: 'team-1' },
        );
        expect(result.repository).toEqual({
            id: 'repo-1',
            fullName: 'acme/api',
        });
    });

    it('rejects a repository the team has not selected', async () => {
        await expect(
            cockpitService.getTab('productivity', { repo: 'acme/other' }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(mockApi.get).not.toHaveBeenCalled();
    });

    it('rejects an unknown tab before any request', async () => {
        await expect(
            cockpitService.getTab('code-health' as never, {}),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(mockContext.resolve).not.toHaveBeenCalled();
    });
});

describe('cockpit visibility settings', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.resolve.mockResolvedValue(context);
        mockApi.listSelectedRepositories.mockResolvedValue(repositories);
        mockApi.get.mockResolvedValue({ value: 1 });
    });

    it('skips the cards the organization turned off, as the web does', async () => {
        mockApi.getMetricsVisibility.mockResolvedValue({
            summary: { deployFrequency: false },
            details: { teamActivity: false, prCycleTime: false },
        });

        const result = await cockpitService.getTab('productivity', {});

        expect(result.hidden).toEqual([
            'deployFrequency',
            'prCycleTimeWeekly',
            'teamActivity',
        ]);
        expect(result.metrics).not.toHaveProperty('deployFrequency');
        expect(result.metrics).toHaveProperty('prCycleTime');
        const paths = mockApi.get.mock.calls.map((call) => call[1]);
        expect(paths).not.toContain(
            '/productivity/highlights/deploy-frequency',
        );
        expect(paths).not.toContain('/productivity/charts/developer-activity');
    });

    it('refuses a tab the organization turned off', async () => {
        mockApi.getMetricsVisibility.mockResolvedValue({
            tabs: { intent: false },
        });

        await expect(cockpitService.getTab('intent', {})).rejects.toEqual(
            expect.objectContaining({ code: 'INVALID_INPUT' }),
        );
        expect(mockApi.get).not.toHaveBeenCalled();
    });

    it('keeps productivity when both summary tabs are off', async () => {
        mockApi.getMetricsVisibility.mockResolvedValue({
            tabs: { kodusReview: false, productivity: false },
        });

        await expect(
            cockpitService.getTab('productivity', {}),
        ).resolves.toEqual(expect.objectContaining({ tab: 'productivity' }));
    });

    it('shows everything when the settings cannot be read', async () => {
        mockApi.getMetricsVisibility.mockRejectedValue(new Error('boom'));

        const result = await cockpitService.getTab('productivity', {});

        expect(result.hidden).toEqual([]);
    });
});
