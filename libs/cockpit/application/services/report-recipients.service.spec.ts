import { ReportRecipientsService } from './report-recipients.service';

describe('ReportRecipientsService', () => {
    let usersService: any;
    let review: any;
    let service: ReportRecipientsService;

    const ORG = 'org-1';

    beforeEach(() => {
        usersService = { find: jest.fn() };
        review = { getRepositoryNames: jest.fn() };
        service = new ReportRecipientsService(usersService, review);
    });

    describe('getOwners', () => {
        it('returns active owners with display names, skipping those with no email', async () => {
            usersService.find.mockResolvedValue([
                { email: 'owner@acme.com', teamMember: [{ name: 'Dana Lee' }] },
                { email: null },
                { email: 'second@acme.com' },
            ]);

            const owners = await service.getOwners(ORG);

            expect(owners).toEqual([
                { email: 'owner@acme.com', name: 'Dana' },
                { email: 'second@acme.com', name: 'second' },
            ]);
        });
    });

    describe('getRepoAdmins', () => {
        it('resolves assigned repo ids to warehouse names', async () => {
            usersService.find.mockResolvedValue([
                {
                    email: 'admin@acme.com',
                    teamMember: [{ name: 'Sam Carter' }],
                    permissions: {
                        permissions: { assignedRepositoryIds: ['r1', 'r2'] },
                    },
                },
            ]);
            review.getRepositoryNames.mockResolvedValue(
                new Map([
                    ['r1', 'acme/auth'],
                    ['r2', 'acme/api'],
                ]),
            );

            const admins = await service.getRepoAdmins(ORG);

            expect(admins).toEqual([
                {
                    email: 'admin@acme.com',
                    name: 'Sam',
                    repositories: ['acme/auth', 'acme/api'],
                },
            ]);
        });

        it('drops admins with no assigned repos (or no resolvable repos)', async () => {
            usersService.find.mockResolvedValue([
                {
                    email: 'none@acme.com',
                    permissions: { permissions: { assignedRepositoryIds: [] } },
                },
                {
                    email: 'stale@acme.com',
                    permissions: {
                        permissions: { assignedRepositoryIds: ['ghost'] },
                    },
                },
            ]);
            review.getRepositoryNames.mockResolvedValue(
                new Map([['r1', 'acme/auth']]),
            );

            const admins = await service.getRepoAdmins(ORG);

            expect(admins).toEqual([]);
        });

        it('returns empty without a warehouse lookup when there are no repo admins', async () => {
            usersService.find.mockResolvedValue([]);

            const admins = await service.getRepoAdmins(ORG);

            expect(admins).toEqual([]);
            expect(review.getRepositoryNames).not.toHaveBeenCalled();
        });
    });
});
