import { isTestLiteral, MAX_HEALTH_TIMEOUT_SECONDS, parseRecipe, RECIPE_NEEDS_SHAPE, recipeDurationSeconds, recipeNeedsConflict } from './recipe';

// The duration rules the cell holds too (apps/runtime-cell/internal/recipe,
// TestParseRefuses and TestHealthTimeoutIsCappedAtTheMostASetupWaits).

describe('recipeDurationSeconds', () => {
    it('reads a bare integer as seconds and a Go duration by its units', () => {
        expect(recipeDurationSeconds(300)).toBe(300);
        expect(recipeDurationSeconds('300')).toBe(300);
        expect(recipeDurationSeconds('+90')).toBe(90);
        expect(recipeDurationSeconds('+90s')).toBe(90);
        expect(recipeDurationSeconds('1h30m')).toBe(5_400);
        expect(recipeDurationSeconds('1500ms')).toBe(1.5);
    });

    it('reads zero as zero, a wait the recipe does not set', () => {
        for (const v of [0, '0', '0s', '0m']) expect([v, recipeDurationSeconds(v)]).toEqual([v, 0]);
    });

    it('refuses a negative wait, a fraction of a bare number and what is no duration', () => {
        for (const v of [-30, '-30', '-5m', 1.5, 'soon', true, null]) expect([v, recipeDurationSeconds(v)]).toEqual([v, undefined]);
    });

    it('refuses what a Go time.Duration cannot hold, as the cell does', () => {
        expect(recipeDurationSeconds(9_223_372_036)).toBe(9_223_372_036);
        expect(recipeDurationSeconds(9_223_372_037)).toBeUndefined();
        expect(recipeDurationSeconds('3000000h')).toBeUndefined();
    });
});

describe('parseRecipe health_timeout', () => {
    const recipe = (t: string) => parseRecipe(`version: 1\nservices: { compose: { health_timeout: ${t} } }\n`);

    it('caps a longer wait at the most a setup waits instead of refusing it', () => {
        expect(MAX_HEALTH_TIMEOUT_SECONDS).toBe(900);
        for (const [t, want] of [
            ['899', 899],
            ['900', 900],
            ['901', 900],
            ['20m', 900],
        ] as const) {
            expect([t, recipe(t)]).toMatchObject([t, { ok: true, recipe: { healthTimeoutSeconds: want } }]);
        }
    });

    it('reads a zero wait as not set, so a recipe that said 0 for the default still boots', () => {
        for (const t of ['0', '0s']) {
            const r = recipe(t);
            expect([t, r.ok]).toEqual([t, true]);
            if (r.ok) expect(r.recipe).not.toHaveProperty('healthTimeoutSeconds');
        }
    });

    it('refuses a negative wait', () => {
        for (const t of ['-30', '"-5m"']) expect(recipe(t)).toMatchObject({ ok: false, error: expect.stringContaining('bad duration') });
    });
});

describe('services.needs', () => {
    const recipe = 'version: 1\nservices:\n  compose: { public: api }\n  needs:\n    - { repo: acme/billing }\n    - { repo: acme/web, alias: front }\n';

    it('resolves each alias, the short name when none is given', () => {
        const r = parseRecipe(recipe);
        expect(r.ok && r.recipe.needs).toEqual([
            { repo: 'acme/billing', alias: 'billing' },
            { repo: 'acme/web', alias: 'front' },
        ]);
        for (const none of ['version: 1\n', 'version: 1\nservices:\n  needs: []\n']) {
            const p = parseRecipe(none);
            expect(p.ok && p.recipe).not.toHaveProperty('needs');
        }
    });

    it('takes strings only, as the cell does', () => {
        expect(parseRecipe('version: 1\nservices:\n  needs: [{ repo: acme/billing, alias: 123 }]\n')).toMatchObject({ ok: false, error: expect.stringContaining('services.needs[0].alias') });
        expect(parseRecipe('version: 1\nservices:\n  needs: [{ alias: billing }]\n')).toMatchObject({ ok: false, error: expect.stringContaining('services.needs[0].repo') });
        expect(parseRecipe('version: 1\nservices:\n  needs: [acme/billing]\n')).toMatchObject({ ok: false, error: expect.stringContaining('services.needs[0]') });
        expect(parseRecipe('version: 1\nservices:\n  needs: acme/billing\n')).toMatchObject({ ok: false, error: `recipe: ${RECIPE_NEEDS_SHAPE}` });
    });

    it('never names the environment\'s own repository, nor takes its alias', () => {
        const r = parseRecipe(recipe);
        const needs = r.ok ? r.recipe.needs : undefined;
        expect(recipeNeedsConflict(needs, { fullName: 'acme/shop', alias: 'shop' })).toBeUndefined();
        expect(recipeNeedsConflict(needs, { fullName: 'ACME/Billing', alias: 'shop' })).toContain("environment's own repository");
        expect(recipeNeedsConflict(needs, { fullName: 'acme/shop', alias: 'front' })).toContain('alias front');
        expect(recipeNeedsConflict(undefined, { fullName: 'acme/shop', alias: 'shop' })).toBeUndefined();
    });
});

// The same cases sit in apps/runtime-cell/internal/recipe (TestIsTestLiteral): the worker and the cell must agree.
const withEnv = (v: string) => `version: 1\nservices:\n  compose:\n    env: { ADMIN_TOKEN: ${v} }\n`;

describe('a test literal under a secret-looking name', () => {
    it('is accepted when its words say it is a fixture, as the repository\'s e2e specs write it', () => {
        for (const v of ['e2e-admin-token-only', 'test_admin_token', 'fake.token.local', 'dummy-password']) {
            expect([v, parseRecipe(withEnv(v)).ok]).toEqual([v, true]);
        }
    });

    it('is refused when the value is a real-looking credential, whatever words surround it', () => {
        for (const v of ['abc123', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'test-9f8a7b6c5d4e3f2a1b0c', 'e2e-sk-abcdefghijklmnopqrstuv', 'prod-admin-token', 'a3F9xQ2LmZ8vK1pR']) {
            expect([v, parseRecipe(withEnv(v)).ok]).toEqual([v, false]);
        }
    });

    it('is told apart by isTestLiteral on the same cases', () => {
        expect(isTestLiteral('e2e-admin-token-only')).toBe(true);
        expect(isTestLiteral('prod-admin-token')).toBe(false);
        expect(isTestLiteral('test-9f8a7b6c5d4e3f2a1b0c')).toBe(false);
    });
});
