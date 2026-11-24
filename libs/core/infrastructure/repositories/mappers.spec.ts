import { mapSimpleModelsToEntities } from './mappers';

describe('mapSimpleModelsToEntities', () => {
    const Entity = { create: (data: unknown) => data };

    it('maps an empty query result to an empty list', () => {
        expect(mapSimpleModelsToEntities([], Entity)).toEqual([]);
    });
});
