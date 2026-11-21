const { test } = require('node:test');
const assert = require('node:assert/strict');
const { selectRun, floorFor, versionsFor } = require('./options');
const all = require('./cases.json');
const targets = require('./targets.json');
const model = 'deepseek-v4-flash@fireworks';

test('selects the actual worker path by default, preserving explicit product comparison', () => {
    assert.equal(selectRun({}, all).plannerHost, 'worker');
    assert.equal(selectRun({ 'planner-host': 'product' }, all).plannerHost, 'product');
    assert.throws(() => selectRun({ 'planner-host': 'rust' }, all), /planner host/);
    assert.throws(() => selectRun({ sides: 'plannner' }, all), /side/);
});

test('diagnostic subsets cannot inherit the historical full-set floor', () => {
    for (const args of [{ cases: all[0].id }, { set: 'synthetic' }, { set: 'grafana' }, { sides: 'baseline' }]) {
        const selected = selectRun({ ...args, 'planner-host': 'product' }, all);
        assert.equal(floorFor(selected, all, targets.models[model]).floor, null);
        assert.match(floorFor(selected, all, targets.models[model]).reason, /calibrat/);
    }
});

test('the product full-set floor stays available; the worker requires its own calibration', () => {
    const full = selectRun({ 'planner-host': 'product', set: 'full' }, all);
    assert.equal(floorFor(full, all, targets.models[model]).floor, 0.93);
    assert.equal(floorFor(selectRun({}, all), all, targets.models[model]).floor, null);
    assert.equal(floorFor(full, all, undefined).floor, null);
});

test('refuses unknown filters and repeated selections instead of silently scoring a smaller set', () => {
    for (const args of [{ set: 'typo' }, { cases: `${all[0].id},typo` }, { cases: `${all[0].id},${all[0].id}` }, { sides: 'planner,planner' }]) {
        assert.throws(() => selectRun(args, all));
    }
});

test('provenance hashes actual loaded production sources and dataset without their contents', () => {
    const selected = selectRun({}, all);
    const root = require('path').resolve(__dirname, '../..');
    const file = require('path').join(root, 'apps/runtime/src/worker/agent/worker-plan-client.ts');
    const version = versionsFor({ root, selected, all, files: [file, __filename] });
    assert.equal(version.plannerHost, 'worker');
    assert.equal(version.evidence, 'plan-contracts-with-recorded-exec');
    assert.match(version.datasetSha256, /^[a-f0-9]{64}$/);
    assert.match(version.sourceSha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(version.sources.map((f) => f.path), ['apps/runtime/src/worker/agent/worker-plan-client.ts', 'evals/runtime-test-planner/options.test.js']);
    assert.equal(JSON.stringify(version).includes(root), false);
    assert.equal(JSON.stringify(version).includes('WorkerRunPlanClient implements'), false);
    assert.notEqual(versionsFor({ root, selected, all: [...all].reverse(), files: [file, __filename] }).datasetSha256, version.datasetSha256);
});

test('dataset provenance changes when a recorded repository input changes', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-eval-dataset-'));
    const area = path.join(root, 'evals/runtime-test-planner');
    try {
        fs.mkdirSync(area, { recursive: true });
        fs.cpSync(path.join(__dirname, 'fixtures'), path.join(area, 'fixtures'), { recursive: true });
        fs.copyFileSync(path.join(__dirname, 'base-machines.js'), path.join(area, 'base-machines.js'));
        const selected = selectRun({}, all);
        const before = versionsFor({ root, selected, all, files: [] });
        const file = before.fixtureFiles[0].path;
        fs.appendFileSync(path.join(root, file), '\n// changed repository input\n');
        const after = versionsFor({ root, selected, all, files: [] });
        assert.notEqual(after.datasetSha256, before.datasetSha256);
        assert.match(before.recordedExecSha256, /^[a-f0-9]{64}$/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('narrowed gates and unknown hosts exit not-measured before loading credentials or providers', () => {
    const { spawnSync } = require('child_process');
    const path = require('path');
    for (const args of [
        ['--planner-host=product', '--gate', '--set=synthetic', '--load-env'],
        ['--planner-host=worker', '--gate', '--load-env'],
        ['--planner-host=typo', '--load-env'],
    ]) {
        const child = spawnSync(process.execPath, [path.join(__dirname, 'run.js'), ...args], {
            env: {}, encoding: 'utf8', timeout: 3000,
        });
        assert.equal(child.status, 2, child.stderr);
        assert.match(child.stderr, /^not measured:/);
        assert.equal(child.stdout, '');
    }
});

test('pinned Git data supplies the head checks required by the worker source authority', async () => {
    const { codeManagementOver } = require('./sources');
    const shas = { base: 'b'.repeat(40), head: 'a'.repeat(40), baseRef: 'base', headRef: 'head' };
    let checks = 0;
    const git = codeManagementOver({ check: async () => { checks++; } }, shas);
    assert.equal(typeof git.getPullRequest, 'function');
    const pr = await git.getPullRequest();
    assert.equal(pr.head.sha, shas.head);
    assert.equal(pr.base.sha, shas.base);
    assert.equal(pr.head.repo.id, pr.base.repo.id);
    assert.equal(checks, 1);
});

test('only explicit load-env reads credential files and inherited dotenv/config points at the null device', () => {
    const { prepareEnvironment } = require('./environment');
    const os = require('os'), path = require('path');
    const env = { HOME: '/synthetic-operator', DOTENV_CONFIG_PATH: '/must-not-read' };
    const calls = [];
    prepareEnvironment({ root: '/synthetic-repo', env, config: (opts) => calls.push(opts) });
    assert.deepEqual(calls, []);
    assert.equal(env.DOTENV_CONFIG_PATH, os.devNull);
    prepareEnvironment({ root: '/synthetic-repo', env, loadEnv: true, config: (opts) => calls.push(opts) });
    assert.deepEqual(calls.map((c) => c.path), [path.join('/synthetic-repo', '.env'), path.join('/synthetic-repo', '.env.local'), path.join('/synthetic-operator', '.kodus-dev/config')]);
    assert.equal(env.DOTENV_CONFIG_PATH, os.devNull);
});

test('a missing calibration input is not-measured without reflecting filesystem errors', () => {
    const fs = require('fs'), os = require('os'), path = require('path');
    const { spawnSync } = require('child_process');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-eval-preflight-'));
    try {
        const preload = path.join(scratch, 'refuse-fixture.cjs');
        fs.writeFileSync(preload, `const fs = require('fs'); const original = fs.readdirSync; fs.readdirSync = function (target, ...args) { if (String(target).includes('runtime-test-planner/fixtures')) throw new Error('DO_NOT_REFLECT_PRIVATE_PATH'); return original.call(this, target, ...args); };`);
        const child = spawnSync(process.execPath, ['--require', preload, path.join(__dirname, 'run.js'), '--planner-host=product', '--gate'], { env: {}, encoding: 'utf8', timeout: 3000 });
        assert.equal(child.status, 2, child.stderr);
        assert.match(child.stderr, /^not measured:/);
        assert.equal(child.stderr.includes('DO_NOT_REFLECT_PRIVATE_PATH'), false);
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});

test('importing production crypto cannot load a synthetic cwd credential file by default', () => {
    const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
    const { spawnSync } = require('child_process');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-eval-env-'));
    try {
        const file = path.join(scratch, '.env');
        fs.writeFileSync(file, 'RUNTIME_EVAL_SENTINEL=must-not-load\n');
        const root = path.resolve(__dirname, '../..');
        const script = `process.chdir(process.argv[1]); require(process.argv[2]).prepareEnvironment({root:process.argv[1]}); require(process.argv[3]); require(process.argv[4]); if (process.env.RUNTIME_EVAL_SENTINEL) process.exit(1); console.log('default-env-refused');`;
        const child = spawnSync(process.execPath, ['-e', script, scratch, path.join(__dirname, 'environment.js'), require.resolve('ts-node/register/transpile-only'), path.join(root, 'libs/common/utils/crypto.ts')], {
            env: { API_CRYPTO_KEY: crypto.randomBytes(32).toString('hex'), TS_NODE_PROJECT: path.join(root, 'tsconfig.json'), DOTENV_CONFIG_PATH: file },
            encoding: 'utf8', timeout: 5000,
        });
        assert.equal(child.status, 0, child.stderr);
        assert.equal(child.stdout.trim(), 'default-env-refused');
    } finally { fs.rmSync(scratch, { recursive: true, force: true }); }
});
