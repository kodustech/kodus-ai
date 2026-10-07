/**
 * Regenerate the env artefacts into `outDir` by running the generator that
 * sits beside this module.
 *
 * The child is spawned as an argv PAIR, never through a shell. The interpolated
 * form this replaces (`execSync(\`ts-node ${path}\`)`) let the shell re-split the
 * script path on any whitespace in it, so a checkout under
 * `.../Documents/2. Areas/...` handed ts-node `.../Documents/2.` and the run
 * died with `Cannot find module './2.'` — which the pre-push hook turns into
 * "you cannot push from this checkout" (#2045). An argv entry is passed to the
 * child as one value, whatever it contains.
 *
 * Windows note: `execFileSync` cannot launch the `ts-node.cmd` shim without a
 * shell, so on Windows this needs `process.execPath` plus the resolved ts-node
 * bin entry instead. Left as the argv form because that is the fix for the
 * reported failure and this is a dev-only guard; a Windows contributor hitting
 * ENOENT here is the signal to make that swap.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');

export function regenerateEnvArtefacts(outDir: string): void {
    execFileSync('ts-node', [join(__dirname, 'generate.ts')], {
        cwd: REPO_ROOT,
        env: { ...process.env, KODUS_ENV_OUT_DIR: outDir },
        stdio: 'inherit',
    });
}
