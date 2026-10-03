import { GetAssignedReposUseCase } from './get-assigned-repos.use-case';

describe('GetAssignedReposUseCase organization isolation', () => {
    const build = (organizationId: string | undefined = 'org-own') => {
        const records = [
            {
                user: { uuid: 'own', organization: { uuid: 'org-own' } },
                permissions: { assignedRepositoryIds: ['repo-own'] },
            },
            {
                user: { uuid: 'foreign', organization: { uuid: 'org-other' } },
                permissions: { assignedRepositoryIds: ['repo-other'] },
            },
        ];
        const permissions = {
            findOne: jest.fn(async (filter) =>
                records.find(
                    (record) =>
                        record.user.uuid === filter.user.uuid &&
                        (!filter.user.organization?.uuid ||
                            record.user.organization.uuid ===
                                filter.user.organization.uuid),
                ),
            ),
        };
        const request = { user: { organization: { uuid: organizationId } } };
        const users = {
            findOne: jest.fn(
                async (filter) =>
                    records.find(
                        (record) =>
                            record.user.uuid === filter.uuid &&
                            record.user.organization.uuid ===
                                filter.organization.uuid,
                    )?.user,
            ),
        };
        const useCase = new GetAssignedReposUseCase(
            permissions as any,
            request as any,
            users as any,
        );
        return { useCase, permissions };
    };

    it('does not reveal repositories of another organization', async () => {
        const { useCase } = build();
        await expect(useCase.execute({ userId: 'foreign' })).resolves.toEqual(
            [],
        );
    });

    it('still returns repositories of the caller organization', async () => {
        const { useCase } = build();
        await expect(useCase.execute({ userId: 'own' })).resolves.toEqual([
            'repo-own',
        ]);
    });

    it('does not query permissions without an organization', async () => {
        const { useCase, permissions } = build('');
        await expect(useCase.execute({ userId: 'own' })).resolves.toEqual([]);
        expect(permissions.findOne).not.toHaveBeenCalled();
    });
});
