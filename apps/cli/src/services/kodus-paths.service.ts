import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Resolve the shared kodus home directory (~/.kodus).
 * Sessions, pending events and UI assets live under here — never inside a repo.
 *
 * Override with KODUS_HOME for tests / hermetic runs.
 */
export function getKodusHome(home = os.homedir()): string {
    if (process.env.KODUS_HOME) {
        return path.resolve(process.env.KODUS_HOME);
    }
    return path.join(home, '.kodus');
}

/**
 * Hash a git common-dir (or worktree root) so worktrees of the same repo share
 * one session namespace keyed by the common git directory, while different repos
 * never collide. Worktree isolation for *writes* is achieved by including the
 * worktree root in the session path when requested.
 */
export function hashPath(input: string): string {
    return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

/**
 * Resolve the absolute git common directory for a repo root (handles worktrees).
 */
export async function resolveGitCommonDir(repoRoot: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['rev-parse', '--path-format=absolute', '--git-common-dir'],
            { cwd: repoRoot },
        );
        return stdout.trim();
    } catch {
        return path.resolve(repoRoot);
    }
}

/**
 * Sessions root for a repository. Keyed by the git common-dir hash so all
 * worktrees of the same repo share the same store base. Individual session
 * files still carry worktree metadata and branch so concurrent worktrees do
 * not clobber each other when writing.
 *
 * Path: ~/.kodus/sessions/<common-dir-hash>/
 */
export async function getSessionsDir(
    repoRoot: string,
    home = os.homedir(),
): Promise<string> {
    const commonDir = await resolveGitCommonDir(repoRoot);
    const key = hashPath(commonDir);
    return path.join(getKodusHome(home), 'sessions', key);
}

/**
 * Worktree-scoped pending-events path (outside the repo).
 * Path: ~/.kodus/pending/<worktree-hash>/pending-events.jsonl
 */
export async function getPendingEventsPath(
    repoRoot: string,
    home = os.homedir(),
): Promise<string> {
    const worktreeKey = hashPath(path.resolve(repoRoot));
    const dir = path.join(getKodusHome(home), 'pending', worktreeKey);
    await fs.mkdir(dir, { recursive: true });
    return path.join(dir, 'pending-events.jsonl');
}

/**
 * Distillation collision log (for `trace status`).
 */
export function getCollisionLogPath(home = os.homedir()): string {
    return path.join(getKodusHome(home), 'trace-collisions.jsonl');
}

/**
 * Ensure a directory exists.
 */
export async function ensureDir(dir: string): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
}
