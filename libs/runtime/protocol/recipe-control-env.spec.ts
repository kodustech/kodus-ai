import { readFileSync } from 'fs';
import { join } from 'path';

import { parseRecipe } from './recipe';
import CONTROL_ENV from './recipe-control-env.json';

// The same file runs in apps/runtime-cell/internal/recipe/control_env_test.go:
// one control-env deny list for the worker and the cell.

const refused = [...CONTROL_ENV.names, ...CONTROL_ENV.prefixes.map((p) => `${p}X`), ...CONTROL_ENV.cases.refused];

describe('recipe control env', () => {
    it('is byte-identical to the cell copy', () => {
        const ts = readFileSync(join(__dirname, 'recipe-control-env.json'));
        const go = readFileSync(join(__dirname, '../../../apps/runtime-cell/internal/recipe/recipe-control-env.json'));
        expect(go.equals(ts)).toBe(true);
    });

    it.each(refused)('a recipe never sets %s, in its env or a fake\'s', (name) => {
        for (const y of [
            `version: 1\nservices: { compose: { env: { ${name}: x } } }\n`,
            `version: 1\nfakes: { stripe: { image: stripe-mock, env: { ${name}: x } } }\n`,
        ]) {
            const r = parseRecipe(y);
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.error).toContain('changes what runs');
        }
    });

    it.each(CONTROL_ENV.cases.allowed)('accepts %s, an app name that only looks like one', (name) => {
        expect(parseRecipe(`version: 1\nservices: { compose: { env: { ${name}: x } } }\n`)).toMatchObject({ ok: true });
    });
});
