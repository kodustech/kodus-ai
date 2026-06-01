import { Test, TestingModule } from '@nestjs/testing';

import { ParametersKey } from '@libs/core/domain/enums';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/parameters/contracts/parameters.service.contract';
import { KodyRulesSyncService } from '../services/kodyRulesSync.service';
import { KodyRulesSyncListener } from './kody-rules-sync.listener';

describe('KodyRulesSyncListener', () => {
    let listener: KodyRulesSyncListener;

    const kodyRulesSyncServiceMock = {
        syncFromChangedFiles: jest.fn(),
    };

    const parametersServiceMock: jest.Mocked<
        Pick<IParametersService, 'findByKey'>
    > = {
        findByKey: jest.fn(),
    };

    beforeEach(async () => {
        jest.clearAllMocks();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                KodyRulesSyncListener,
                {
                    provide: KodyRulesSyncService,
                    useValue: kodyRulesSyncServiceMock,
                },
                {
                    provide: PARAMETERS_SERVICE_TOKEN,
                    useValue: parametersServiceMock,
                },
            ],
        }).compile();

        listener = module.get<KodyRulesSyncListener>(KodyRulesSyncListener);
    });

    it('should skip sync when repository data is missing', async () => {
        const event = {
            organizationAndTeamData: {
                organizationId: 'org-1',
                teamId: 'team-1',
            },
            repository: undefined,
            pullRequestNumber: 42,
            files: [
                {
                    filename: '.agents.md',
                    status: 'modified',
                },
            ],
        } as PullRequestClosedEvent;

        await listener.handlePullRequestClosedEvent(event);

        expect(parametersServiceMock.findByKey).not.toHaveBeenCalled();
        expect(
            kodyRulesSyncServiceMock.syncFromChangedFiles,
        ).not.toHaveBeenCalled();
    });

    it('should continue sync flow when centralized config is enabled', async () => {
        const event = new PullRequestClosedEvent(
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            {
                id: 'repo-1',
                name: 'repo-1',
            },
            42,
            [
                {
                    filename: '.agents.md',
                    status: 'modified',
                },
            ],
        );

        parametersServiceMock.findByKey.mockResolvedValue({
            configValue: {
                enabled: true,
            },
        } as any);

        await listener.handlePullRequestClosedEvent(event);

        expect(parametersServiceMock.findByKey).toHaveBeenCalledWith(
            ParametersKey.CENTRALIZED_CONFIG,
            event.organizationAndTeamData,
        );
        expect(
            kodyRulesSyncServiceMock.syncFromChangedFiles,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: event.organizationAndTeamData,
            repository: event.repository,
            pullRequestNumber: event.pullRequestNumber,
            files: event.files,
        });
    });

    it('should execute legacy sync when centralized config is disabled', async () => {
        const event = new PullRequestClosedEvent(
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            {
                id: 'repo-1',
                name: 'repo-1',
            },
            42,
            [
                {
                    filename: '.agents.md',
                    status: 'modified',
                },
            ],
        );

        parametersServiceMock.findByKey.mockResolvedValue({
            configValue: {
                enabled: false,
            },
        } as any);

        await listener.handlePullRequestClosedEvent(event);

        expect(
            kodyRulesSyncServiceMock.syncFromChangedFiles,
        ).toHaveBeenCalledWith({
            organizationAndTeamData: event.organizationAndTeamData,
            repository: event.repository,
            pullRequestNumber: event.pullRequestNumber,
            files: event.files,
        });
    });

    it('should skip sync for non-merged pull-request.closed events', async () => {
        const event = new PullRequestClosedEvent(
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            {
                id: 'repo-1',
                name: 'repo-1',
            },
            42,
            [
                {
                    filename: '.agents.md',
                    status: 'modified',
                },
            ],
            false,
        );

        await listener.handlePullRequestClosedEvent(event);

        expect(parametersServiceMock.findByKey).not.toHaveBeenCalled();
        expect(
            kodyRulesSyncServiceMock.syncFromChangedFiles,
        ).not.toHaveBeenCalled();
    });

    it('should skip sync when no files are provided', async () => {
        const event = new PullRequestClosedEvent(
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            {
                id: 'repo-1',
                name: 'repo-1',
            },
            42,
            [],
        );

        parametersServiceMock.findByKey.mockResolvedValue({
            configValue: {
                enabled: false,
            },
        } as any);

        await listener.handlePullRequestClosedEvent(event);

        expect(
            kodyRulesSyncServiceMock.syncFromChangedFiles,
        ).not.toHaveBeenCalled();
    });
});
