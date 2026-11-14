import { repositoryGrepArgs } from '@libs/common/utils/repository-grep';
import { execFile, execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';

import { matchesGlob } from '../collect-surface';
import { GrepFn } from '../surface.types';

/**
 * Simulates the sandbox `grep` over an in-memory repo: the glob filters by
 * path, the pattern runs as a JS RegExp per line, output is `path:line:text`.
 */
export function createFakeGrep(
    files: Record<string, string>,
): GrepFn & { calls: { pattern: string; path: string; glob?: string }[] } {
    const calls: { pattern: string; path: string; glob?: string }[] = [];
    const fn = async (pattern: string, path: string, glob?: string) => {
        calls.push({ pattern, path, glob });
        let re: RegExp;
        try {
            re = new RegExp(pattern);
        } catch (err) {
            return `Error: ${(err as Error).message}`;
        }
        const prefix =
            path === '.' || path === '' ? '' : `${path.replace(/\/$/, '')}/`;
        const out: string[] = [];
        for (const [file, content] of Object.entries(files)) {
            if (prefix && !file.startsWith(prefix)) continue;
            if (glob && !matchesGlob(file, glob)) continue;
            content.split('\n').forEach((text, i) => {
                if (re.test(text)) out.push(`${file}:${i + 1}:${text}`);
            });
        }
        return out.length ? out.join('\n') : 'No matches found.';
    };
    return Object.assign(fn, { calls });
}

export function hasRipgrep(): boolean {
    try {
        execFileSync('rg', ['--version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Writes the files to a temp dir and greps them with the real `rg`, like the sandbox does. */
export function createRipgrep(files: Record<string, string>): {
    grep: GrepFn;
    cleanup: () => void;
} {
    const dir = mkdtempSync(join(tmpdir(), 'surface-rg-'));
    for (const [file, content] of Object.entries(files)) {
        const abs = join(dir, file);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
    }
    const env = { ...process.env };
    delete env.RIPGREP_CONFIG_PATH;
    const grep: GrepFn = (pattern, path, glob, options) =>
        new Promise((resolve) => {
            const args = [
                '--no-heading',
                '-n',
                '--no-follow',
                ...repositoryGrepArgs(options),
            ];
            if (glob) args.push('--glob', glob);
            args.push('-e', pattern, '--', path);
            execFile(
                'rg',
                args,
                { cwd: dir, env, maxBuffer: 64 * 1024 * 1024 },
                (err, stdout, stderr) => {
                    const code = (err as { code?: number } | null)?.code ?? 0;
                    if (code >= 2 || (err && typeof code !== 'number')) {
                        resolve(`Error: ${stderr || String(err)}`);
                    } else if (!stdout) {
                        resolve('No matches found.');
                    } else {
                        resolve(stdout);
                    }
                },
            );
        });
    return {
        grep,
        cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
}
