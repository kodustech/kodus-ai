// eslint-disable-next-line @typescript-eslint/no-require-imports
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const os = require('os');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { spawnSync } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scaffold } = require('./new-eval');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { catalogProblems } = require('./eval-result');

describe('pnpm eval:new', () => {
    // The scaffold lives outside evals/ in the test, so it imports evals/shared
    // through a link: the generated runner requires '../shared/...'.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-new-'));
    fs.symlinkSync(path.join(__dirname), path.join(root, 'shared'));
    const dir = scaffold('demo-check', root);

    it('creates the README header, cases with a control pair, a catalog, floors and a runner', () => {
        for (const file of ['README.md', 'cases.json', 'catalog.js', 'targets.json', 'run.js']) expect(fs.existsSync(path.join(dir, file))).toBe(true);
        const readme = fs.readFileSync(path.join(dir, 'README.md'), 'utf8');
        for (const field of ['Answers', 'Runs', 'Run it', 'Gate', 'Cost']) expect(readme).toContain(`**${field}:**`);
        const cases = JSON.parse(fs.readFileSync(path.join(dir, 'cases.json'), 'utf8'));
        expect(cases.map((c: { expected: { items: string[] } }) => c.expected.items.length > 0)).toEqual([true, false]);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        expect(catalogProblems(require(path.join(dir, 'catalog.js')).catalog())).toEqual([]);
    });

    it('refuses a bad name or an existing eval', () => {
        expect(() => scaffold('Bad Name', root)).toThrow(/usage/);
        expect(() => scaffold('demo-check', root)).toThrow(/already exists/);
    });

    it('exits 2 with the reason until runCase calls the engine: not measured is never a pass', () => {
        const run = spawnSync(process.execPath, [path.join(dir, 'run.js'), '--model=eval-fake', '--gate'], {
            encoding: 'utf8',
            env: { ...process.env, EVAL_FAKE_LLM_KEY: 'x', EVAL_FAKE_LLM_URL: 'http://127.0.0.1:9' },
            cwd: path.join(__dirname, '..', '..'),
        });
        expect(run.status).toBe(2);
        expect(run.stderr).toContain('not wired: runCase must call the engine');
        expect(run.stderr).toContain('not measured');
    });
});
