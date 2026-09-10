import { In } from 'typeorm';
import { ParametersRepository } from './parameters.repository';

/**
 * Guards the fix for the same TypeORM defect as #1894
 * (user-notification.repository): `Repository.delete()` can't resolve a
 * nested relation path in its criteria — `delete({ team: { uuid } })` throws
 * "Cannot find alias for relation at team" on the real query builder, a
 * failure an in-memory mock of `delete()` never reproduces. The fix scopes
 * ids via `find` (which does support nested criteria) and deletes by a flat
 * `uuid`/`In(ids)` predicate.
 */
describe('ParametersRepository.deleteByTeamId — join-safe delete', () => {
    const makeRepo = (rows: Array<{ uuid: string }>) => {
        const find = jest.fn().mockResolvedValue(rows);
        const deleteFn = jest.fn().mockResolvedValue({ affected: rows.length });
        const repo = new ParametersRepository({
            find,
            delete: deleteFn,
        } as any);
        return { repo, find, deleteFn };
    };

    it('scopes via find on the team relation, then deletes by a flat In(ids)', async () => {
        const { repo, find, deleteFn } = makeRepo([
            { uuid: 'p-1' },
            { uuid: 'p-2' },
        ]);

        await repo.deleteByTeamId('team-1');

        expect(find).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { team: { uuid: 'team-1' } },
            }),
        );
        expect(deleteFn).toHaveBeenCalledWith({
            uuid: In(['p-1', 'p-2']),
        });
    });

    it('is a no-op when nothing matches (does not call delete)', async () => {
        const { repo, deleteFn } = makeRepo([]);

        await repo.deleteByTeamId('team-1');

        expect(deleteFn).not.toHaveBeenCalled();
    });
});
