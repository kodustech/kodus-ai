/**
 * The PR filter and the nightly trigger come from what the evals actually load,
 * not from a folder list. These pin the matching both depend on: a narrowed
 * filter must be reported, an unrelated change must not wake the nightly, and a
 * change to a loaded file, the lockfile or the floors must.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const fs = require('fs');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const os = require('os');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const path = require('path');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawnSync } = require('child_process');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { globToRegExp, uncovered, changedEngineFiles, readTrace } = require('./engine-files');

describe('engine files — GitHub paths globs', () => {
    it('lets ** span directories and keeps * inside one', () => {
        expect(globToRegExp('libs/**').test('libs/core/cache/cache.service.ts')).toBe(true);
        expect(globToRegExp('tsconfig*.json').test('tsconfig.build.json')).toBe(true);
        expect(globToRegExp('tsconfig*.json').test('apps/api/tsconfig.json')).toBe(false);
        expect(globToRegExp('.github/workflows/code-review-evals-*.yml').test('.github/workflows/code-review-evals-pr.yml')).toBe(true);
    });

    it('reports loaded files the filter would not trigger on, ignoring local env files', () => {
        const loaded = ['libs/core/a.ts', 'test/fixtures/ctx.ts', 'apps/api/main.ts', '.env', '.env.local'];
        expect(uncovered(loaded, ['libs/**', 'test/fixtures/**'])).toEqual(['apps/api/main.ts']);
    });
});

describe('engine files — nightly trigger', () => {
    const engineFiles = ['libs/core/cache/cache.service.ts', 'evals/investigation/run-recall.js'];

    it('ignores changes to files the eval never loads', () => {
        expect(changedEngineFiles(['apps/web/page.tsx', 'libs/core/unrelated.ts'], engineFiles)).toEqual([]);
    });

    it('wakes on a change to the harness that builds the watch list', () => {
        expect(changedEngineFiles(['evals/shared/engine-files.js', 'evals/wiring-smoke.js'], engineFiles)).toEqual(['evals/shared/engine-files.js', 'evals/wiring-smoke.js']);
    });

    it('wakes on a loaded file, the lockfile or the floors', () => {
        const changed = ['libs/core/cache/cache.service.ts', 'pnpm-lock.yaml', 'evals/investigation/targets.json', 'README.md'];
        expect(changedEngineFiles(changed, engineFiles)).toEqual(['libs/core/cache/cache.service.ts', 'pnpm-lock.yaml', 'evals/investigation/targets.json']);
    });

    it("wakes each eval on its own floors and verdict script, not another eval's", () => {
        const kodyRules = ['libs/code-review/kody.ts', 'evals/kody-rules/real-agent.js'];
        const changed = ['evals/investigation/targets.json', 'evals/kody-rules/kody-targets.json', 'evals/kody-rules/nightly-verdict.js'];
        expect(changedEngineFiles(changed, kodyRules, 'evals/kody-rules/real-agent.js')).toEqual(['evals/kody-rules/kody-targets.json', 'evals/kody-rules/nightly-verdict.js']);
        expect(changedEngineFiles(changed, engineFiles)).toEqual(['evals/investigation/targets.json']);
    });

    it('refuses to decide on a list that does not hold its own runner', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-files-'));
        const list = path.join(dir, 'files.txt');
        const changed = path.join(dir, 'changed.txt');
        fs.writeFileSync(list, 'libs/code-review/kody.ts\nevals/kody-rules/real-agent.js\n');
        fs.writeFileSync(changed, 'libs/code-review/kody.ts\n');
        const run = (...extra: string[]) => spawnSync(process.execPath, [path.join(__dirname, 'engine-files.js'), 'changed', list, changed, ...extra], { encoding: 'utf8' });
        expect(run().status).toBe(2);
        const kodyRules = run('--runner=evals/kody-rules/real-agent.js');
        expect(kodyRules.status).toBe(0);
        expect(kodyRules.stdout.trim()).toBe('libs/code-review/kody.ts');
    });
});

describe('engine files — trace hook', () => {
    it('records repo files loaded through require and sync or async reads, not node_modules', () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-loaded-'));
        const traceDir = path.join(cwd, 'trace');
        fs.mkdirSync(path.join(cwd, 'lib'));
        fs.writeFileSync(path.join(cwd, 'lib', 'dep.js'), 'module.exports = 1;');
        for (const file of ['data.json', 'async.json', 'callback.json', 'stream.json']) fs.writeFileSync(path.join(cwd, file), '{}');
        // Like the runners: a worker thread is alive when main calls
        // process.exit, and shares its pid. Main's list must survive.
        fs.writeFileSync(
            path.join(cwd, 'main.js'),
            "require('./lib/dep'); const fs = require('fs'); fs.readFileSync('data.json');" +
                "fs.promises.readFile('async.json'); fs.readFile('callback.json', () => {}); fs.createReadStream('stream.json').destroy();" +
                "const { Worker } = require('worker_threads');" +
                "const w = new Worker('setInterval(() => {}, 1000)', { eval: true });" +
                "w.on('online', () => process.exit(0));",
        );

        const result = spawnSync(process.execPath, ['--require', path.join(__dirname, 'trace-loaded.js'), 'main.js'], {
            cwd,
            env: { ...process.env, TRACE_LOADED_DIR: traceDir, TRACE_LOADED_LABEL: 'finder-recall', NODE_OPTIONS: '' },
        });

        expect(result.status).toBe(0);
        expect(readTrace(traceDir, 'finder-recall')).toEqual(['async.json', 'callback.json', 'data.json', 'lib/dep.js', 'main.js', 'stream.json']);
        fs.rmSync(cwd, { recursive: true, force: true });
    });
});
