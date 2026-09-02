import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { PullRequestState } from '@libs/core/domain/enums/pullRequestState.enum';
import { INTEGRATION_REQUEST_TIMEOUT_MS } from '@libs/core/infrastructure/http/integration-timeouts';
import { DistributedLockService } from '@libs/core/workflow/infrastructure/distributed-lock.service';
import { PARAMETERS_SERVICE_TOKEN } from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { TEAM_SERVICE_TOKEN } from '@libs/organization/domain/team/contracts/team.service.contract';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@libs/platformData/domain/pullRequests/contracts/pullRequests.service.contracts';
import { Test, TestingModule } from '@nestjs/testing';

import {
    PullRequestStateReconciliationCronProvider,
    terminalStateFromProvider,
} from './pullRequestStateReconciliation.cron';

jest.mock('@libs/core/log/logger', () => ({
    createLogger: jest.fn().mockReturnValue({
        log: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
    }),
}));

describe('PullRequestStateReconciliationCronProvider', () => {
    let provider: PullRequestStateReconciliationCronProvider;
    let teamService: { findTeamsWithIntegrations: jest.Mock };
    let parametersService: { findOne: jest.Mock };
    let pullRequestService: {
        findOpenForStateReconciliation: jest.Mock;
        markTerminalIfOpen: jest.Mock;
    };
    let codeManagementService: { getPullRequest: jest.Mock };
    let distributedLockService: { acquire: jest.Mock };
    let lock: { release: jest.Mock };

    const candidate = {
        uuid: 'pr-document-25',
        number: 25,
        status: PullRequestState.OPENED,
        merged: false,
        provider: PlatformType.GITHUB,
        organizationId: 'org-1',
        repository: {
            id: 'repo-1',
            name: 'claude-global',
            fullName: 'felipeggv/claude-global',
        },
    };

    beforeEach(async () => {
        teamService = {
            findTeamsWithIntegrations: jest.fn().mockResolvedValue([
                {
                    uuid: 'team-1',
                    organization: { uuid: 'org-1' },
                },
            ]),
        };
        parametersService = {
            findOne: jest.fn().mockResolvedValue({
                configKey: ParametersKey.CODE_REVIEW_CONFIG,
                configValue: {
                    repositories: [{ id: 'repo-1', name: 'claude-global' }],
                },
            }),
        };
        pullRequestService = {
            findOpenForStateReconciliation: jest
                .fn()
                .mockResolvedValue([candidate]),
            markTerminalIfOpen: jest.fn().mockResolvedValue(true),
        };
        codeManagementService = {
            getPullRequest: jest.fn().mockResolvedValue({
                state: PullRequestState.CLOSED,
                merged_at: '2026-09-02T12:00:00.000Z',
            }),
        };
        lock = { release: jest.fn() };
        distributedLockService = {
            acquire: jest.fn().mockResolvedValue(lock),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                PullRequestStateReconciliationCronProvider,
                { provide: TEAM_SERVICE_TOKEN, useValue: teamService },
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: parametersService,
                },
                {
                    provide: PULL_REQUESTS_SERVICE_TOKEN,
                    useValue: pullRequestService,
                },
                {
                    provide: CodeManagementService,
                    useValue: codeManagementService,
                },
                {
                    provide: DistributedLockService,
                    useValue: distributedLockService,
                },
            ],
        }).compile();

        provider = module.get(PullRequestStateReconciliationCronProvider);
    });

    afterEach(() => {
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    it('does nothing when another instance owns the lock', async () => {
        distributedLockService.acquire.mockResolvedValue(null);

        await provider.handleCron();

        expect(distributedLockService.acquire).toHaveBeenCalledWith(
            'CRON:PULL_REQUEST_STATE_RECONCILIATION',
        );
        expect(teamService.findTeamsWithIntegrations).not.toHaveBeenCalled();
    });

    it('atomically closes a locally-open PR when the provider is terminal', async () => {
        await provider.handleCron();

        expect(codeManagementService.getPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                prNumber: 25,
                repository: { id: 'repo-1', name: 'claude-global' },
            }),
            PlatformType.GITHUB,
        );
        expect(pullRequestService.markTerminalIfOpen).toHaveBeenCalledWith(
            'pr-document-25',
            'org-1',
            {
                status: PullRequestState.CLOSED,
                merged: true,
                closedAt: '2026-09-02T12:00:00.000Z',
            },
        );
        expect(lock.release).toHaveBeenCalled();
    });

    it('leaves a provider-open PR untouched', async () => {
        codeManagementService.getPullRequest.mockResolvedValue({
            state: PullRequestState.OPENED,
        });

        await provider.handleCron();

        expect(pullRequestService.markTerminalIfOpen).not.toHaveBeenCalled();
    });

    it('keeps processing after one provider lookup fails', async () => {
        pullRequestService.findOpenForStateReconciliation.mockResolvedValue([
            candidate,
            { ...candidate, uuid: 'pr-document-26', number: 26 },
        ]);
        codeManagementService.getPullRequest
            .mockRejectedValueOnce(new Error('provider unavailable'))
            .mockResolvedValueOnce({
                state: PullRequestState.CLOSED,
                closed_at: '2026-09-02T13:00:00.000Z',
            });

        await provider.handleCron();

        expect(codeManagementService.getPullRequest).toHaveBeenCalledTimes(2);
        expect(pullRequestService.markTerminalIfOpen).toHaveBeenCalledTimes(1);
        expect(lock.release).toHaveBeenCalled();
    });

    it('times out a hung provider lookup and releases the lock', async () => {
        jest.useFakeTimers();
        let providerSignal: AbortSignal | undefined;
        codeManagementService.getPullRequest.mockImplementation(
            (params: { signal?: AbortSignal }) => {
                providerSignal = params.signal;
                return new Promise(() => undefined);
            },
        );

        const run = provider.handleCron();
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(INTEGRATION_REQUEST_TIMEOUT_MS);
        await run;

        expect(
            pullRequestService.markTerminalIfOpen,
        ).not.toHaveBeenCalled();
        expect(providerSignal).toBeDefined();
        expect(providerSignal?.aborted).toBe(true);
        expect(lock.release).toHaveBeenCalled();
    });
});

describe('terminalStateFromProvider', () => {
    it.each([
        [{ state: 'closed', closed_at: 'a' }, false],
        [{ state: 'merged', merged_at: 'b' }, true],
        [{ status: 'completed', closedDate: 'c' }, false],
        [{ status: 'abandoned', closedDate: 'd' }, false],
        [{ state: 'DECLINED', updated_on: 'e' }, false],
    ])(
        'maps terminal provider shapes without inventing state',
        (pr, merged) => {
            expect(terminalStateFromProvider(pr)).toEqual(
                expect.objectContaining({
                    status: PullRequestState.CLOSED,
                    merged,
                }),
            );
        },
    );

    it('returns null for open and unknown provider responses', () => {
        expect(terminalStateFromProvider({ state: 'open' })).toBeNull();
        expect(terminalStateFromProvider({})).toBeNull();
        expect(terminalStateFromProvider(null)).toBeNull();
    });
});
