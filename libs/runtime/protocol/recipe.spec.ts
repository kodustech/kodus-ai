import { MAX_HEALTH_TIMEOUT_SECONDS, parseRecipe, recipeDurationSeconds } from './recipe';

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
