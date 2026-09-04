import { UserNotificationRepository } from './user-notification.repository';

/**
 * The notification feed belongs to a tenant, not to a person.
 *
 * `findByUser` filtered on the user alone, so someone who belongs to several
 * organizations received all of their notifications in one list, ordered by
 * date. The app-shell banner renders the most recent one — so an organization
 * whose only provider is Anthropic-compatible was told "Your Novita key is
 * failing", because the newest notification in that person's feed belonged to
 * a different customer entirely (verified in production: the Novita rows are
 * owned by another organization, and the org being viewed has never had a
 * Novita notification).
 *
 * The missing-id case is deliberate and load-bearing: an `undefined` spread
 * into a TypeORM `where` matches everything, which is how a filter that looks
 * present quietly stops filtering. Returning nothing is the safe direction.
 */

const makeRepo = () => {
    const findAndCount = jest.fn().mockResolvedValue([[], 0]);
    const repository = new UserNotificationRepository({
        findAndCount,
    } as any);
    return { repository, findAndCount };
};

describe('UserNotificationRepository.findByUser — one tenant at a time', () => {
    it('filters by the delivery organization, not only by the user', async () => {
        const { repository, findAndCount } = makeRepo();

        await repository.findByUser('user-1', {
            limit: 20,
            offset: 0,
            organizationId: 'org-a',
        });

        const args = findAndCount.mock.calls[0][0];
        expect(args.where).toMatchObject({
            user: { uuid: 'user-1' },
            delivery: { organization: { uuid: 'org-a' } },
        });
        // The relation has to be joined for the nested filter to apply.
        expect(args.relations).toContain('delivery.organization');
    });

    it('returns nothing when no organization is given, rather than everything', async () => {
        const { repository, findAndCount } = makeRepo();

        const result = await repository.findByUser('user-1', {
            limit: 20,
            offset: 0,
        });

        expect(result).toEqual({ data: [], total: 0 });
        // Never reaches the database: an unscoped query is the leak.
        expect(findAndCount).not.toHaveBeenCalled();
    });

    it('keeps the unread filter working alongside the organization filter', async () => {
        const { repository, findAndCount } = makeRepo();

        await repository.findByUser('user-1', {
            limit: 20,
            offset: 0,
            unreadOnly: true,
            organizationId: 'org-a',
        });

        const args = findAndCount.mock.calls[0][0];
        expect(args.where.delivery).toEqual({
            organization: { uuid: 'org-a' },
        });
        expect(args.where.readAt).toBeDefined();
    });

    describe('the write and count paths share the read path boundary', () => {
        const makeWritable = () => {
            const count = jest.fn().mockResolvedValue(0);
            const update = jest.fn().mockResolvedValue({ affected: 0 });
            const repository = new UserNotificationRepository({
                findAndCount: jest.fn().mockResolvedValue([[], 0]),
                count,
                update,
            } as any);
            return { repository, count, update };
        };

        it('counts unread only within the organization being viewed', async () => {
            // Scoping the list alone left the badge counting every organization
            // the user belongs to: 5 on the badge over a list of 2.
            const { repository, count } = makeWritable();

            await repository.countUnread('user-1', 'org-1');

            expect(count).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: expect.objectContaining({
                        delivery: { organization: { uuid: 'org-1' } },
                    }),
                }),
            );
        });

        it('marks all read only within the organization being viewed', async () => {
            // Unscoped, one click in one feed silently cleared unread markers in
            // every other organization -- notifications never shown, now gone.
            const { repository, update } = makeWritable();

            await repository.markAllAsRead('user-1', 'org-1');

            const [where] = update.mock.calls[0];
            expect(where).toEqual(
                expect.objectContaining({
                    delivery: { organization: { uuid: 'org-1' } },
                }),
            );
        });

        it('marks one read only within the organization being viewed', async () => {
            const { repository, update } = makeWritable();

            await repository.markAsRead('notif-1', 'user-1', 'org-1');

            const [where] = update.mock.calls[0];
            expect(where).toEqual(
                expect.objectContaining({
                    delivery: { organization: { uuid: 'org-1' } },
                }),
            );
        });

        it.each([
            ['countUnread', (r: any) => r.countUnread('user-1', undefined)],
            ['markAllAsRead', (r: any) => r.markAllAsRead('user-1', undefined)],
            ['markAsRead', (r: any) => r.markAsRead('n-1', 'user-1', undefined)],
        ])(
            '%s does nothing when there is no organization, rather than everything',
            async (_name, call) => {
                // A missing scope must never widen a read or a write. Failing
                // open here is the whole bug, one layer down.
                const { repository, count, update } = makeWritable();

                await call(repository);

                expect(update).not.toHaveBeenCalled();
                expect(count).not.toHaveBeenCalled();
            },
        );
    });
});
