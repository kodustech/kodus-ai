import { requiredRecipeFeatures } from './recipe-features';

const sql =
    'services: { expose: [{ service: db, port: 5432, kind: postgres, readonly_user_from_seed: true }] }';
describe('trusted recipe execution requirements', () => {
    it('requires both independent execution features from the same base text', () => {
        expect(
            requiredRecipeFeatures({
                content: `version: 1\n${sql}\nfakes: { stripe: { image: stripe-mock } }\n`,
            }),
        ).toEqual({ ok: true, features: ['recipeFakes', 'seededSQL'] });
    });
    it.each([
        undefined,
        { content: null },
        { content: 'version: 1\nfakes: {}\n' },
    ])(
        'does not invent requirements for missing or empty declarations: %j',
        (recipe) => {
            expect(requiredRecipeFeatures(recipe)).toEqual({
                ok: true,
                features: [],
            });
        },
    );
    it.each([
        '',
        'version: 2',
        'version: 1\nfakes: {unknown: true}',
        'version: 1\nservices: { expose: [{ service: db, port: 5432, kind: postgres, readonly_user_from_seed: "yes" }] }',
    ])('invalid source is not an empty feature set: %s', (content) => {
        expect(requiredRecipeFeatures({ content })).toEqual({ ok: false });
    });
});
