import { parseRecipe } from './recipe';

// The data-only reset strategy (docs/runtime/persistent-state.md section 11). The cell holds the same
// rules in apps/runtime-cell/internal/recipe (TestDataOnlyReset*), and
// fixtures/recipes/verdicts.json holds both to the same files.

const base = (data: string) => `version: 1
services:
  compose:
    files: [docker-compose.yml]
    public: web
  expose:
    - { service: web, port: 8080, kind: http }
data:
${data}`;

describe('data.reset: data-only', () => {
    // Behavior: a recipe that opts in to data-only is accepted and says so in its summary.
    it('is accepted and kept in the summary', () => {
        const r = parseRecipe(base('  reset: data-only\n'));
        expect(r.ok && r.recipe.reset).toBe('data-only');
    });

    // Behavior: recreate, the default, leaves the summary without a reset so existing recipes read as before.
    it('leaves the summary of a recreate recipe unchanged', () => {
        const r = parseRecipe(base('  reset: recreate\n'));
        expect(r.ok && 'reset' in r.recipe).toBe(false);
    });

    // Behavior: a recipe that names the data services keeps them, in order.
    it('keeps the data services it names', () => {
        const r = parseRecipe(base('  reset: data-only\n  services: [db, cache]\n'));
        expect(r.ok && r.recipe.dataServices).toEqual(['db', 'cache']);
    });

    // Behavior: data.services is refused unless the strategy is data-only, so a key that does nothing is never silent.
    it.each([
        ['without data-only', '  reset: snapshot\n  services: [db]\n', 'data.services needs data.reset: data-only'],
        ['empty', '  reset: data-only\n  services: []\n', 'between 1 and'],
        ['twice', '  reset: data-only\n  services: [db, db]\n', 'db twice'],
        ['the public service', '  reset: data-only\n  services: [web]\n', 'is the public service'],
        ['a bad name', '  reset: data-only\n  services: ["-db"]\n', 'bad service'],
        ['too many', `  reset: data-only\n  services: [${Array.from({ length: 9 }, (_, i) => `s${i}`).join(', ')}]\n`, 'between 1 and 8'],
    ])('refuses data.services %s', (_name, data, why) => {
        const r = parseRecipe(base(data));
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toContain(why);
    });

    // Behavior: an unknown strategy is still refused.
    it('refuses a strategy it does not know', () => {
        expect(parseRecipe(base('  reset: restart\n')).ok).toBe(false);
    });
});

describe('data.in_place', () => {
    // Behavior: the hints for the in-place reset are kept in the summary, with Runo's snake_case keys resolved.
    it('keeps the hints it names', () => {
        const r = parseRecipe(
            base('  reset: data-only\n  in_place:\n    postgres: [{ service: db, databases: [shop] }, { service: audit }]\n    firebase: { service: emu, import_dir: /seed/fb, project: demo-x }\n'),
        );
        expect(r.ok && r.recipe.inPlace).toEqual({
            postgres: [{ service: 'db', databases: ['shop'] }, { service: 'audit', databases: [] }],
            firebase: { service: 'emu', importDir: '/seed/fb', project: 'demo-x' },
        });
    });

    // Behavior: a recipe with no in-place hints leaves the summary without the key, so existing recipes read as before.
    it('leaves the summary of a recipe without hints unchanged', () => {
        const r = parseRecipe(base('  reset: data-only\n  in_place: {}\n'));
        expect(r.ok && 'inPlace' in r.recipe).toBe(false);
    });

    // Behavior: the same refusals as the cell, so a hint that would end up in a command is never accepted unsafe.
    it.each([
        ['without data-only', '  reset: snapshot\n  in_place: { off: true }\n', 'data.in_place needs data.reset: data-only'],
        ['a database with a quote', '  reset: data-only\n  in_place:\n    postgres: [{ service: db, databases: ["a;b"] }]\n', 'bad database'],
        ['a database too long', `  reset: data-only\n  in_place:\n    postgres: [{ service: db, databases: [${'a'.repeat(51)}] }]\n`, 'bad database'],
        ['a service twice', '  reset: data-only\n  in_place:\n    postgres: [{ service: db }, { service: db }]\n', 'db twice'],
        ['the public service', '  reset: data-only\n  in_place:\n    postgres: [{ service: web }]\n', 'is the public service'],
        ['a relative import dir', '  reset: data-only\n  in_place:\n    firebase: { service: emu, import_dir: seed }\n', 'absolute path'],
        ['an import dir that climbs', '  reset: data-only\n  in_place:\n    firebase: { service: emu, import_dir: /a/../b }\n', 'absolute path'],
        ['a bad project', '  reset: data-only\n  in_place:\n    firebase: { service: emu, import_dir: /s, project: "X Y" }\n', 'bad project'],
        ['emulators as a data service', '  reset: data-only\n  services: [emu]\n  in_place:\n    firebase: { service: emu, import_dir: /s }\n', 'part of the app'],
    ])('refuses in_place %s', (_name, data, why) => {
        const r = parseRecipe(base(data));
        expect(r.ok).toBe(false);
        expect(!r.ok && r.error).toContain(why);
    });
});
