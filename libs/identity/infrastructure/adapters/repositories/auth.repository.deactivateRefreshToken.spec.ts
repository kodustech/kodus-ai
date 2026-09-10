import { AuthRepository } from './auth.repository';

/**
 * Guards the fix for the same TypeORM defect as #1894
 * (user-notification.repository): `Repository.update()` can't resolve a
 * nested relation path in its criteria — `update({ user: { uuid } }, ...)`
 * throws "Cannot find alias for relation at user" on the real query builder,
 * a failure an in-memory mock of `update()` never reproduces. `deactivateRefreshToken`
 * has no current caller (dead code), but carries the exact same shape as the
 * bug fixed elsewhere — fixed here too so it isn't a trap if ever wired up.
 */
describe('AuthRepository.deactivateRefreshToken — join-safe update', () => {
    const makeRepo = (found: any) => {
        const findOne = jest.fn().mockResolvedValue(found);
        const update = jest.fn().mockResolvedValue({ affected: found ? 1 : 0 });
        const repo = new AuthRepository({
            findOne,
            update,
        } as any);
        return { repo, findOne, update };
    };

    it('scopes via findOne, then updates by the record\'s own flat uuid', async () => {
        const { repo, update } = makeRepo({
            uuid: 'auth-1',
            refreshToken: 'token-abc',
            user: { uuid: 'user-1' },
        });

        await repo.deactivateRefreshToken({ uuid: 'user-1' });

        expect(update).toHaveBeenCalledWith(
            { uuid: 'auth-1' },
            { refreshToken: 'token-abc' },
        );
    });

    it('is a no-op when nothing matches (does not call update)', async () => {
        const { repo, update } = makeRepo(undefined);

        await repo.deactivateRefreshToken({ uuid: 'user-1' });

        expect(update).not.toHaveBeenCalled();
    });

    it('is a no-op when no uuid is provided', async () => {
        const { repo, findOne, update } = makeRepo(undefined);

        await repo.deactivateRefreshToken({});

        expect(findOne).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
    });
});
