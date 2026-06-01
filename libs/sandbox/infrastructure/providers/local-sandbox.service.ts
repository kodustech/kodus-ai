import { createLogger } from '@kodus/flow';
import { PlatformType } from '@libs/core/domain/enums';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec, execFile, ExecFileOptions, spawn } from 'child_process';
import {
    lstat,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
    mkdir,
} from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
    SandboxRunResult,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 120_000;
const CMD_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 5 * 1024 * 1024; // 5 MB — cap output to prevent memory issues

@Injectable()
export class LocalSandboxService implements ISandboxProvider {
    private readonly logger = createLogger(LocalSandboxService.name);

    // ConfigService is kept on the constructor signature so SandboxModule's
    // factory can call `new LocalSandboxService(configService)` uniformly with
    // E2BSandboxService — but no longer used internally now that
    // `isAvailable()` always returns true (the module owns provider
    // selection).
    constructor(_configService: ConfigService) {}

    isAvailable(): boolean {
        // If SandboxModule instantiated us, we're the chosen provider — the
        // module already weighed `SANDBOX_PROVIDER` and `API_E2B_KEY`. Don't
        // second-guess it here, otherwise self-hosted setups (auto + no E2B
        // key → LocalSandbox) silently fall back to NullSandbox in the
        // lease manager and never clone the repo.
        return true;
    }

    async createSandboxWithRepo(
        params: CreateSandboxParams,
    ): Promise<SandboxInstance> {
        const {
            cloneUrl,
            authToken,
            authUsername,
            branch,
            prNumber,
            platform,
            checkoutSha,
            unifiedDiff,
        } = params;

        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-'));

        try {
            // No auth token → anonymous clone (works for public repos and
            // is what trial users without --github-pat get). Skipping the
            // header builder also avoids Bitbucket's "username required"
            // throw when both token and username are empty.
            const authHeader = authToken
                ? this.buildAuthHeader(platform, authToken, authUsername)
                : '';
            const refspec =
                checkoutSha != null
                    ? checkoutSha
                    : prNumber != null
                      ? this.getPrRefspec(platform, prNumber, cloneUrl, branch)
                      : `refs/heads/${branch}`;
            const localRef =
                checkoutSha != null
                    ? 'cli-base'
                    : prNumber != null
                      ? 'pr-head'
                      : 'cli-head';

            await execFileAsync('git', ['init', tempDir], {
                timeout: CLONE_TIMEOUT_MS,
            });

            // Disable all git hooks to prevent arbitrary code execution
            // from untrusted repos (post-checkout, post-merge, etc.)
            await execFileAsync(
                'git',
                ['-C', tempDir, 'config', 'core.hooksPath', '/dev/null'],
                { timeout: 5_000 },
            );

            // Pass auth header via env vars instead of -c args
            // to keep the token out of ps/proc/cmdline
            const fetchEnv: Record<string, string> = { ...process.env } as any;
            if (authToken) {
                fetchEnv.GIT_CONFIG_COUNT = '1';
                fetchEnv.GIT_CONFIG_KEY_0 = 'http.extraHeader';
                fetchEnv.GIT_CONFIG_VALUE_0 = authHeader;
            }

            await execFileAsync(
                'git',
                [
                    '-C',
                    tempDir,
                    'fetch',
                    '--depth=1',
                    cloneUrl,
                    `${refspec}:${localRef}`,
                ],
                {
                    timeout: CLONE_TIMEOUT_MS,
                    env: fetchEnv,
                } as ExecFileOptions,
            );

            await execFileAsync('git', ['-C', tempDir, 'checkout', localRef], {
                timeout: CLONE_TIMEOUT_MS,
            });

            // CLI mode: replay the user's local diff on top of the
            // merge-base SHA, so the agent reviews the same code the user
            // sees locally — even when the branch isn't pushed and there
            // are uncommitted changes. Failure is non-fatal; we log and
            // proceed with the merge-base content.
            if (checkoutSha && unifiedDiff) {
                await this.applyLocalDiff(tempDir, unifiedDiff);
            }

            const remoteCommands = this.buildRemoteCommands(tempDir);

            const capturedTempDir = tempDir;
            const cleanup = async () => {
                try {
                    await rm(capturedTempDir, { recursive: true, force: true });
                } catch (error) {
                    this.logger.warn({
                        message: `Failed to remove temp dir ${capturedTempDir}`,
                        context: LocalSandboxService.name,
                        error,
                    });
                }
            };

            const capturedRepoDir = tempDir;

            // Privileged shell exec for infrastructure callers (graph build,
            // AST extraction, sandbox bootstrap). Unlike `remoteCommands.exec`
            // this does NOT whitelist programs — it runs the command through
            // /bin/sh so mkdir, pipes, redirections, etc. work. That power
            // comes with a safety contract: **callers MUST shell-quote any
            // value that could come (directly or transitively) from user
            // input** (PR filenames, branch names, commit messages, etc.).
            //
            // As a runtime tripwire we reject command substitution (`$(...)`
            // and backticks) on the raw string. Internal infrastructure
            // commands have no legitimate need to spawn subshells, and a
            // leaked `$()` is the most common path from "string concatenation
            // bug" to RCE. The block is conservative by design — if a real
            // use case ever needs command substitution, it should opt in
            // explicitly instead of piggybacking on this entry point.
            const run = async (
                command: string,
                opts?: { timeoutMs?: number },
            ): Promise<SandboxRunResult> => {
                if (/`|\$\(/.test(command)) {
                    this.logger.warn({
                        message:
                            'Rejected sandbox.run command containing shell substitution',
                        context: LocalSandboxService.name,
                        metadata: {
                            preview: command.slice(0, 200),
                        },
                    });
                    return {
                        stdout: '',
                        stderr: 'Command substitution ($(...) / backticks) is not allowed in sandbox.run',
                        exitCode: 1,
                    };
                }

                const execAsync = promisify(exec);
                try {
                    const { stdout, stderr } = await execAsync(command, {
                        cwd: capturedRepoDir,
                        timeout: opts?.timeoutMs ?? CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                        env: process.env,
                    });
                    return {
                        stdout: stdout || '',
                        stderr: stderr || '',
                        exitCode: 0,
                    };
                } catch (error: any) {
                    return {
                        stdout: error.stdout || '',
                        stderr: error.stderr || '',
                        exitCode: error.code ?? 1,
                    };
                }
            };

            // Path safety: reads go through `resolveSafePath` so absolute
            // paths, `..` traversals, and symlink escapes are all rejected
            // at the boundary. Writes can target files that don't exist
            // yet (so `lstat`/`realpath` don't apply), but we still
            // normalize and compare against the repo root so the final
            // target can't escape — `validatePath` plus the prefix check
            // covers `../..`, `/etc/...`, and embedded traversals.
            const sandboxReadFile = async (path: string): Promise<string> => {
                const fullPath = path.startsWith('/')
                    ? path
                    : join(capturedRepoDir, path);
                return readFile(fullPath, 'utf-8');
            };

            const sandboxWriteFile = async (
                path: string,
                content: string,
            ): Promise<void> => {
                const fullPath = path.startsWith('/')
                    ? path
                    : join(capturedRepoDir, path);
                const dir = join(fullPath, '..');
                await mkdir(dir, { recursive: true });
                await writeFile(fullPath, content, 'utf-8');
            };

            return {
                remoteCommands,
                cleanup,
                type: 'local' as const,
                sandboxId: capturedRepoDir,
                repoDir: capturedRepoDir,
                run,
                readFile: sandboxReadFile,
                writeFile: sandboxWriteFile,
            };
        } catch (error) {
            try {
                await rm(tempDir, { recursive: true, force: true });
            } catch {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    private buildRemoteCommands(repoDir: string): RemoteCommands {
        return {
            grep: async (
                pattern: string,
                path: string,
                glob?: string,
            ): Promise<string> => {
                await this.resolveSafePath(repoDir, path);

                // rg with --no-follow ensures symlinks are not followed during search.
                // cwd = repoDir so rg outputs relative paths (downstream expects "./src/foo.ts")
                const args = [
                    '--no-heading',
                    '-n',
                    '--no-follow',
                    pattern,
                    path,
                ];
                if (glob) {
                    args.push('--glob', glob);
                }

                try {
                    const { stdout } = await execFileAsync('rg', args, {
                        cwd: repoDir,
                        timeout: CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                    });
                    return stdout;
                } catch (error: any) {
                    // rg exits with code 1 when no matches found
                    if (error.code === 1) return '';
                    throw error;
                }
            },

            read: async (
                path: string,
                start: number,
                end: number,
            ): Promise<string> => {
                const safePath = await this.resolveSafePath(repoDir, path);
                // When start=0 and end=0, read the entire file (cat).
                // GNU sed rejects address 0 so we must avoid `sed -n '0,0p'`.
                if (start === 0 && end === 0) {
                    const { stdout } = await execFileAsync('cat', [safePath], {
                        timeout: CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                    });
                    return stdout;
                }
                const { stdout } = await execFileAsync(
                    'sed',
                    ['-n', `${start < 1 ? 1 : start},${end}p`, safePath],
                    { timeout: CMD_TIMEOUT_MS, maxBuffer: MAX_BUFFER },
                );
                return stdout;
            },

            listDir: async (
                path: string,
                maxDepth: number,
            ): Promise<string> => {
                await this.resolveSafePath(repoDir, path);
                // Use relative path with cwd so output paths are relative (consistent with grep)
                // -not -type l excludes symlinks from results
                const { stdout } = await execFileAsync(
                    'find',
                    [
                        path,
                        '-maxdepth',
                        String(maxDepth),
                        '-type',
                        'f',
                        '-not',
                        '-type',
                        'l',
                    ],
                    {
                        cwd: repoDir,
                        timeout: CMD_TIMEOUT_MS,
                        maxBuffer: MAX_BUFFER,
                    },
                );
                return stdout;
            },

            exec: async (
                command: string,
            ): Promise<{ stdout: string; exitCode: number }> => {
                // Strict whitelist — only allow programs that READ files. This
                // runs on the host machine with no container isolation, so any
                // program that evaluates code in the cloned repo is an RCE
                // vector: `cargo check` runs `build.rs`, `npx` resolves local
                // `node_modules/.bin/*` binaries that a PR can ship, `go
                // generate` runs `//go:generate` directives, `eslint` loads
                // custom plugins via `.eslintrc`, `tsc` can trigger module
                // resolution side effects, and `python`/`python3` are direct
                // code execution. Running those here means a malicious PR is
                // host RCE on the worker. They only stay safe inside the E2B
                // provider, which has real container isolation.
                const ALLOWED_PROGRAMS = new Set([
                    'sg', // ast-grep (macOS/homebrew)
                    'ast-grep', // ast-grep (npm global)
                    'cat',
                    'wc',
                    'head',
                    'tail',
                    'file',
                    'fd', // fast file finder (respects .gitignore)
                    'find', // fallback file finder
                    'grep', // text filter used in pipelines (e.g. `... | grep -v "Syntax OK"`)
                ]);

                if (!command.trim()) {
                    return { stdout: '', exitCode: 1 };
                }

                // Reject shell features we don't emulate up front. We support
                // only the subset the agent tools actually emit:
                //   - `2>&1` (stderr merged into stdout, which we always do)
                //   - top-level `|` pipelines between whitelisted programs
                // Anything else (`>`, `>>`, `<`, `;`, `&&`, `||`, backticks,
                // `$(...)`) would require real shell semantics we intentionally
                // don't provide, so we bail out instead of running it through
                // execFile where the operator would be passed as a literal arg
                // and confuse the underlying tool.
                // Command substitution (`...` / $(...)) is never legitimate
                // input for our tool commands. Check on the raw command first,
                // before any quote stripping, so a payload hidden inside a
                // quoted string (e.g. `cat "file-$(reboot)"`) can't slip past
                // the later "outside quotes" scan and — if this layer ever
                // gets wired to a real shell — execute.
                if (/`|\$\(/.test(command)) {
                    return {
                        stdout: `Command substitution is not allowed in local sandbox: ${command}`,
                        exitCode: 1,
                    };
                }

                const outsideQuotes = command
                    .replace(/"[^"]*"|'[^']*'/g, '')
                    .replace(/\b2>&1\b/g, '');
                if (/(?:>>|<<|>|<|;|&&|\|\|)/.test(outsideQuotes)) {
                    return {
                        stdout: `Unsupported shell syntax in local sandbox: ${command}`,
                        exitCode: 1,
                    };
                }

                // Split into pipeline stages on top-level `|` (respecting quotes).
                const stages = command
                    .split(/\|(?=(?:[^"']*(?:"[^"]*"|'[^']*'))*[^"']*$)/)
                    .map((s) => s.trim())
                    .filter(Boolean);

                const validated: Array<{ program: string; args: string[] }> =
                    [];
                for (const stage of stages) {
                    // Drop `2>&1` tokens — stderr is always merged into stdout below.
                    const parts =
                        stage.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || [];
                    if (parts.length === 0) {
                        return { stdout: '', exitCode: 1 };
                    }
                    const tokens = parts
                        .map((p) => p.replace(/^['"]|['"]$/g, ''))
                        .filter((t) => t !== '2>&1');
                    const [program, ...args] = tokens;

                    if (!ALLOWED_PROGRAMS.has(program)) {
                        return {
                            stdout: `Program "${program}" is not allowed in local sandbox. Allowed: ${[...ALLOWED_PROGRAMS].join(', ')}`,
                            exitCode: 1,
                        };
                    }

                    // Block path traversal anywhere in the argument list. The
                    // old implementation tried to skip flags + their values,
                    // but it assumed every flag takes a value — so a valueless
                    // flag right before a malicious path (e.g.
                    // `cat -n ../../../etc/passwd`) would skip the dangerous
                    // arg. Validate every argument instead; flags themselves
                    // never contain `..` or `/foo` so they will pass naturally.
                    //
                    // Allow `..` as part of pattern syntax (e.g. ripgrep
                    // `'$A..$B'`) by only flagging it when it appears as a
                    // path segment, and only treat absolute paths as traversal
                    // when they look like filesystem paths (start with `/`) —
                    // flag shorthands like `-n` or `--include` start with `-`,
                    // never `/`.
                    const hasTraversal = args.some(
                        (a) => a.startsWith('/') || /(^|\/)\.\.($|\/)/.test(a),
                    );
                    if (hasTraversal) {
                        return {
                            stdout: 'Arguments with path traversal (..) or absolute paths are not allowed.',
                            exitCode: 1,
                        };
                    }

                    validated.push({ program, args });
                }

                if (validated.length === 1) {
                    try {
                        const { stdout, stderr } = await execFileAsync(
                            validated[0].program,
                            validated[0].args,
                            {
                                cwd: repoDir,
                                timeout: CMD_TIMEOUT_MS,
                                maxBuffer: MAX_BUFFER,
                            },
                        );
                        return {
                            stdout: stdout + (stderr || ''),
                            exitCode: 0,
                        };
                    } catch (error: any) {
                        return {
                            stdout: (error.stdout || '') + (error.stderr || ''),
                            exitCode: error.code ?? 1,
                        };
                    }
                }

                return await new Promise((resolve) => {
                    const children = validated.map(({ program, args }, idx) =>
                        spawn(program, args, {
                            cwd: repoDir,
                            stdio: [
                                idx === 0 ? 'ignore' : 'pipe',
                                'pipe',
                                'pipe',
                            ],
                        }),
                    );

                    let finalOutput = '';
                    let totalSize = 0;
                    let bufferExceeded = false;
                    const collect = (chunk: Buffer) => {
                        if (bufferExceeded) return;
                        totalSize += chunk.length;
                        if (totalSize > MAX_BUFFER) {
                            bufferExceeded = true;
                            finalOutput += '\n[output truncated]';
                            return;
                        }
                        finalOutput += chunk.toString('utf8');
                    };

                    for (let i = 0; i < children.length; i++) {
                        const child = children[i];
                        const next = children[i + 1];
                        // Merge stderr of every stage into the final output so
                        // compiler/linter diagnostics (usually on stderr) survive.
                        child.stderr?.on('data', collect);
                        if (next) {
                            child.stdout?.pipe(next.stdin!);
                            child.stdout?.on('error', () => {});
                            next.stdin?.on('error', () => {});
                        } else {
                            child.stdout?.on('data', collect);
                        }
                    }

                    const last = children[children.length - 1];
                    const timeout = setTimeout(() => {
                        for (const c of children) c.kill('SIGTERM');
                    }, CMD_TIMEOUT_MS);

                    last.on('close', (code) => {
                        clearTimeout(timeout);
                        resolve({ stdout: finalOutput, exitCode: code ?? 0 });
                    });

                    for (const c of children) {
                        c.on('error', (err) => {
                            finalOutput += `\n${err.message}`;
                        });
                    }
                });
            },
        };
    }

    /**
     * Apply a unified diff on top of the currently-checked-out commit. Used
     * in CLI mode so the agent sees the user's actual local working state.
     * `--3way` falls back to a 3-way merge using the blob SHAs embedded in
     * the diff when the line context drifts. Failures are non-fatal — we
     * log and proceed with the merge-base content rather than aborting the
     * review.
     */
    private async applyLocalDiff(
        repoDir: string,
        unifiedDiff: string,
    ): Promise<void> {
        const patchPath = join(repoDir, '.kodus-cli.patch');
        try {
            await writeFile(patchPath, unifiedDiff, 'utf-8');
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to write CLI diff to sandbox; agent will review merge-base only',
                context: LocalSandboxService.name,
                error,
            });
            return;
        }

        // Configure dummy identity so `--3way` can write merge commits if
        // it needs to.
        try {
            await execFileAsync(
                'git',
                ['-C', repoDir, 'config', 'user.email', 'kodus-cli@kodus.local'],
                { timeout: 5_000 },
            );
            await execFileAsync(
                'git',
                ['-C', repoDir, 'config', 'user.name', 'Kodus CLI'],
                { timeout: 5_000 },
            );
        } catch {
            // ignore — `git apply` may still work without identity
        }

        try {
            await execFileAsync(
                'git',
                [
                    '-C',
                    repoDir,
                    'apply',
                    '--3way',
                    '--whitespace=nowarn',
                    patchPath,
                ],
                { timeout: CLONE_TIMEOUT_MS },
            );
            this.logger.log({
                message:
                    'CLI diff applied successfully on top of merge-base',
                context: LocalSandboxService.name,
            });
            return;
        } catch (error: any) {
            this.logger.warn({
                message: `git apply --3way failed (${error.code ?? 'unknown'}), retrying with --reject`,
                context: LocalSandboxService.name,
                metadata: {
                    stderr: (error.stderr ?? '').slice(0, 500),
                },
            });
        }

        // Fallback: --reject leaves .rej files for hunks that didn't apply
        // but writes the ones that did. Not great, but better than the
        // self-contained mode.
        try {
            await execFileAsync(
                'git',
                [
                    '-C',
                    repoDir,
                    'apply',
                    '--whitespace=fix',
                    '--reject',
                    patchPath,
                ],
                { timeout: CLONE_TIMEOUT_MS },
            );
        } catch (error: any) {
            this.logger.warn({
                message:
                    'CLI diff fallback apply also failed; agent will see merge-base content',
                context: LocalSandboxService.name,
                metadata: {
                    stderr: (error.stderr ?? '').slice(0, 500),
                },
            });
        }
    }

    private validatePath(path: string): void {
        if (path.startsWith('/')) {
            throw new Error('Absolute paths are not allowed');
        }
        if (path.includes('..')) {
            throw new Error('Path traversal using ".." is not allowed');
        }
    }

    /**
     * Resolve a relative path within the repo, ensuring the real path
     * stays inside repoDir (prevents symlink escapes).
     */
    private async resolveSafePath(
        repoDir: string,
        path: string,
    ): Promise<string> {
        this.validatePath(path);
        const candidate = join(repoDir, path);

        // Check if the target itself is a symlink before resolving
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink()) {
            throw new Error(`Symlink detected, refusing to follow: ${path}`);
        }

        // Resolve to real path and verify it's still under repoDir
        const real = await realpath(candidate);
        const repoReal = await realpath(repoDir);
        if (!real.startsWith(repoReal + '/') && real !== repoReal) {
            throw new Error(`Path escapes repo boundary: ${path}`);
        }

        return candidate;
    }

    private buildAuthHeader(
        platform: PlatformType,
        token: string,
        username?: string,
    ): string {
        switch (platform) {
            case PlatformType.GITHUB:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
            case PlatformType.BITBUCKET: {
                // Bitbucket git-over-HTTPS auth differs from the REST API.
                // Atlassian API tokens (ATATT…, the scheme that replaces app
                // passwords) authenticate to git ONLY with the literal
                // username `x-bitbucket-api-token-auth` — the REST API accepts
                // <email>:<token>, but git rejects that pair (→ "could not
                // read Username"). Classic app passwords keep using the
                // Bitbucket account username. See #1168.
                const gitUsername = token.startsWith('ATATT')
                    ? 'x-bitbucket-api-token-auth'
                    : username;
                if (!gitUsername) {
                    throw new Error(
                        'Bitbucket authentication requires a username (app password) or an Atlassian API token, but neither was provided.',
                    );
                }
                return `Authorization: Basic ${Buffer.from(`${gitUsername}:${token}`).toString('base64')}`;
            }
            case PlatformType.GITLAB:
            case PlatformType.AZURE_REPOS:
                return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
            default:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        }
    }

    private getPrRefspec(
        platform: PlatformType,
        prNumber: number,
        cloneUrl: string,
        branch: string,
    ): string {
        switch (platform) {
            case PlatformType.GITHUB:
                return `refs/pull/${prNumber}/head`;
            case PlatformType.GITLAB:
                return `refs/merge-requests/${prNumber}/head`;
            case PlatformType.BITBUCKET: {
                const isCloud = /(^|\/\/|\.)bitbucket\.org(\/|$)/i.test(
                    cloneUrl,
                );
                return isCloud
                    ? `refs/heads/${branch}`
                    : `refs/pull-requests/${prNumber}/from`;
            }
            case PlatformType.AZURE_REPOS:
                return `refs/pull/${prNumber}/merge`;
            default:
                return `refs/pull/${prNumber}/head`;
        }
    }
}
