import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { logger } from "./log.js";

const log = logger("git");

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
                ? ["ignore", "pipe", "pipe"]
                : ["ignore", "inherit", "inherit"],
        });
        let stdout = "";
        let stderr = "";
        if (opts.capture) {
            proc.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
            proc.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
        }
        proc.on("error", reject);
        proc.on("close", (code) => {
            if (code === 0) resolve(stdout.trim());
            else {
                const message = `${cmd} ${args.join(" ")} exited with code ${code}${stderr ? `\n${stderr}` : ""}`;
                reject(new Error(message));
            }
        });
    });
}

export interface OpenPROptions {
    cloneUrl: string;
    branch: string;
    files: Record<string, string>;
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

export async function prepareBranch(opts: OpenPROptions): Promise<PreparedBranch> {
    const workDir = mkdtempSync(join(tmpdir(), "kodus-e2e-"));
    log.info(`Cloning into ${workDir}`);

    await run("git", [
        "clone",
        "--depth=1",
        opts.cloneUrl,
        workDir,
    ], { capture: true });

    let baseBranch = opts.baseBranch ?? "";
    if (!baseBranch) {
        baseBranch = await run("git", ["symbolic-ref", "--short", "HEAD"], {
            cwd: workDir,
            capture: true,
        });
    }

    await run("git", ["checkout", "-b", opts.branch], {
        cwd: workDir,
        capture: true,
    });

    for (const [path, contents] of Object.entries(opts.files)) {
        const absPath = join(workDir, path);
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, contents);
    }

    await run("git", ["add", "."], { cwd: workDir, capture: true });

    const authorName = opts.authorName ?? "Kodus E2E";
    const authorEmail = opts.authorEmail ?? "e2e@kodus.test";
    await run(
        "git",
        [
            "-c",
            `user.name=${authorName}`,
            "-c",
            `user.email=${authorEmail}`,
            "commit",
            "-m",
            opts.commitMessage,
        ],
        { cwd: workDir, capture: true },
    );

    log.info(`Pushing branch ${opts.branch}`);
    await run("git", ["push", "-u", "origin", opts.branch], {
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
