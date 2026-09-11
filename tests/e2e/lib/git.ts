import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { logger } from './log.js';

const log = logger('git');

export async function run(
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv; capture?: boolean } = {},
): Promise<string> {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            stdio: opts.capture
                ? ['ignore', 'pipe', 'pipe']
                : ['ignore', 'inherit', 'inherit'],
        });
        let stdout = '';
        let stderr = '';
        if (opts.capture) {
            proc.stdout?.on('data', (chunk) => (stdout += chunk.toString()));
            proc.stderr?.on('data', (chunk) => (stderr += chunk.toString()));
        }
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) resolve(stdout.trim());
            else {
                const message = `${cmd} ${args.join(' ')} exited with code ${code}${stderr ? `\n${stderr}` : ''}`;
                reject(new Error(message));
            }
        });
    });
}

export interface OpenPROptions {
    cloneUrl: string;
    branch: string;
    files: Record<string, string>;
    deleteFiles?: string[];
    commitMessage: string;
    authorName?: string;
    authorEmail?: string;
    baseBranch?: string;
}

export interface PreparedBranch {
    workDir: string;
    branch: string;
    baseBranch: string;
    cleanup: () => void;
}

export async function prepareBranch(
    opts: OpenPROptions,
): Promise<PreparedBranch> {
    const workDir = mkdtempSync(join(tmpdir(), 'kodus-e2e-'));
    log.info(`Cloning into ${workDir}`);

    await run('git', ['clone', '--depth=1', opts.cloneUrl, workDir], {
        capture: true,
    });

    let baseBranch = opts.baseBranch ?? '';
    if (!baseBranch) {
        baseBranch = await run('git', ['symbolic-ref', '--short', 'HEAD'], {
            cwd: workDir,
            capture: true,
        });
    } else {
        // Branch from the DECLARED base, not from the clone's default
        // HEAD. Fixture repos deliberately set a non-main default branch
        // (tiny-url's default is a review-bait bug branch); branching
        // from HEAD while opening the PR against `main` drags the whole
        // default-vs-main delta into the PR — and if such a PR is ever
        // MERGED (rule-sync scenarios), main is polluted and every later
        // PR conflicts (mergeable_state=dirty).
        await run('git', ['fetch', '--depth=1', 'origin', baseBranch], {
            cwd: workDir,
            capture: true,
        });
        // -B: works whether or not the clone's default HEAD already is
        // the base branch.
        await run('git', ['checkout', '-B', baseBranch, 'FETCH_HEAD'], {
            cwd: workDir,
            capture: true,
        });
    }

    await run('git', ['checkout', '-b', opts.branch], {
        cwd: workDir,
        capture: true,
    });

    for (const [path, contents] of Object.entries(opts.files)) {
        const absPath = join(workDir, path);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, contents);
    }

    for (const path of opts.deleteFiles ?? []) {
        rmSync(join(workDir, path), { force: true });
    }

    await run('git', ['add', '.'], { cwd: workDir, capture: true });

    const authorName = opts.authorName ?? 'Kodus E2E';
    const authorEmail = opts.authorEmail ?? 'e2e@kodus.test';
    await run(
        'git',
        [
            '-c',
            `user.name=${authorName}`,
            '-c',
            `user.email=${authorEmail}`,
            'commit',
            '-m',
            opts.commitMessage,
        ],
        { cwd: workDir, capture: true },
    );

    log.info(`Pushing branch ${opts.branch}`);
    await run('git', ['push', '-u', 'origin', opts.branch], {
        cwd: workDir,
        capture: true,
    });

    return {
        workDir,
        branch: opts.branch,
        baseBranch,
        cleanup: () => {
            try {
                rmSync(workDir, { recursive: true, force: true });
            } catch {
                /* best effort */
            }
        },
    };
}

export interface FollowupCommitOptions {
    cloneUrl: string;
    /** Branch that ALREADY exists remotely — checked out via FETCH_HEAD,
     *  never created with `checkout -b` (that's prepareBranch's job). */
    branch: string;
    files: Record<string, string>;
    commitMessage: string;
    authorName?: string;
    authorEmail?: string;
}

/**
 * Pushes a second (or Nth) commit onto a branch a PR is already open on.
 * Scenarios that need a real 2nd review round (e.g. "the developer applies
 * the suggestion for real") use this instead of prepareBranch, which only
 * knows how to create a brand-new branch.
 */
export async function pushFollowupCommit(
    opts: FollowupCommitOptions,
): Promise<void> {
    const workDir = mkdtempSync(join(tmpdir(), 'kodus-e2e-followup-'));
    log.info(`Cloning into ${workDir} for a follow-up commit on ${opts.branch}`);

    try {
        await run('git', ['clone', '--depth=1', opts.cloneUrl, workDir], {
            capture: true,
        });

        await run('git', ['fetch', '--depth=1', 'origin', opts.branch], {
            cwd: workDir,
            capture: true,
        });
        await run('git', ['checkout', '-B', opts.branch, 'FETCH_HEAD'], {
            cwd: workDir,
            capture: true,
        });

        for (const [path, contents] of Object.entries(opts.files)) {
            const absPath = join(workDir, path);
            mkdirSync(dirname(absPath), { recursive: true });
            writeFileSync(absPath, contents);
        }

        await run('git', ['add', '.'], { cwd: workDir, capture: true });

        const authorName = opts.authorName ?? 'Kodus E2E';
        const authorEmail = opts.authorEmail ?? 'e2e@kodus.test';
        await run(
            'git',
            [
                '-c',
                `user.name=${authorName}`,
                '-c',
                `user.email=${authorEmail}`,
                'commit',
                '-m',
                opts.commitMessage,
            ],
            { cwd: workDir, capture: true },
        );

        log.info(`Pushing follow-up commit on ${opts.branch}`);
        await run('git', ['push', 'origin', opts.branch], {
            cwd: workDir,
            capture: true,
        });
    } finally {
        try {
            rmSync(workDir, { recursive: true, force: true });
        } catch {
            /* best effort */
        }
    }
}
