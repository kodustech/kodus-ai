import { execFile } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { EnvError, ExecRequest, StepResult } from '@libs/runtime/environment';

import { collectCoverage } from './coverage-collector';
import { runDetached } from './detached-exec';

// The collector is a Node script the claim runs: here it reads the real V8 dumps of real Node processes started the way the
// engine starts a baseline spec (NODE_V8_COVERAGE on a directory of its own), in a fixture app of three specs.

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function shellEnv(root: string) {
    return {
        async exec(_claimId: string, req: ExecRequest): Promise<StepResult | EnvError> {
            return new Promise((resolve) => {
                const start = Date.now();
                execFile('sh', ['-c', req.command], { cwd: req.cwd ? join(root, req.cwd) : root, timeout: req.timeoutMs }, (err, stdout, stderr) => {
                    resolve({ stepId: req.stepId, exitCode: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr, truncated: false, durationMs: Date.now() - start, transport: 'ok' });
                });
            });
        },
    };
}

describe('coverage collection in a real shell with real Node processes', () => {
    let root: string;
    let state: string;
    beforeEach(() => {
        root = realpathSync(mkdtempSync(join(tmpdir(), 'kodus-cov-app-')));
        state = mkdtempSync(join(tmpdir(), 'kodus-cov-state-'));
        for (const d of ['src', 'server', 'node_modules/dep', 'results']) mkdirSync(join(root, d), { recursive: true });
        writeFileSync(join(root, 'src/cart.js'), 'module.exports = () => 1;\n');
        writeFileSync(join(root, 'src/profile.js'), 'module.exports = () => 2;\n');
        writeFileSync(join(root, 'src/shared.js'), 'module.exports = () => 3;\n');
        writeFileSync(join(root, 'server/orders.js'), 'module.exports = () => 4;\n');
        writeFileSync(join(root, 'node_modules/dep/index.js'), 'module.exports = () => 5;\n');
        // The "specs" a runner would run: UI ones load the app bundle's files, the API one calls a handler the way a server would.
        writeFileSync(join(root, 'cart.spec.js'), "require('./src/cart.js')(); require('./src/shared.js')(); require('dep')();\n");
        writeFileSync(join(root, 'profile.spec.js'), "require('./src/profile.js')(); require('./src/shared.js')();\n");
        writeFileSync(join(root, 'orders-api.spec.js'), "require('./server/orders.js')();\n");
    });
    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
        rmSync(state, { recursive: true, force: true });
    });

    const runSpec = async (spec: string, key: string, dir: string) => {
        const env = shellEnv(root);
        const r = await runDetached({ env, claimId: 'c', key, command: `node ${spec}; mkdir -p results; echo "<x/>" > results/${key}.xml`, resultsGlob: 'results/*.xml', envVars: { NODE_V8_COVERAGE: dir }, timeoutMs: 30_000, pollMs: 100, now: Date.now, sleep, stateDir: join(state, 'run') });
        expect(r.outcome).toBe('finished');
        return collectCoverage(env, 'c', key, dir);
    };

    it('gives each spec its own files: the UI specs differ, the API-only spec has its server file, node_modules is left out', async () => {
        const cart = await runSpec('cart.spec.js', 'c0', join(state, 'cov-0'));
        const profile = await runSpec('profile.spec.js', 'c1', join(state, 'cov-1'));
        const api = await runSpec('orders-api.spec.js', 'c2', join(state, 'cov-2'));
        expect(cart).toEqual(expect.arrayContaining(['src/cart.js', 'src/shared.js']));
        expect(cart).not.toContain('src/profile.js');
        expect(profile).toEqual(expect.arrayContaining(['src/profile.js', 'src/shared.js']));
        expect(profile).not.toContain('src/cart.js');
        expect(api).toContain('server/orders.js');
        expect(api).not.toContain('src/shared.js');
        for (const files of [cart, profile, api]) expect(files?.some((f) => f.includes('node_modules'))).toBe(false);
    });

    it('reads the Istanbul object a browser run writes, and a directory with no dump is not an answer', async () => {
        const dir = join(state, 'cov-b');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'coverage-final.json'), JSON.stringify({ [join(root, 'src/cart.js')]: { path: join(root, 'src/cart.js'), s: { 0: 4, 1: 0 } }, [join(root, 'src/profile.js')]: { path: join(root, 'src/profile.js'), s: { 0: 0 } } }));
        expect(await collectCoverage(shellEnv(root), 'c', 'k1', dir)).toEqual(['src/cart.js']);
        expect(await collectCoverage(shellEnv(root), 'c', 'k2', join(state, 'nothing-here'))).toBeUndefined();
    });

    it('removes the directory it read, so the next spec starts clean', async () => {
        const dir = join(state, 'cov-0');
        await runSpec('cart.spec.js', 'c0', dir);
        expect(await collectCoverage(shellEnv(root), 'c', 'again', dir)).toBeUndefined();
    });
});
