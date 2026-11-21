import { readFileSync } from 'fs';
import { join } from 'path';
import { parseRecipe } from './recipe';

describe('explicit recipe validation checks', () => {
    it('preserves named checks without making them automatically applied boot work', () => {
        const parsed = parseRecipe(
            'version: 1\nvalidate: [{name: Unit tests, run: pnpm test}]\n',
        );
        expect(parsed).toMatchObject({
            ok: true,
            recipe: { validate: [{ name: 'Unit tests', run: 'pnpm test' }] },
        });
        if (parsed.ok)
            expect(parsed.recipe.unapplied ?? []).not.toContain('validate');
    });
    it.each([
        'validate: true',
        'validate: [{name: lint}]',
        'validate: [{name: lint, run: true}]',
        'validate: [{name: lint, run: make, cwd: /tmp}]',
        'validate: [{name: lint, run: make}, {name: lint, run: other}]',
        'validate: [{name: "", run: make}]',
        'validate: [{name: lint, run: "   "}]',
    ])('refuses malformed named check: %s', (value) => {
        expect(parseRecipe(`version: 1\n${value}\n`).ok).toBe(false);
    });
    it('bounds check count and command bytes', () => {
        for (const validate of [
            Array.from({ length: 33 }, (_, i) => ({
                name: `check${i}`,
                run: 'true',
            })),
            [{ name: 'lint', run: 'x'.repeat(8193) }],
        ]) {
            expect(
                parseRecipe(JSON.stringify({ version: 1, validate })).ok,
            ).toBe(false);
        }
    });
});

const validationCases = JSON.parse(
    readFileSync(
        join(__dirname, 'fixtures/recipes/validation-cases.json'),
        'utf8',
    ),
) as Array<{ name: string; yaml: string; accepted: boolean }>;
it.each(validationCases)('TS/Go validation parity: $name', (c) =>
    expect(parseRecipe(c.yaml).ok).toBe(c.accepted),
);
