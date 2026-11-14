import { parseRecipe } from './recipe';

// §6: declared resource and network requirements must not be silently ignored.
describe('recipe declared resources', () => {
    it('normalizes the neutral size and exact egress declarations', () => {
        const result = parseRecipe(
            'version: 1\nsize: { cpu: 4, memory: 8gb, disk: 100gb }\negress: { allow: [API.Stripe.com] }\n',
        );
        expect(result).toMatchObject({
            ok: true,
            recipe: {
                size: { cpus: 4, memoryMb: 8192, diskGb: 100 },
                egressAllow: ['api.stripe.com'],
            },
        });
        if (result.ok)
            expect(result.recipe.unapplied ?? []).not.toEqual(
                expect.arrayContaining(['size', 'egress']),
            );
    });

    it.each([
        'size: { cpu: -1, memory: 8gb }',
        'size: { cpu: 1.5, memory: 8gb }',
        'size: { cpu: 4, memory: 0gb }',
        'size: { cpu: 4, memory: 8gb, disk: -1gb }',
        'size: { cpu: 4, memory: 8gb, typo: 1 }',
        'egress: { allow: ["*.example.com"] }',
        'egress: { allow: ["https://api.example.com"] }',
        'egress: { allow: ["127.0.0.1"] }',
        'egress: { allow: ["api.example.com"], typo: true }',
    ])('refuses malformed declared resources: %s', (field) => {
        expect(parseRecipe(`version: 1\n${field}\n`)).toMatchObject({
            ok: false,
        });
    });
});
