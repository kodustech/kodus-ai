import { ENTITIES } from '@libs/core/infrastructure/database/typeorm/entities';
import { PrDecisionRecordModel } from '@libs/code-review/infrastructure/adapters/repositories/schemas/prDecisionRecord.model';

/**
 * The per-PR reconciler's row must be in the global entity registry.
 *
 * A model missing from `ENTITIES` fails at RUNTIME, not at boot: the
 * pipeline module's TypeORM connection reads this registry, and the
 * reconciler's first write dies with
 *
 *   No metadata for "PrDecisionRecordModel" was found.
 *
 * The migration creates the table, so the schema is there and the failure
 * looks like a database problem rather than a missing registration — which
 * is exactly what makes it expensive to diagnose. This test names the
 * requirement instead.
 */
describe('the entity registry', () => {
    it('registers the per-PR reconciler model', () => {
        expect(ENTITIES).toContain(PrDecisionRecordModel);
    });

    it('registers each entity exactly once', () => {
        const names = ENTITIES.map((entity) => entity.name);
        expect(new Set(names).size).toBe(names.length);
    });
});
