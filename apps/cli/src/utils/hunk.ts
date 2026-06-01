import path from 'node:path';
import { createRequire } from 'node:module';
import { execa, type ExecaError, type Options as ExecaOptions } from 'execa';

const require = createRequire(import.meta.url);

interface HunkPackageJson {
    bin?: string | Record<string, string>;
}

let cachedHunkBin: string | null = null;

export function resolveHunkBin(): string {
    if (cachedHunkBin) {
        return cachedHunkBin;
    }

    const pkgPath = require.resolve('hunkdiff/package.json');
    const pkg = require('hunkdiff/package.json') as HunkPackageJson;

    let binRelative: string | undefined;
    if (typeof pkg.bin === 'string') {
        binRelative = pkg.bin;
    } else if (pkg.bin && typeof pkg.bin === 'object') {
        binRelative = pkg.bin.hunk ?? Object.values(pkg.bin)[0];
    }

    if (!binRelative) {
        throw new Error(
            'hunkdiff package.json is missing a bin entry — cannot locate the hunk binary.',
        );
    }

    cachedHunkBin = path.resolve(path.dirname(pkgPath), binRelative);
    return cachedHunkBin;
}

export interface RunHunkResult {
    exitCode: number;
}

/**
 * Spawn the bundled hunk binary with `process.execPath` so we don't depend on
 * the shebang resolving correctly across platforms. stdio defaults to inherit
 * so the TUI takes over the terminal.
 */
export async function runHunk(
    args: string[],
    options: { execa?: ExecaOptions } = {},
): Promise<RunHunkResult> {
    const bin = resolveHunkBin();
    const result = await execa(process.execPath, [bin, ...args], {
        stdio: 'inherit',
        reject: false,
        ...(options.execa ?? {}),
    });

    return { exitCode: result.exitCode ?? 0 };
}

export function isHunkExecError(error: unknown): error is ExecaError {
    return Boolean(
        error &&
        typeof error === 'object' &&
        'shortMessage' in (error as Record<string, unknown>),
    );
}
