import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api/cockpit.api.js', () => ({
    cockpitApi: {
        get: vi.fn(),
        listSelectedRepositories: vi.fn(),
    },
}));

vi.mock('../user-context.service.js', () => ({
    userContextService: {
        resolve: vi.fn(),
    },
}));

import { cockpitApi } from '../api/cockpit.api.js';
import { previousWindow, usageService } from '../usage.service.js';
import { userContextService } from '../user-context.service.js';

const mockApi = vi.mocked(cockpitApi);
const mockContext = vi.mocked(userContextService);

const overview = (total: number, cost: number) => ({
    summary: {
        totals: { model: 'all', input: total / 2, output: total / 2, total },
        totalCost: { total: cost },
        byModel: [{ model: 'gpt-5', total, cost: { total: cost } }],
    },
    daily: [
        { date: '2026-10-01', model: 'gpt-5', total: total / 2 },
        { date: '2026-10-02', model: 'gpt-5', total: total / 2 },
    ],
    byPr: [
        { prNumber: 10, model: 'gpt-5', total: total / 2 },
        { prNumber: 11, model: 'gpt-5', total: total / 2 },
    ],
    byTaskArea: [{ task: 'review', area: 'review', total }],
});

describe('previousWindow', () => {
    it('is the same-length window right before the selected one', () => {
        expect(
            previousWindow({ startDate: '2026-10-16', endDate: '2026-10-31' }),
        ).toEqual({ startDate: '2026-09-30', endDate: '2026-10-15' });
    });
});

describe('usageService.getTokens', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockContext.resolve.mockResolvedValue({
            accessToken: 'eyJ.user.token',
            organizationId: 'org-1',
            teamId: 'team-1',
            teamName: 'Platform',
        });
        mockApi.listSelectedRepositories.mockResolvedValue([
            { id: 'repo-1', name: 'api', full_name: 'acme/api' },
        ]);
        mockApi.get.mockImplementation(async (_token, path, params) => {
            if (path === '/usage/tokens/overview') {
                return params.startDate === '2026-10-16'
                    ? overview(1000, 2)
                    : overview(500, 1);
            }
            return [{ developer: 'ana', total: 1000 }];
        });
    });

    it('reads the overview and the previous period without forcing byok', async () => {
        const result = await usageService.getTokens({
            from: '2026-10-16',
            to: '2026-10-31',
            repo: 'acme/api',
            pr: '10',
        });

        expect(mockContext.resolve).toHaveBeenCalledWith('Token usage', {
            team: undefined,
        });
        const [current, previous] = mockApi.get.mock.calls;
        expect(current[1]).toBe('/usage/tokens/overview');
        expect(current[2]).toEqual({
            startDate: '2026-10-16',
            endDate: '2026-10-31',
            prNumber: 10,
            developer: undefined,
            repositoryId: 'repo-1',
            teamId: 'team-1',
        });
        expect(current[2]).not.toHaveProperty('byok');
        expect(previous[2]).toMatchObject({
            startDate: '2026-09-30',
            endDate: '2026-10-15',
            repositoryId: 'repo-1',
        });

        expect(result.by).toBe('daily');
        expect(result.rows).toHaveLength(2);
        expect(result.previousPeriod).toEqual({
            startDate: '2026-09-30',
            endDate: '2026-10-15',
            cost: 1,
            tokens: 500,
        });
        expect(result.activeDays).toBe(2);
        expect(result.pullRequests).toBe(2);
        expect(result.byTaskArea).toHaveLength(1);
    });

    it('--by developer adds the developer aggregation', async () => {
        const result = await usageService.getTokens({
            from: '2026-10-16',
            to: '2026-10-31',
            by: 'developer',
            developer: 'ana',
        });

        expect(mockApi.get).toHaveBeenCalledWith(
            'eyJ.user.token',
            '/usage/tokens/by-developer',
            expect.objectContaining({ developer: 'ana' }),
        );
        expect(result.rows).toEqual([{ developer: 'ana', total: 1000 }]);
    });

    it('--by model returns the per-model breakdown of the summary', async () => {
        const result = await usageService.getTokens({
            from: '2026-10-16',
            to: '2026-10-31',
            by: 'model',
        });

        expect(result.rows).toEqual([
            { model: 'gpt-5', total: 1000, cost: { total: 2 } },
        ]);
        expect(mockApi.get).toHaveBeenCalledTimes(2);
    });

    it('a failed previous period only drops the deltas', async () => {
        mockApi.get.mockImplementation(async (_token, path, params) => {
            if (params.startDate === '2026-09-30') {
                throw new Error('timeout');
            }
            return overview(1000, 2);
        });

        const result = await usageService.getTokens({
            from: '2026-10-16',
            to: '2026-10-31',
        });

        expect(result.previousPeriod).toBeNull();
        expect(result.summary.totals.total).toBe(1000);
    });

    it('rejects an unknown dimension and a bad PR number', async () => {
        await expect(
            usageService.getTokens({ by: 'week' }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        await expect(
            usageService.getTokens({ pr: 'abc' }),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
        expect(mockApi.get).not.toHaveBeenCalled();
    });
});
