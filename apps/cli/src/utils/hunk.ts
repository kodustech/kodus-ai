import path from 'node:path';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
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

let cachedExtensionDir: string | null | undefined;

/**
 * Absolute path to the Kodus hunk extension bundled with this package, or null
 * when it isn't on disk.
 *
 * It ships as raw `.tsx` outside `src/` (hunk compiles it itself; our `tsc`
 * must not), so it sits at `<package root>/hunk-extension/kodus` both in the
 * repo and in the published tarball. This module lands at `dist/utils/hunk.js`
 * once compiled and `src/utils/hunk.ts` under vitest — same depth either way.
 */
export function resolveKodusExtensionDir(): string | null {
    if (cachedExtensionDir !== undefined) {
        return cachedExtensionDir;
    }

    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    const candidate = path.resolve(
        moduleDir,
        '..',
        '..',
        'hunk-extension',
        'kodus',
    );

    cachedExtensionDir = existsSync(path.join(candidate, 'index.tsx'))
        ? candidate
        : null;
    return cachedExtensionDir;
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
