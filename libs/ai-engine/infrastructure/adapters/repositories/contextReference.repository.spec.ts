import { ContextReferenceService } from '../services/context/context-reference.service';
import { ContextReferenceRepository } from './contextReference.repository';

/**
 * Reading the latest revision of an entity must read one row. Every rule save
 * reads it (twice: for the detection cache and for the new revision's parent),
 * and an entity gains a revision per save — loading the whole history to keep
 * its first row grew with every sync.
 */
describe('latest revision of an entity', () => {
    const row = (uuid: string) => ({
        uuid,
        scope: 'kodyRule',
        entityType: 'kodyRule',
        entityId: 'rule-1',
        createdAt: new Date(),
        updatedAt: new Date(),
    });

    function build(rows: unknown[]) {
        const orm = { find: jest.fn().mockResolvedValue(rows) };
        const repository = new ContextReferenceRepository(orm as any);
        const service = new ContextReferenceService(repository);
        return { orm, service };
    }

    it('asks the database for one row, newest first', async () => {
        const { orm, service } = build([row('rev-9')]);

        const latest = await service.getLatestRevision('kodyRule', 'rule-1');

        expect(latest?.uuid).toBe('rev-9');
        expect(orm.find).toHaveBeenCalledWith({
            where: { entityType: 'kodyRule', entityId: 'rule-1' },
            order: { createdAt: 'DESC' },
            take: 1,
        });
    });

    it('still reads the whole history when no limit is given', async () => {
        const { orm, service } = build([row('rev-2'), row('rev-1')]);

        const history = await service.getRevisionHistory('kodyRule', 'rule-1');

        expect(history.map((r) => r.uuid)).toEqual(['rev-2', 'rev-1']);
        expect(orm.find).toHaveBeenCalledWith({
            where: { entityType: 'kodyRule', entityId: 'rule-1' },
            order: { createdAt: 'DESC' },
        });
    });
});
