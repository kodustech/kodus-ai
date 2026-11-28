import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const runner = fileURLToPath(new URL('./run.mjs', import.meta.url));

test('default invocation plans exact Runtime tests without executing them', () => {
    const result = spawnSync(process.execPath, [runner], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.mode, 'plan');
    assert.ok(manifest.selected.length > 0);
    assert.ok(manifest.selected.every((entry) => entry.status === 'not_run'));
    assert.ok(manifest.selected.every((entry) => entry.layer === 'unit'));
});

for (const args of [
    ['--layers=typo'],
    ['--layers='],
    ['--unknown'],
    ['--layers=unit', '--layers=browser'],
]) {
    test(`refuses invalid arguments: ${args.join(' ')}`, () => {
        const result = spawnSync(process.execPath, [runner, ...args], {
            encoding: 'utf8',
        });
        assert.equal(result.status, 2);
        assert.equal(JSON.parse(result.stdout).status, 'not_measured');
    });
}

test('unit plan excludes every integration and SDK transport file', () => {
    const result = spawnSync(process.execPath, [runner, '--layers=unit'], {
        encoding: 'utf8',
    });
    const manifest = JSON.parse(result.stdout);
    assert.ok(
        manifest.selected.every(({ path }) => !path.includes('.integration.')),
    );
    assert.ok(
        manifest.excluded.some(
            ({ path, reason }) =>
                path.endsWith('go-cell-hub.integration.spec.ts') &&
                reason === 'layer_not_selected',
        ),
    );
});

test('an unsupported service request refuses the whole run before starting offline tests', () => {
    const result = spawnSync(
        process.execPath,
        [runner, '--run', '--layers=unit,postgres', '--allow-fixture=postgres'],
        { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.reason, 'fixture_adapter_unavailable');
    assert.ok(manifest.selected.every(({ status }) => status === 'not_run'));
    assert.equal(manifest.artifactRoot, undefined);
});

test('local SDK HTTP fixtures need explicit opt-in despite lacking external services', () => {
    const result = spawnSync(
        process.execPath,
        [runner, '--run', '--layers=sdk'],
        { encoding: 'utf8' },
    );
    assert.equal(result.status, 2);
    assert.equal(JSON.parse(result.stdout).reason, 'fixture_opt_in_required');
});

const {
    chmod,
    lstat,
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    symlink,
    writeFile,
} = await import('node:fs/promises');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const {
    childEnvironment,
    createArtifacts,
    executePlan,
    inspectInventory,
    runCommand,
    summarizeJest,
    validateInventory,
    JEST_BATCH_SIZE,
} = await import('./harness.mjs');

async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), 'runtime-harness-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
}

test('runner passes a clean explicit environment and a private home', () => {
    const env = childEnvironment(
        {
            PATH: '/safe/bin',
            HOME: '/customer',
            NODE_OPTIONS: '--require /customer/hook',
            DATABASE_URL: 'sensitive',
            RUNTIME_IT_DATABASE_URL: 'sensitive',
            AWS_SECRET_ACCESS_KEY: 'sensitive',
            HTTP_PROXY: 'sensitive',
            GITHUB_TOKEN: 'sensitive',
            BROWSER_CONTEXT_DOCKERSMOKE: '1',
        },
        '/owned',
    );
    assert.deepEqual(
        Object.keys(env).sort(),
        [
            'API_LOG_LEVEL',
            'API_NODE_ENV',
            'CI',
            'DBOS__CLOUD',
            'DOTENV_CONFIG_PATH',
            'HOME',
            'LANG',
            'NODE_ENV',
            'NODE_OPTIONS',
            'PATH',
            'SKIP_INTEGRATION',
            'TEMP',
            'TMP',
            'TMPDIR',
            'TZ',
        ].sort(),
    );
    assert.equal(env.HOME, '/owned');
    assert.equal(env.NODE_OPTIONS, '--max-old-space-size=768');
    assert.equal(env.DBOS__CLOUD, 'false');
});

test('catalog rejects unsafe paths, duplicate ownership and integration in unit', () => {
    for (const path of [
        '../outside.spec.ts',
        '/absolute.spec.ts',
        'a/../outside.spec.ts',
        'a\\outside.spec.ts',
        '-option.spec.ts',
        '.env',
    ]) {
        assert.throws(() =>
            validateInventory({
                version: 1,
                roots: ['tests'],
                layers: { unit: [path] },
            }),
        );
    }
    assert.throws(() =>
        validateInventory({
            version: 1,
            roots: ['tests'],
            layers: { unit: ['tests/a.spec.ts'], sdk: ['tests/a.spec.ts'] },
        }),
    );
    assert.throws(() =>
        validateInventory({
            version: 1,
            roots: ['tests'],
            layers: { unit: ['tests/a.integration.spec.ts'] },
        }),
    );
});

test('new unclassified test is refused instead of joining the offline run', async (t) => {
    const root = await fixture(t);
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'tests', 'safe.spec.ts'), '');
    const inventory = {
        version: 1,
        roots: ['tests'],
        layers: { unit: ['tests/safe.spec.ts'] },
    };
    await inspectInventory(root, inventory);
    await writeFile(join(root, 'tests', 'unexpected.integration.spec.ts'), '');
    await assert.rejects(inspectInventory(root, inventory), {
        code: 'inventory_drift',
    });
});

test('drift names every unlisted test, so the fix is to list exactly those', async (t) => {
    const root = await fixture(t);
    await mkdir(join(root, 'tests', 'deep'), { recursive: true });
    await writeFile(join(root, 'tests', 'safe.spec.ts'), '');
    await writeFile(join(root, 'tests', 'new.spec.ts'), '');
    await writeFile(join(root, 'tests', 'deep', 'other.test.mjs'), '');
    await assert.rejects(
        inspectInventory(root, {
            version: 1,
            roots: ['tests'],
            layers: { unit: ['tests/safe.spec.ts'] },
        }),
        (error) => {
            assert.equal(error.code, 'inventory_drift');
            assert.deepEqual(error.unlisted, [
                'tests/deep/other.test.mjs',
                'tests/new.spec.ts',
            ]);
            return true;
        },
    );
});

test('every Runtime test below the inventoried roots is listed', () => {
    const result = spawnSync(
        process.execPath,
        [runner, '--plan', '--layers=unit,browser,planner-options,planner-host'],
        { encoding: 'utf8' },
    );
    const manifest = JSON.parse(result.stdout);
    assert.deepEqual(manifest.unlisted ?? [], []);
    assert.equal(manifest.reason, undefined);
    assert.equal(result.status, 0);
});

test('symlinks cannot redirect catalog discovery outside its root', async (t) => {
    const root = await fixture(t);
    await mkdir(join(root, 'tests'));
    await writeFile(join(root, 'outside.spec.ts'), '');
    await symlink(
        '../outside.spec.ts',
        join(root, 'tests', 'redirect.spec.ts'),
    );
    await assert.rejects(
        inspectInventory(root, {
            version: 1,
            roots: ['tests'],
            layers: { unit: ['tests/redirect.spec.ts'] },
        }),
        { code: 'symlink_in_inventory' },
    );
});

test('each run owns a new private artifact directory without reusing prior results', async (t) => {
    const root = await fixture(t);
    const first = await createArtifacts(root),
        second = await createArtifacts(root);
    assert.notEqual(first, second);
    assert.equal((await lstat(first)).mode & 0o777, 0o700);
});

test('Jest result must account for every selected file without extra suites', () => {
    const root = '/repo',
        selected = ['tests/a.spec.ts', 'tests/b.spec.ts'];
    const passed = {
        name: '/repo/tests/a.spec.ts',
        status: 'passed',
        assertionResults: [{ status: 'passed' }],
    };
    assert.throws(
        () => summarizeJest({ testResults: [passed] }, selected, root),
        { code: 'runner_result_incomplete' },
    );
    assert.throws(
        () =>
            summarizeJest(
                {
                    testResults: [
                        passed,
                        { ...passed, name: '/repo/extra.spec.ts' },
                    ],
                },
                selected,
                root,
            ),
        { code: 'runner_result_invalid' },
    );
    assert.deepEqual(
        summarizeJest({ testResults: [passed] }, [selected[0]], root),
        [
            {
                path: selected[0],
                status: 'passed',
                counts: { passed: 1, failed: 0, skipped: 0 },
            },
        ],
    );
});

test('an empty passing Jest suite never establishes successful validation', () => {
    assert.throws(
        () =>
            summarizeJest(
                {
                    testResults: [
                        {
                            name: '/repo/tests/a.spec.ts',
                            status: 'passed',
                            assertionResults: [],
                        },
                    ],
                },
                ['tests/a.spec.ts'],
                '/repo',
            ),
        { code: 'runner_result_empty' },
    );
});

test('command timeout is bounded and reports failure without raw error text', async (t) => {
    const root = await fixture(t);
    const result = await runCommand({
        executable: process.execPath,
        argv: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: root,
        env: childEnvironment(process.env, root),
        logPath: join(root, 'timeout.log'),
        timeoutMs: 100,
    });
    assert.equal(result.timedOut, true);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.signal, 'SIGKILL');
    assert.equal((await lstat(join(root, 'timeout.log'))).mode & 0o777, 0o600);
});

test('browser execution records each selected file and its skip count', async (t) => {
    const root = await fixture(t);
    await mkdir(join(root, 'tests'));
    await writeFile(
        join(root, 'tests', 'safe.test.mjs'),
        "import test from 'node:test'; test('healthy', () => {}); test('unavailable', { skip: true }, () => {});\n",
    );
    const plan = {
        version: 1,
        mode: 'run',
        status: 'not_measured',
        selected: [
            {
                layer: 'browser',
                path: 'tests/safe.test.mjs',
                status: 'not_run',
            },
        ],
        excluded: [],
    };
    const result = await executePlan({
        root,
        plan,
        options: { run: true, layers: ['browser'], fixtures: [] },
        parentEnv: process.env,
    });
    t.after(() =>
        rm(result.manifest.artifactRoot, { recursive: true, force: true }),
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.manifest.status, 'passed_with_skips');
    assert.deepEqual(result.manifest.selected[0].counts, {
        passed: 1,
        failed: 0,
        skipped: 1,
    });
    assert.equal(
        (await lstat(join(result.manifest.artifactRoot, 'manifest.json')))
            .mode & 0o777,
        0o600,
    );
});

test('command output is bounded without exhausting the validation volume', async (t) => {
    const root = await fixture(t);
    const result = await runCommand({
        executable: process.execPath,
        argv: ['-e', "process.stdout.write('x'.repeat(4096))"],
        cwd: root,
        env: childEnvironment(process.env, root),
        logPath: join(root, 'bounded.log'),
        maxLogBytes: 512,
    });
    assert.equal(result.outputLimitReached, true);
    assert.ok((await lstat(join(root, 'bounded.log'))).size <= 512);
});

test('planner contract layer selects the worker contract and options without the quality runner', () => {
    const result = spawnSync(
        process.execPath,
        [runner, '--plan', '--layers=planner-options,planner-host'],
        { encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    const manifest = JSON.parse(result.stdout);
    assert.deepEqual(manifest.selected.map(({ path }) => path).sort(), [
        'evals/runtime-test-planner/options.test.js',
        'evals/runtime-test-planner/planner-host.spec.ts',
    ]);
    assert.ok(manifest.selected.every(({ path }) => !path.endsWith('/run.js')));
});

test('manifest identifies runtime, runner and exact selected test bytes without attesting the production graph', () => {
    const result = spawnSync(
        process.execPath,
        [runner, '--plan', '--layers=planner-options'],
        { encoding: 'utf8' },
    );
    const manifest = JSON.parse(result.stdout);
    assert.equal(manifest.runtime.nodeVersion, process.version);
    assert.equal(manifest.runtime.platform, process.platform);
    assert.equal(manifest.runtime.arch, process.arch);
    assert.equal(manifest.provenance.scope, 'selected_tests_and_harness_only');
    assert.equal(manifest.provenance.productionGraph, 'not_attested');
    assert.match(
        manifest.provenance.selectedTestSha256[
            'evals/runtime-test-planner/options.test.js'
        ],
        /^[a-f0-9]{64}$/,
    );
    assert.equal(Object.keys(manifest.provenance.selectedTestSha256).length, 1);
    assert.match(
        manifest.provenance.runnerSha256[
            'scripts/runtime-validation/harness.mjs'
        ],
        /^[a-f0-9]{64}$/,
    );
});

test('a process startup failure is not a measured test failure', async (t) => {
    const root = await fixture(t);
    const result = await executePlan({
        root,
        plan: {
            version: 1,
            mode: 'run',
            status: 'not_measured',
            selected: [
                {
                    layer: 'browser',
                    path: 'fixture.test.mjs',
                    status: 'not_run',
                },
            ],
            excluded: [],
        },
        options: { run: true, layers: ['browser'], fixtures: [] },
        executable: join(root, 'absent-runtime'),
    });
    t.after(() =>
        rm(result.manifest.artifactRoot, { recursive: true, force: true }),
    );
    assert.equal(result.exitCode, 2);
    assert.equal(result.manifest.status, 'not_measured');
    assert.equal(result.manifest.reason, 'runner_start_failed');
    assert.equal(result.manifest.selected[0].status, 'not_run');
});

test('child environment disables transitive dotenv discovery', () => {
    const env = childEnvironment({}, '/owned');
    assert.equal(
        env.DOTENV_CONFIG_PATH,
        process.platform === 'win32' ? 'NUL' : '/dev/null',
    );
});

test('dotenv/config cannot load a synthetic cwd credential through the child environment', async (t) => {
    const dotenv = fileURLToPath(
        new URL('../../node_modules/dotenv/config.js', import.meta.url),
    );
    if (!(await lstat(dotenv).catch(() => null))?.isFile()) {
        t.skip('dotenv dependency unavailable; path contract remains checked');
        return;
    }
    const root = await fixture(t);
    await writeFile(
        join(root, '.env'),
        'RUNTIME_HARNESS_SYNTHETIC_SENTINEL=synthetic_value\n',
        { mode: 0o600 },
    );
    const result = spawnSync(
        process.execPath,
        [
            '-r',
            dotenv,
            '-e',
            "process.stdout.write(JSON.stringify({ hasFixtureValue: Object.hasOwn(process.env, 'RUNTIME_HARNESS_SYNTHETIC_SENTINEL') }))",
        ],
        { cwd: root, env: childEnvironment({}, root), encoding: 'utf8' },
    );
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout), { hasFixtureValue: false });
});

test('a Jest layer runs in processes of a bounded number of suites, and every suite gets its own result', async (t) => {
    const root = await realpath(await fixture(t));
    await mkdir(join(root, 'node_modules/jest/bin'), { recursive: true });
    // A stand-in for Jest that dies like an out-of-memory run when one process
    // is handed more suites than a batch, and otherwise reports each one passed.
    await writeFile(
        join(root, 'node_modules/jest/bin/jest.js'),
        `const { writeFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const paths = args.slice(args.indexOf('--runTestsByPath') + 1, args.indexOf('--json'));
const out = args.find((arg) => arg.startsWith('--outputFile=')).slice('--outputFile='.length);
if (paths.length > ${JEST_BATCH_SIZE}) process.exit(134);
writeFileSync(out, JSON.stringify({ testResults: paths.map((path) => ({ name: join(process.cwd(), path), status: 'passed', assertionResults: [{ status: 'passed' }] })) }));
`,
    );
    const selected = Array.from({ length: JEST_BATCH_SIZE * 2 + 1 }, (_, i) => ({
        layer: 'unit',
        path: `tests/suite-${i}.spec.ts`,
        status: 'not_run',
    }));
    const result = await executePlan({
        root,
        plan: { version: 1, mode: 'run', status: 'not_measured', selected, excluded: [] },
        options: { run: true, layers: ['unit'], fixtures: [] },
        parentEnv: process.env,
    });
    t.after(() =>
        rm(result.manifest.artifactRoot, { recursive: true, force: true }),
    );
    assert.equal(result.exitCode, 0, result.manifest.reason);
    assert.equal(result.manifest.commands.length, 3);
    assert.ok(result.manifest.selected.every(({ status }) => status === 'passed'));
});
