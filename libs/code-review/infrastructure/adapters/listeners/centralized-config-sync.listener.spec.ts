import { Test, TestingModule } from '@nestjs/testing';

import { CentralizedConfigSyncUseCase } from '@libs/code-review/application/use-cases/configuration/centralized-config-sync.use-case';
import { PullRequestClosedEvent } from '@libs/core/domain/events/pull-request-closed.event';
import { CentralizedConfigSyncListener } from './centralized-config-sync.listener';

describe('CentralizedConfigSyncListener', () => {
    let listener: CentralizedConfigSyncListener;

    const centralizedConfigSyncUseCaseMock = {
        execute: jest.fn(),
    };

    beforeEach(async () => {
        centralizedConfigSyncUseCaseMock.execute.mockReset();

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                CentralizedConfigSyncListener,
                {
                    provide: CentralizedConfigSyncUseCase,
                    useValue: centralizedConfigSyncUseCaseMock,
                },
            ],
        }).compile();

        listener = module.get<CentralizedConfigSyncListener>(
            CentralizedConfigSyncListener,
        );
    });

    it('should sync centralized config when pull-request.closed is emitted', async () => {
        const event = new PullRequestClosedEvent(
            {
                organizationId: 'org-1',
                teamId: 'team-1',
            } as any,
            {
                id: 'centralized-config-repo',
                name: 'kodus',
            },
            42,
            [],
        );

        await listener.handlePullRequestClosedEvent(event);

        expect(centralizedConfigSyncUseCaseMock.execute).toHaveBeenCalledWith({
            organizationAndTeamData: event.organizationAndTeamData,
            repository: event.repository,
        });
    });
});
