import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

// The hub and the runtime-worker run under ts-node (apps/runtime/tsconfig.json,
// tsconfig-paths). Node resolves an extension-less import in the order .js,
// .json, .node and only then .ts, so `import { TAXONOMY } from './taxonomy'`
// next to a taxonomy.json loads the JSON: every export is undefined, the hub
// died at boot on its first metric, and the logger's field mapping threw
// inside its own catch, dropping every field. Jest resolves .ts first, so a
// unit test never sees it. These tests check the trees and load the
// telemetry the way the processes do.

const ROOT = join(__dirname, '../../../..');
const TREES = ['apps/runtime/src', 'libs/runtime', 'libs/runtime-publish'];

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        if (name === 'node_modules') return [];
        return statSync(path).isDirectory() ? files(path) : [path];
    });
}

describe('module resolution under the processes loader', () => {
    it('no TypeScript module shares its path with a JSON file, which Node would load instead', () => {
        const all = new Set(TREES.flatMap((t) => files(join(ROOT, t))));
        const shadowed = [...all]
            .filter((f) => f.endsWith('.json') && (all.has(f.replace(/\.json$/, '.ts')) || all.has(f.replace(/\.json$/, '.tsx'))))
            .map((f) => relative(ROOT, f));
        expect(shadowed).toEqual([]);
    });

    // apps/runtime/AGENTS.md "Layering": runtime-fleet holds the provider credentials and talks to the hub only
    // over its internal fleet routes, so it imports shared/ and libs/, never the hub or the worker (and they never it).
    it('src/fleet imports only shared/ and libs/, and neither the hub nor the worker imports src/fleet', () => {
        const app = join(ROOT, 'apps/runtime/src');
        const importsOf = (f: string) => [...readFileSync(f, 'utf8').matchAll(/(?:from\s*|import\s*\(\s*|require\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
        const resolved = (f: string, spec: string) => (spec.startsWith('.') ? relative(app, join(dirname(f), spec)) : spec.startsWith('@apps/runtime/') ? spec.slice('@apps/runtime/'.length) : spec);
        const ts = (dir: string) => files(join(app, dir)).filter((f) => f.endsWith('.ts'));
        const fleetOut = ts('fleet').flatMap((f) => importsOf(f).map((s) => ({ f: relative(ROOT, f), to: resolved(f, s) }))).filter((x) => /^(hub|worker)(\/|$)/.test(x.to));
        const intoFleet = [...ts('hub'), ...ts('worker'), ...ts('shared')]
            .flatMap((f) => importsOf(f).map((s) => ({ f: relative(ROOT, f), to: resolved(f, s) })))
            .filter((x) => /^fleet(\/|$)/.test(x.to));
        expect(fleetOut).toEqual([]);
        expect(intoFleet).toEqual([]);
        expect(ts('fleet').length).toBeGreaterThan(3);
    });

    it('ts-node with the runtime tsconfig builds the Runtime metrics and maps a log field to its taxonomy key', () => {
        const script = [
            "const { RuntimeMetrics } = require('./libs/runtime/telemetry/runtime-telemetry.ts');",
            "const { diagnosticFields } = require('./apps/runtime/src/shared/observability/diagnostic-fields.ts');",
            'new RuntimeMetrics();',
            "process.stdout.write(JSON.stringify(diagnosticFields({ claimId: 'c-1' })));",
        ].join('');
        const out = execFileSync(process.execPath, ['-r', 'ts-node/register/transpile-only', '-r', 'tsconfig-paths/register', '-e', script], {
            cwd: ROOT,
            env: { ...process.env, TS_NODE_PROJECT: 'apps/runtime/tsconfig.json', TS_NODE_TRANSPILE_ONLY: 'true' },
            encoding: 'utf8',
            timeout: 60_000,
        });
        expect(JSON.parse(out)).toEqual({ 'kodus.runtime.claim.id': 'c-1' });
    });
});
