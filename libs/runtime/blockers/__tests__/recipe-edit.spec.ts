import { applyRecipeChange } from '../recipe-edit';

const RECIPE = `# How Kody boots this repo
version: 1
services:
  compose:
    files: [docker-compose.yml]
    public: web   # the ready check
    health: /health
  expose:
    - { service: web, port: 3000, kind: http }
data:
  migrate: npm run migrate
`;

describe('applyRecipeChange', () => {
    it('adds an env block under services.compose and keeps every comment', () => {
        const r = applyRecipeChange(RECIPE, {
            path: ['env', 'STRIPE_KEY'],
            value: 'kodus-test-value',
        });
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.text).toContain('# How Kody boots this repo');
        expect(r.text).toContain('public: web   # the ready check');
        expect(r.text).toContain('    env:\n      STRIPE_KEY: "kodus-test-value"\n  expose:');
        expect(r.diff).toContain('+    env:');
        expect(r.diff).toContain('+      STRIPE_KEY: "kodus-test-value"');
        expect(r.diff.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))).toEqual([]);
    });

    it('adds to an existing env block, and replaces a key already there', () => {
        const withEnv = RECIPE.replace('    health: /health\n', '    health: /health\n    env:\n      A: "1"\n');
        const added = applyRecipeChange(withEnv, {
            path: ['env', 'B'],
            value: 'kodus-test-value',
        });
        expect(added.ok && added.text).toContain('      A: "1"\n      B: "kodus-test-value"\n');
        const replaced = applyRecipeChange(withEnv, {
            path: ['env', 'A'],
            value: 'kodus-test-value',
        });
        expect(replaced.ok && replaced.text).toContain('      A: "kodus-test-value"\n  expose:');
    });

    it('sets health_timeout, adding or replacing it', () => {
        const r = applyRecipeChange(RECIPE, {
            path: ['health_timeout'],
            value: '180s',
        });
        expect(r.ok && r.text).toContain('    health: /health\n    health_timeout: 180s\n');
        const again = r.ok
            ? applyRecipeChange(r.text, {
                  path: ['health_timeout'],
                  value: '240s',
              })
            : r;
        expect(again.ok && again.text).toContain('health_timeout: 240s');
        expect(again.ok && again.text.match(/health_timeout/g)?.length).toBe(1);
    });

    it('refuses what it cannot edit by hand, instead of rewriting the file', () => {
        expect(applyRecipeChange('version: 1\nservices: { compose: { public: web } }\n', { path: ['env', 'A'], value: 'x' })).toMatchObject({ ok: false });
        expect(
            applyRecipeChange('version: 1\n', {
                path: ['env', 'A'],
                value: 'x',
            }),
        ).toMatchObject({ ok: false });
        expect(applyRecipeChange('version: [', { path: ['env', 'A'], value: 'x' })).toMatchObject({ ok: false });
    });

    it('quotes the value so YAML never reads it as something else', () => {
        const r = applyRecipeChange(RECIPE, {
            path: ['env', 'FLAG'],
            value: 'yes: no #x',
        });
        expect(r.ok).toBe(true);
    });
});
