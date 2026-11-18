import { parseRecipe } from './recipe';

// Capability selection reads the trusted raw recipe without expanding the public Expose wire.
describe('seeded observer SQL requirement', () => {
    it('marks an explicit read-only-account declaration for cell capability selection', () => {
        const out = parseRecipe(
            'version: 1\nservices: { expose: [{ service: db, port: 5432, kind: postgres, readonly_user_from_seed: true }] }\n',
        );
        expect(out).toMatchObject({
            ok: true,
            recipe: {
                seededSQL: true,
                expose: [{ service: 'db', port: 5432, kind: 'postgres' }],
            },
        });
        if (out.ok)
            expect(out.recipe.expose[0]).not.toHaveProperty(
                'readonly_user_from_seed',
            );
    });
    it.each([
        '',
        'services: { expose: [{ service: db, port: 5432, kind: postgres, readonly_user_from_seed: false }] }',
    ])('leaves ordinary recipes unchanged: %s', (body) => {
        const out = parseRecipe(`version: 1\n${body}\n`);
        expect(out.ok).toBe(true);
        if (out.ok) expect(out.recipe).not.toHaveProperty('seededSQL');
    });
});
