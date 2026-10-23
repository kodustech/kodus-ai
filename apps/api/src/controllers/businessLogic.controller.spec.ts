import { ForbiddenException } from '@nestjs/common';

import { BusinessLogicController } from './businessLogic.controller';

describe('BusinessLogicController.tryRead', () => {
    const build = (orgWide: boolean) => {
        const authorization = {
            ensure: jest.fn(async ({ repoIds }: { repoIds?: string[] }) => {
                // A repository-scoped admin: repo-a only, nothing org-wide.
                const allowed = repoIds
                    ? repoIds.every((id) => id === 'repo-a')
                    : orgWide;
                if (!allowed) {
                    throw new ForbiddenException();
                }
            }),
        };
        const trigger = { tryReadTask: jest.fn(async () => ({})) };
        const controller = new BusinessLogicController(
            { user: { organization: { uuid: 'org-1' } } } as any,
            {} as any,
            {} as any,
            trigger as any,
            authorization as any,
        );
        return { controller, trigger };
    };

    it("refuses a repository admin who names no repository: the org's tracker and model", async () => {
        const { controller, trigger } = build(false);
        await expect(
            controller.tryRead({ teamId: 'team-1', task: 'KOD-1' } as any),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(trigger.tryReadTask).not.toHaveBeenCalled();

        await controller.tryRead({
            teamId: 'team-1',
            task: 'KOD-1',
            repositoryId: 'repo-a',
        } as any);
        expect(trigger.tryReadTask).toHaveBeenCalledTimes(1);
    });

    it('lets an org-wide admin try without a repository', async () => {
        const { controller, trigger } = build(true);
        await controller.tryRead({ teamId: 'team-1', task: 'KOD-1' } as any);
        expect(trigger.tryReadTask).toHaveBeenCalledTimes(1);
    });
});
