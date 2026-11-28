import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import {
    chmod,
    lstat,
    mkdtemp,
    readFile,
    readdir,
    realpath,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

const EXECUTABLE = new Set([
    'unit',
    'sdk',
    'browser',
    'planner-options',
    'planner-host',
]);
const NODE_LAYERS = new Set(['browser', 'planner-options']);
// The unit project leaves the Runtime's *.integration.spec.ts out
// (jest.config.ts RUNTIME_INTEGRATION_SPECS); every other Jest layer runs
// under the integration project, in band after its globalSetup.
const UNIT_PROJECT_LAYERS = new Set(['unit', 'planner-host']);
export const jestConfigFor = (layer) =>
    UNIT_PROJECT_LAYERS.has(layer) ? 'jest.config.ts' : 'jest.integration.config.ts';
// One Jest process runs at most this many suites. --runInBand keeps every
// suite's modules in one heap, and the whole unit layer in one process ran
// out of the 768 MB the child gets (NODE_OPTIONS below).
export const JEST_BATCH_SIZE = 40;
const TEST_FILE = /(?:\.spec\.tsx?|\.e2e-spec\.ts|\.test\.[cm]?[jt]s)$/;
export class ValidationError extends Error {
    constructor(code) {
        super(code);
        this.code = code;
    }
}

export function parseArgs(args, inventory) {
    const options = { run: false, layers: ['unit'], fixtures: [] };
    const seen = new Set();
    for (const argument of args) {
        const [flag, value, extra] = argument.split('=');
        if (seen.has(flag) || extra !== undefined)
            throw new ValidationError('invalid_arguments');
        seen.add(flag);
        if (flag === '--run' && value === undefined) options.run = true;
        else if (flag === '--plan' && value === undefined) options.run = false;
        else if ((flag === '--layers' || flag === '--allow-fixture') && value) {
            const values = value.split(',');
            if (
                values.some(
                    (entry) => !Object.hasOwn(inventory.layers, entry),
                ) ||
                new Set(values).size !== values.length
            )
                throw new ValidationError('invalid_arguments');
            options[flag === '--layers' ? 'layers' : 'fixtures'] = values;
        } else throw new ValidationError('invalid_arguments');
    }
    if (seen.has('--run') && seen.has('--plan'))
        throw new ValidationError('invalid_arguments');
    return options;
}

function safeRelative(path) {
    return (
        typeof path === 'string' &&
        path.length > 0 &&
        !isAbsolute(path) &&
        !path.includes('\\') &&
        path
            .split('/')
            .every((part) => part && part !== '.' && part !== '..') &&
        !path.startsWith('-')
    );
}

export function validateInventory(inventory) {
    if (
        inventory.version !== 1 ||
        !Array.isArray(inventory.roots) ||
        !inventory.layers ||
        typeof inventory.layers !== 'object'
    )
        throw new ValidationError('invalid_inventory');
    const seen = new Set();
    for (const root of inventory.roots)
        if (!safeRelative(root)) throw new ValidationError('invalid_inventory');
    for (const [layer, paths] of Object.entries(inventory.layers)) {
        if (!/^[a-z][a-z0-9-]*$/.test(layer) || !Array.isArray(paths))
            throw new ValidationError('invalid_inventory');
        for (const path of paths) {
            if (!safeRelative(path) || !TEST_FILE.test(path) || seen.has(path))
                throw new ValidationError('invalid_inventory');
            if (layer === 'unit' && path.includes('.integration.'))
                throw new ValidationError('unsafe_unit_inventory');
            seen.add(path);
        }
    }
}

export function selectPlan(inventory, options) {
    const selected = [],
        excluded = [];
    for (const [layer, paths] of Object.entries(inventory.layers)) {
        for (const path of paths) {
            if (options.layers.includes(layer))
                selected.push({ layer, path, status: 'not_run' });
            else excluded.push({ layer, path, reason: 'layer_not_selected' });
        }
    }
    return {
        version: 1,
        mode: options.run ? 'run' : 'plan',
        status: 'not_measured',
        selected,
        excluded,
    };
}

export async function inspectInventory(root, inventory) {
    const expected = new Set(Object.values(inventory.layers).flat());
    const discovered = new Set();
    async function visit(path) {
        const info = await lstat(join(root, path));
        if (info.isSymbolicLink())
            throw new ValidationError('symlink_in_inventory');
        if (info.isDirectory()) {
            for (const item of (await readdir(join(root, path))).sort()) {
                if (!['node_modules', '.git', 'dist', '.next'].includes(item))
                    await visit(`${path}/${item}`);
            }
        } else if (TEST_FILE.test(path)) discovered.add(path);
    }
    for (const path of inventory.roots) await visit(path);
    for (const path of expected) {
        if (!discovered.has(path)) {
            const info = await lstat(join(root, path)).catch(() => null);
            if (!info?.isFile() || info.isSymbolicLink())
                throw new ValidationError('inventory_file_missing');
            if ((await realpath(join(root, path))) !== resolve(root, path))
                throw new ValidationError('symlink_in_inventory');
        }
    }
    const unlisted = [...discovered].filter((path) => !expected.has(path));
    if (unlisted.length) {
        // Named in the manifest so the fix is to review and list exactly
        // these paths, not to regenerate the inventory blindly.
        const error = new ValidationError('inventory_drift');
        error.unlisted = unlisted.sort();
        throw error;
    }
}

export function assertRunnable(options) {
    for (const layer of options.layers) {
        if (!EXECUTABLE.has(layer))
            throw new ValidationError('fixture_adapter_unavailable');
        if (layer === 'sdk' && !options.fixtures.includes(layer))
            throw new ValidationError('fixture_opt_in_required');
    }
}

export function childEnvironment(parent, scratch) {
    return {
        ...(parent.PATH ? { PATH: parent.PATH } : {}),
        HOME: scratch,
        TMPDIR: scratch,
        TMP: scratch,
        TEMP: scratch,
        API_NODE_ENV: 'test',
        NODE_ENV: 'test',
        API_LOG_LEVEL: 'error',
        SKIP_INTEGRATION: 'true',
        DBOS__CLOUD: 'false',
        DOTENV_CONFIG_PATH: process.platform === 'win32' ? 'NUL' : '/dev/null',
        CI: 'true',
        TZ: 'UTC',
        LANG: 'C.UTF-8',
        NODE_OPTIONS: '--max-old-space-size=768',
    };
}

export async function createArtifacts(parent = tmpdir()) {
    const path = await mkdtemp(join(parent, 'kody-runtime-validation-'));
    await chmod(path, 0o700);
    return path;
}

export async function runCommand({
    executable,
    argv,
    cwd,
    env,
    logPath,
    timeoutMs = 180_000,
    maxLogBytes = 16_777_216,
}) {
    const stream = createWriteStream(logPath, { flags: 'wx', mode: 0o600 });
    await new Promise((done, reject) => {
        stream.once('open', done);
        stream.once('error', reject);
    });
    const started = performance.now();
    return new Promise((done) => {
        const grouped = process.platform !== 'win32';
        const child = spawn(executable, argv, {
            cwd,
            env,
            shell: false,
            detached: grouped,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let spawnFailed = false,
            timedOut = false,
            outputLimitReached = false,
            bytes = 0;
        const killOwned = () => {
            try {
                if (grouped && child.pid) process.kill(-child.pid, 'SIGKILL');
                else child.kill('SIGKILL');
            } catch {
                /* The owned process may already have exited. */
            }
        };
        const capture = (chunk) => {
            const remaining = Math.max(0, maxLogBytes - bytes);
            if (remaining) stream.write(chunk.subarray(0, remaining));
            bytes += chunk.length;
            if (bytes > maxLogBytes) {
                outputLimitReached = true;
                killOwned();
            }
        };
        child.stdout.on('data', capture);
        child.stderr.on('data', capture);
        const timer = setTimeout(() => {
            timedOut = true;
            killOwned();
        }, timeoutMs);
        process.once('SIGINT', killOwned);
        process.once('SIGTERM', killOwned);
        child.once('error', () => {
            spawnFailed = true;
        });
        child.once('close', (exitCode, signal) => {
            clearTimeout(timer);
            process.removeListener('SIGINT', killOwned);
            process.removeListener('SIGTERM', killOwned);
            stream.end(() =>
                done({
                    exitCode,
                    signal,
                    timedOut,
                    spawnFailed,
                    outputLimitReached,
                    durationMs: Math.round(performance.now() - started),
                }),
            );
        });
    });
}

export function summarizeJest(result, selected, root) {
    if (!result || !Array.isArray(result.testResults))
        throw new ValidationError('runner_result_invalid');
    const expected = new Set(selected);
    const results = new Map();
    for (const suite of result.testResults) {
        const path = relative(root, suite.name).split('\\').join('/');
        if (!expected.has(path) || results.has(path))
            throw new ValidationError('runner_result_invalid');
        const assertions = Array.isArray(suite.assertionResults)
            ? suite.assertionResults
            : [];
        const counts = { passed: 0, failed: 0, skipped: 0 };
        for (const assertion of assertions) {
            if (assertion.status === 'passed') counts.passed++;
            else if (assertion.status === 'failed') counts.failed++;
            else counts.skipped++;
        }
        if (suite.status === 'passed' && assertions.length === 0)
            throw new ValidationError('runner_result_empty');
        const status =
            suite.status === 'passed'
                ? counts.skipped
                    ? 'passed_with_skips'
                    : 'passed'
                : suite.status === 'pending'
                  ? 'skipped'
                  : 'failed';
        results.set(path, { path, status, counts });
    }
    if (results.size !== expected.size)
        throw new ValidationError('runner_result_incomplete');
    return [...results.values()];
}

export function summarizeNode(tap) {
    const count = (name) => {
        const value = [
            ...tap.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gm')),
        ].at(-1);
        return value ? Number(value[1]) : null;
    };
    const total = count('tests'),
        passed = count('pass'),
        failed = count('fail'),
        skipped = count('skipped'),
        cancelled = count('cancelled'),
        todo = count('todo');
    if (
        [total, passed, failed, skipped, cancelled, todo].some(
            (value) => value === null,
        )
    )
        throw new ValidationError('runner_result_invalid');
    if (total === 0) throw new ValidationError('runner_result_empty');
    if (passed + failed + skipped + cancelled + todo !== total)
        throw new ValidationError('runner_result_invalid');
    const counts = {
        passed,
        failed: failed + cancelled,
        skipped: skipped + todo,
    };
    return {
        status: counts.failed
            ? 'failed'
            : counts.skipped
              ? 'passed_with_skips'
              : 'passed',
        counts,
    };
}

export async function executePlan({
    root,
    plan,
    options,
    parentEnv = process.env,
    executable = process.execPath,
}) {
    assertRunnable(options);
    const needsJest = options.layers.some((layer) => !NODE_LAYERS.has(layer));
    const jest = join(root, 'node_modules/jest/bin/jest.js');
    if (needsJest && !(await lstat(jest).catch(() => null))?.isFile())
        throw new ValidationError('dependencies_unavailable');
    const scratch = await createArtifacts();
    const env = childEnvironment(parentEnv, scratch);
    plan.artifactRoot = scratch;
    plan.commands = [];
    outer: for (const layer of options.layers) {
        const paths = plan.selected
            .filter((entry) => entry.layer === layer)
            .map((entry) => entry.path);
        if (!paths.length) throw new ValidationError('empty_selection');
        // A Node process per file gives a real result for each file rather than
        // attributing a single aggregate failure to every selected test. Jest
        // gets bounded batches, each a fresh process with its own heap.
        const batches = NODE_LAYERS.has(layer)
            ? paths.map((path) => [path])
            : Array.from(
                  { length: Math.ceil(paths.length / JEST_BATCH_SIZE) },
                  (_, index) =>
                      paths.slice(
                          index * JEST_BATCH_SIZE,
                          (index + 1) * JEST_BATCH_SIZE,
                      ),
              );
        for (const [index, batch] of batches.entries()) {
            const name = `${layer}-${index}`;
            const resultPath = join(scratch, `${name}-result.json`);
            const argv = NODE_LAYERS.has(layer)
                ? [
                      '--test',
                      '--test-reporter=tap',
                      '--test-concurrency=1',
                      '--test-timeout=10000',
                      ...batch,
                  ]
                : [
                      jest,
                      '--config',
                      jestConfigFor(layer),
                      '--runInBand',
                      '--no-coverage',
                      '--no-cache',
                      '--runTestsByPath',
                      ...batch,
                      '--json',
                      `--outputFile=${resultPath}`,
                  ];
            const logPath = join(scratch, `${name}.log`);
            const command = await runCommand({
                executable,
                argv,
                cwd: root,
                env,
                logPath,
            });
            plan.commands.push({
                layer,
                runner: NODE_LAYERS.has(layer) ? 'node-test' : 'jest',
                paths: batch,
                ...command,
            });
            if (command.spawnFailed) {
                plan.status = 'not_measured';
                plan.reason = 'runner_start_failed';
                break outer;
            }
            try {
                const suites = NODE_LAYERS.has(layer)
                    ? [
                          {
                              path: batch[0],
                              ...summarizeNode(await readFile(logPath, 'utf8')),
                          },
                      ]
                    : summarizeJest(
                          JSON.parse(await readFile(resultPath, 'utf8')),
                          batch,
                          root,
                      );
                for (const entry of plan.selected.filter(
                    (entry) =>
                        entry.layer === layer && batch.includes(entry.path),
                ))
                    Object.assign(
                        entry,
                        suites.find((suite) => suite.path === entry.path),
                    );
            } catch (error) {
                plan.status =
                    command.exitCode === 0 ? 'not_measured' : 'failed';
                plan.reason =
                    error instanceof ValidationError
                        ? error.code
                        : 'runner_result_invalid';
                break outer;
            }
            if (
                command.exitCode !== 0 ||
                command.outputLimitReached ||
                plan.selected.some((entry) => entry.status === 'failed')
            ) {
                plan.status = 'failed';
                plan.reason = command.timedOut
                    ? 'runner_timed_out'
                    : command.outputLimitReached
                      ? 'runner_output_limit'
                      : 'runner_failed';
                break outer;
            }
        }
    }
    if (!plan.reason)
        plan.status = plan.selected.some((entry) =>
            ['skipped', 'passed_with_skips'].includes(entry.status),
        )
            ? 'passed_with_skips'
            : 'passed';
    await writeFile(
        join(scratch, 'manifest.json'),
        `${JSON.stringify(plan, null, 2)}\n`,
        { flag: 'wx', mode: 0o600 },
    );
    return {
        manifest: plan,
        exitCode:
            plan.status === 'failed'
                ? 1
                : plan.status === 'not_measured'
                  ? 2
                  : 0,
    };
}

export function inventoryHash(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
