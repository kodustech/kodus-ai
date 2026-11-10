import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { parseRecipe } from './recipe';

// ENV-08: the worker reads every recipe the way the cell does
// (apps/runtime-cell/internal/recipe/contract_test.go holds the cell to the
// same file), so a recipe the worker records never fails later at the cell.
const root = join(__dirname, '../../..');
const fixtures = join(__dirname, 'fixtures/recipes');
const { recipes } = JSON.parse(readFileSync(join(fixtures, 'verdicts.json'), 'utf8')) as {
    recipes: Record<string, { cell: string; runo: string; why?: string; healthTimeoutSeconds?: number; healthTimeoutDefault?: boolean; unapplied?: string[];
            size?: unknown;
            egressAllow?: string[]; fakes?: unknown[] }>;
};

describe('recipe contract (ENV-08)', () => {
    it.each(Object.entries(recipes))('%s: the worker gives the cell verdict', (path, v) => {
        const r = parseRecipe(readFileSync(join(root, path), 'utf8'));
        if (v.cell === 'accept') {
            expect('error' in r ? r.error : 'accepted').toBe('accepted');
            // The wait the cell gives (recipe.HealthTimeout, contract_test.go): the worker reads the same.
            if (v.healthTimeoutSeconds !== undefined && r.ok) expect(r.recipe.healthTimeoutSeconds).toBe(v.healthTimeoutSeconds);
            // No wait of its own (health_timeout: 0 is "not set"): the setup's default applies, as the cell's does.
            if (v.healthTimeoutDefault && r.ok) expect(r.recipe).not.toHaveProperty('healthTimeoutSeconds');
            // The keys no cell acts on yet (recipe.Unapplied in the cell): the worker names the same ones.
            if (r.ok) {
                    expect(r.recipe.unapplied ?? []).toEqual(v.unapplied ?? []);
                    if (v.size) expect(r.recipe.size).toEqual(v.size);
                    if (v.fakes) expect(r.recipe.fakes).toEqual(v.fakes);
                    if (v.egressAllow)
                        expect(r.recipe.egressAllow).toEqual(v.egressAllow);
                }
            } else {
            expect(v.cell.startsWith('refuse: ')).toBe(true);
            expect('error' in r ? r.error : 'accepted').toContain(v.cell.slice('refuse: '.length));
        }
    });

    it('lists every fixture and every recipe Kodus ships', () => {
        const ours = readdirSync(join(root, '.kodus'))
            .filter((f) => /^workspace.*\.yaml$/.test(f))
            .map((f) => `.kodus/${f}`);
        const fx = readdirSync(fixtures)
            .filter((f) => f.endsWith('.yaml'))
            .map((f) => `libs/runtime/protocol/fixtures/recipes/${f}`);
        expect([...ours, ...fx].filter((p) => !(p in recipes))).toEqual([]);
        for (const [path, v] of Object.entries(recipes)) if (v.cell !== v.runo) expect([path, v.why ?? '']).not.toEqual([path, '']);
    });
});

describe('recipe.schema.json', () => {
    it('is what recipeJsonSchema generates (regenerate with scripts/dump-recipe-schema.ts)', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { recipeJsonSchema } = require('./recipe');
        expect(JSON.parse(readFileSync(join(__dirname, 'recipe.schema.json'), 'utf8'))).toEqual(recipeJsonSchema());
    });
});
