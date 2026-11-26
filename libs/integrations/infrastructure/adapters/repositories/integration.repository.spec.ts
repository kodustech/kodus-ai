import { IntegrationRepository } from './integration.repository';

describe('IntegrationRepository.find', () => {
    const make = () => {
        const typeorm = { find: jest.fn().mockResolvedValue([]) };
        return {
            repository: new IntegrationRepository(typeorm as any),
            typeorm,
        };
    };

    it('reads nothing without an organization, so no query spans tenants', async () => {
        const { repository, typeorm } = make();

        expect(await repository.find({ platform: 'GITHUB' } as any)).toEqual(
            [],
        );
        expect(
            await repository.find({
                organization: { uuid: undefined },
                team: { uuid: undefined },
            } as any),
        ).toEqual([]);
        expect(typeorm.find).not.toHaveBeenCalled();
    });

    it('reads nothing when a team is asked for without its id', async () => {
        const { repository, typeorm } = make();

        expect(
            await repository.find({
                organization: { uuid: 'org-1' },
                team: { uuid: undefined },
            } as any),
        ).toEqual([]);
        expect(typeorm.find).not.toHaveBeenCalled();
    });

    it('lists connections oldest first', async () => {
        const { repository, typeorm } = make();

        await repository.find({
            organization: { uuid: 'org-1' },
            team: { uuid: 'team-1' },
        } as any);

        expect(typeorm.find).toHaveBeenCalledWith(
            expect.objectContaining({ order: { createdAt: 'ASC' } }),
        );
    });
});
