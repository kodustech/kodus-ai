import { execFileSync } from 'child_process';
import { join, resolve } from 'path';

/**
 * The suites that run the real Go cell (go-cell layer) are opt-in by this
 * variable, never by finding go, docker or openssl on the machine: a default
 * jest run on a laptop that has them must not compile the cell and boot
 * containers next to the unit suites (review T3). Opted in, a missing tool
 * fails the suite instead of skipping it.
 */
export const GO_CELL_OPT_IN = 'RUNTIME_IT_GO_CELL';

/** Where the integration project's globalSetup left the cell it built once. */
export const GO_CELL_BINARY = 'RUNTIME_IT_CELL_BINARY';

const ROOT = resolve(__dirname, '../../../..');

export function goCellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return env[GO_CELL_OPT_IN] === '1' && env.SKIP_INTEGRATION !== 'true';
}

/** go build ./cmd/cell into `dir`; returns the binary's path. */
export function buildGoCell(dir: string): string {
    const out = join(dir, 'cell');
    execFileSync('go', ['build', '-o', out, './cmd/cell'], { cwd: join(ROOT, 'apps/runtime-cell'), stdio: 'inherit' });
    return out;
}

/** The cell the globalSetup built, or one built now into `dir` (a suite run outside the integration project). */
export function goCellBinary(dir: string): string {
    return process.env[GO_CELL_BINARY] || buildGoCell(dir);
}
