import { In } from 'typeorm';
import { RoutingRuleRepository } from './routing-rule.repository';

/**
 * Guards the fix for the same TypeORM defect as #1894
 * (user-notification.repository): `Repository.delete()` can't resolve a
 * nested relation path in its criteria — `delete({ organization: { uuid } })`
 * throws "Cannot find alias for relation at organization" on the real query
 * builder, a failure an in-memory mock of `delete()` never reproduces. The
 * fix scopes ids via `find` (which does support nested criteria) and deletes
 * by a flat `uuid`/`In(ids)` predicate.
 */
describe('RoutingRuleRepository — delete passes stay join-safe', () => {
    const makeRepo = (rows: Array<{ uuid: string }>) => {
        const find = jest.fn().mockResolvedValue(rows);
        const deleteFn = jest.fn().mockResolvedValue({ affected: rows.length });
        const repo = new RoutingRuleRepository({
            find,
            delete: deleteFn,
        } as any);
        return { repo, find, deleteFn };
    };

    describe('deleteByOrganization', () => {
        it('scopes via find, deletes every matched uuid with a flat In(ids), and returns the count', async () => {
            const { repo, find, deleteFn } = makeRepo([
                { uuid: 'r-1' },
                { uuid: 'r-2' },
            ]);

            const result = await repo.deleteByOrganization('org-1');

            expect(result).toBe(2);
            expect(find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: { organization: { uuid: 'org-1' } },
                }),
            );
            expect(deleteFn).toHaveBeenCalledWith({
                uuid: In(['r-1', 'r-2']),
            });
        });

        it('is a no-op when nothing matches (does not call delete)', async () => {
            const { repo, deleteFn } = makeRepo([]);

            const result = await repo.deleteByOrganization('org-1');

            expect(result).toBe(0);
            expect(deleteFn).not.toHaveBeenCalled();
        });
    });

    describe('deleteByOrgEventRole', () => {
        it('scopes via find on (org, event, role), deletes by flat In(ids), and returns the count', async () => {
            const { repo, find, deleteFn } = makeRepo([{ uuid: 'r-3' }]);

            const result = await repo.deleteByOrgEventRole(
                'org-1',
                'pr.opened',
                'developer',
            );

            expect(result).toBe(1);
            expect(find).toHaveBeenCalledWith(
                expect.objectContaining({
                    where: {
                        organization: { uuid: 'org-1' },
                        event: 'pr.opened',
                        role: 'developer',
                    },
                }),
            );
            expect(deleteFn).toHaveBeenCalledWith({ uuid: In(['r-3']) });
        });

        it('is a no-op when nothing matches (does not call delete)', async () => {
            const { repo, deleteFn } = makeRepo([]);

            const result = await repo.deleteByOrgEventRole(
                'org-1',
                'pr.opened',
                'developer',
            );

            expect(result).toBe(0);
            expect(deleteFn).not.toHaveBeenCalled();
        });
    });
});
