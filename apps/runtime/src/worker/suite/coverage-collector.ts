import type { EnvError, EnvironmentRuntime, StepResult } from '@libs/runtime/environment';

// The coverage of one spec on the baseline (docs/runtime/e2e-suites.md section 6.1, D10). Only the baseline collects: the
// engine runs each spec as a command of its own with `NODE_V8_COVERAGE` pointing at a directory of that spec, so every
// Node process the command starts (the runner, a server it launches) dumps its V8 coverage there when it exits, and what
// the dumps hold is that spec's files. A PR run never sets the variable and pays nothing.

/** Where the per-spec dumps go, on the claim's host. */
export const COVERAGE_ROOT = '/tmp/kodus-suite-cov';
const READ_TIMEOUT_MS = 60_000;

/** The directory one spec's dumps go to: derived from the command key, which the engine builds from the run and the shard. */
export const coverageDirOf = (key: string): string => `${COVERAGE_ROOT}/${key}`;

/**
 * Reads the dumps of one directory and prints `{"files":[...]}`: the repository-relative files (the working directory is the
 * checkout's root) with a function that ran, from V8 dumps (`result[].url` of `file://` scripts) and from Istanbul objects
 * (`s` counters, the browser side's format); `node_modules` and anything outside the checkout are left out. Then removes
 * the directory, so the next spec starts clean. Plain CommonJS, no dependency: it runs on the claim's own Node.
 */
export const COVERAGE_COLLECT_SCRIPT = [
    'const fs = require("fs"), path = require("path"), url = require("url");',
    'const dir = process.argv[1], root = process.cwd(), out = new Set();',
    'const add = (p) => { const r = path.relative(root, p); if (r && !r.startsWith("..") && !path.isAbsolute(r) && !r.split(path.sep).includes("node_modules")) out.add(r.split(path.sep).join("/")); };',
    'const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".json") ? [path.join(d, e.name)] : []));',
    'let seen = 0;',
    'for (const f of walk(dir)) {',
    '  let j; try { j = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }',
    '  seen++;',
    '  if (Array.isArray(j.result)) { for (const s of j.result) if (typeof s.url === "string" && s.url.startsWith("file://") && (s.functions || []).some((fn) => (fn.ranges || []).some((r) => r.count > 0))) add(url.fileURLToPath(s.url)); }',
    '  else { for (const [k, v] of Object.entries(j)) if (v && v.s && Object.values(v.s).some((n) => n > 0)) add(path.resolve(root, v.path || k)); }',
    '}',
    'if (seen === 0) { console.error("no coverage dump"); process.exit(3); }',
    'fs.rmSync(dir, { recursive: true, force: true });',
    'console.log(JSON.stringify({ files: [...out].sort() }));',
].join('\n');

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const answered = (r: StepResult | EnvError): r is StepResult => 'transport' in r && r.transport === 'ok';

/** The files one spec exercised, or undefined when the dumps could not be read: the map is then incomplete, never guessed. */
export async function collectCoverage(env: Pick<EnvironmentRuntime, 'exec'>, claimId: string, key: string, dir: string): Promise<string[] | undefined> {
    const r = await env.exec(claimId, { stepId: `${key}:cov`, command: `node -e ${quote(COVERAGE_COLLECT_SCRIPT)} ${quote(dir)}`, timeoutMs: READ_TIMEOUT_MS });
    if (!answered(r) || r.exitCode !== 0 || r.truncated) return undefined;
    try {
        const files = (JSON.parse(r.stdout) as { files?: unknown }).files;
        return Array.isArray(files) && files.every((f) => typeof f === 'string') ? (files as string[]) : undefined;
    } catch {
        return undefined;
    }
}

/** What the engine stores of a baseline's coverage: per spec the repository files it exercised. */
export interface CoverageMapRecord {
    organizationId: string;
    environmentId: string;
    mainSha: string;
    suiteDigest: string;
    /** Complete only when every spec of the suite reported and its dumps were read. */
    status: 'complete' | 'incomplete';
    specs: Record<string, string[]>;
    finishedAt: Date;
}
