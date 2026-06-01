import { createLogger } from '@kodus/flow';
import { PlatformType } from '@libs/core/domain/enums';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sandbox } from 'e2b';

import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
    SandboxRunResult,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';

// 35 minutes — aligned with the lease lifecycle ceiling.
// Lease docs expire at DEFAULT_LEASE_TTL_MS (30 min) and the reaper cron
// runs every 5 min, so a sandbox is always explicitly killed by the reaper
// within ≤35 min of creation regardless of E2B's own timeout. Setting
// `timeoutMs` higher than that is dead weight. With `onTimeout: 'pause'`
// + `autoResume: true`, hitting 35 min just pauses the sandbox — the
// reaper then issues `Sandbox.kill` on the next cron tick.
// E2B bills by live-minute, not by this ceiling — the pipeline's
// onPipelineFinish observer calls sandbox.cleanup() on every exit path,
// so this is a safety ceiling, not a cost floor.
const SANDBOX_TIMEOUT_MS = 35 * 60 * 1000;
const REPO_DIR = '/home/user/repo';

const TIMEOUTS = {
    CLONE_MS: 300_000, // 5 min — large repos (cal.com, grafana) need more time for shallow clone
    PROXY_DAEMON_MS: 10_000,
    PROXY_CONFIG_MS: 5_000,
    VERIFY_MS: 10_000,
    COMMAND_LONG_MS: 30_000,
    COMMAND_SHORT_MS: 10_000,
};

@Injectable()
export class E2BSandboxService implements ISandboxProvider {
    private readonly logger = createLogger(E2BSandboxService.name);

    constructor(private readonly configService: ConfigService) {}

    isAvailable(): boolean {
        return !!this.configService.get<string>('API_E2B_KEY');
    }

    isProxyConfigured(): boolean {
        return !!this.configService.get<string>('E2B_PROXY_HOST');
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
            baseBranch,
        } = params;
        const apiKey = this.configService.get<string>('API_E2B_KEY');

        if (!apiKey) {
            throw new Error('API_E2B_KEY is not configured');
        }

        this.logger.log({
            message: `[DEBUG] Creating E2B sandbox for PR#${prNumber ?? '?'} branch=${branch}`,
            context: E2BSandboxService.name,
            metadata: {
                cloneUrl,
                branch,
                prNumber,
                platform,
                hasAuthToken: !!authToken,
            },
        });

        const { sandbox, usedTemplate } = await this.createSandbox(apiKey, {
            ...(prNumber != null && { prNumber: String(prNumber) }),
            ...params.sandboxMetadata,
        });

        this.logger.log({
            message: `[DEBUG] E2B sandbox created (template=${usedTemplate}, id=${sandbox.sandboxId ?? 'unknown'})`,
            context: E2BSandboxService.name,
            metadata: { usedTemplate, sandboxId: sandbox.sandboxId },
        });

        try {
            // Install dependencies only when not using a pre-built template
            // When using a template, git/ripgrep and proxy are already configured
            if (!usedTemplate) {
                await this.installDependencies(sandbox);
            }

            // Configure Shadowsocks proxy for IP tunneling (clients with restricted git access)
            await this.setupProxy(sandbox);

            await this.cloneRepository(sandbox, params);

            // CLI mode: when the user's branch isn't pushed (or there are
            // uncommitted changes), the regular fetch above fails — we
            // instead fetch the merge-base SHA (always present on the
            // remote) and apply the local diff on top, recreating the
            // working state inside the sandbox.
            if (params.unifiedDiff && params.checkoutSha) {
                await this.applyLocalDiff(sandbox, params.unifiedDiff);
            }

            // Fetch base branch so git diff origin/${baseBranch}...HEAD works
            const resolvedBaseBranch = await this.fetchBaseBranch(
                sandbox,
                params,
            );

            const remoteCommands = this.buildRemoteCommands(sandbox);

            const cleanup = async () => {
                try {
                    await sandbox.kill();
                } catch (error) {
                    this.logger.warn({
                        message: `Failed to kill E2B sandbox${prNumber ? ` for PR#${prNumber}` : ` for branch ${branch}`}`,
                        context: E2BSandboxService.name,
                        error,
                    });
                }
            };

            return {
                remoteCommands,
                cleanup,
                type: 'e2b' as const,
                sandboxId: sandbox.sandboxId,
                baseBranch: resolvedBaseBranch,
                repoDir: REPO_DIR,
                run: async (
                    command: string,
                    opts?: { timeoutMs?: number },
                ): Promise<SandboxRunResult> => {
                    const result = await sandbox.commands.run(command, {
                        timeoutMs: opts?.timeoutMs ?? TIMEOUTS.COMMAND_LONG_MS,
                    });
                    return {
                        stdout: result.stdout || '',
                        stderr: result.stderr || '',
                        exitCode: result.exitCode,
                    };
                },
                readFile: async (
                    path: string,
                    opts?: { timeoutMs?: number },
                ): Promise<string> => {
                    return sandbox.files.read(path, {
                        requestTimeoutMs: opts?.timeoutMs ?? 600_000,
                    });
                },
                writeFile: async (
                    path: string,
                    content: string,
                ): Promise<void> => {
                    await sandbox.files.write(path, content);
                },
            };
        } catch (error) {
            // If setup fails, kill the sandbox before re-throwing
            try {
                await sandbox.kill();
            } catch {
                // Ignore cleanup errors
            }
            throw error;
        }
    }

    /**
     * Set an idle timeout on an existing sandbox.
     * Called by SandboxLeaseManager.release() when leaseCount hits 0 to set
     * a short idle window before E2B pauses the sandbox automatically.
     * The sandbox stays alive until idleMs elapses with no active connections.
     */
    async pauseAfterIdle(sandboxId: string, idleMs: number): Promise<void> {
        const apiKey = this.configService.get<string>('API_E2B_KEY');
        if (!apiKey) {
            throw new Error('API_E2B_KEY is not configured');
        }
        await Sandbox.setTimeout(sandboxId, idleMs, { apiKey });
        this.logger.log({
            message: `[DEBUG] pauseAfterIdle: set idleMs=${idleMs} on sandboxId=${sandboxId}`,
            context: E2BSandboxService.name,
            metadata: { sandboxId, idleMs },
        });
    }

    /**
     * Connect to an existing sandbox by ID, resuming it if it is paused.
     * SDK doc: "If the sandbox is paused, it will be automatically resumed"
     * (e2b/dist/index.d.ts:7990). autoResume: true at create time is what
     * makes this work — see createSandbox() above.
     * Called by SandboxLeaseManager.acquire() when state === 'READY'.
     */
    async connectExisting(sandboxId: string): Promise<Sandbox> {
        const apiKey = this.configService.get<string>('API_E2B_KEY');
        if (!apiKey) {
            throw new Error('API_E2B_KEY is not configured');
        }
        this.logger.log({
            message: `[DEBUG] connectExisting: connecting to sandboxId=${sandboxId}`,
            context: E2BSandboxService.name,
            metadata: { sandboxId },
        });
        return Sandbox.connect(sandboxId, { apiKey });
    }

    private async installDependencies(sandbox: Sandbox): Promise<void> {
        const installResult = await sandbox.commands.run(
            'apt-get update -qq && apt-get install -y -qq git ripgrep shadowsocks-libev > /dev/null 2>&1',
            { timeoutMs: TIMEOUTS.CLONE_MS, user: 'root' },
        );
        this.logger.log({
            message: `[DEBUG] apt-get install exitCode=${installResult.exitCode}`,
            context: E2BSandboxService.name,
            metadata: {
                exitCode: installResult.exitCode,
                stderr: installResult.stderr?.slice(0, 300),
            },
        });
    }

    private async cloneRepository(
        sandbox: Sandbox,
        params: CreateSandboxParams,
    ): Promise<void> {
        const {
            cloneUrl,
            authToken,
            authUsername,
            branch,
            prNumber,
            platform,
            checkoutSha,
        } = params;

        // CLI mode with merge-base SHA: fetch that SHA directly. Avoids
        // depending on the user's branch existing on the remote (it may
        // not be pushed yet) — the merge-base is always there.
        // PR mode: fetch the PR refspec.
        // Otherwise: fetch the branch ref.
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
        // Skip auth header entirely for anonymous clones (trial users on
        // public repos). Without this guard we'd send `x-access-token:` with
        // an empty password — GitHub still accepts it for public reads but
        // it's noise; for private repos we want the real 401/404 fast.
        const hasAuth = !!authToken;
        const authHeader = hasAuth
            ? this.buildAuthHeader(platform, authToken, authUsername)
            : '';

        this.logger.log({
            message: `[DEBUG] Git clone starting: refspec=${refspec} localRef=${localRef} cloneUrl=${cloneUrl}`,
            context: E2BSandboxService.name,
            metadata: {
                refspec,
                localRef,
                cloneUrl,
                platform,
                hasProxy: this.isProxyConfigured(),
                hasAuth,
            },
        });

        // `refspec` and `localRef` are built from PR/branch data that can be
        // controlled by a forked PR author; `cloneUrl` is ours but still best
        // practice. Quote all three to keep the shell from interpreting any
        // metacharacters a crafted ref name could carry.
        const safeCloneUrl = shSingleQuote(cloneUrl);
        const safeRefspec = shSingleQuote(refspec);
        const safeLocalRef = shSingleQuote(localRef);

        const fetchCmd = hasAuth
            ? `git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --depth=1 ${safeCloneUrl} ${safeRefspec}:${safeLocalRef}`
            : `git fetch --depth=1 ${safeCloneUrl} ${safeRefspec}:${safeLocalRef}`;

        const cloneResult = await sandbox.commands.run(
            [
                `git init ${REPO_DIR}`,
                `cd ${REPO_DIR}`,
                // Fetch using token from env var via git credential header (never touches disk/process args)
                fetchCmd,
                `git checkout ${safeLocalRef}`,
                // Set a dummy remote for any tools that expect "origin" to exist
                `git remote add origin ${safeCloneUrl}`,
                // Block any push from the sandbox
                `git remote set-url --push origin no-push-allowed`,
            ].join(' && '),
            {
                timeoutMs: TIMEOUTS.CLONE_MS,
                ...(hasAuth && { envs: { GIT_AUTH_HEADER: authHeader } }),
            },
        );

        this.logger.log({
            message: `[DEBUG] Git clone finished: exitCode=${cloneResult.exitCode} stdout=${(cloneResult.stdout || '').length}chars stderr=${(cloneResult.stderr || '').length}chars`,
            context: E2BSandboxService.name,
            metadata: {
                exitCode: cloneResult.exitCode,
                stdout: cloneResult.stdout?.slice(0, 500),
                stderr: cloneResult.stderr?.slice(0, 500),
            },
        });

        if (cloneResult.exitCode !== 0) {
            throw new Error(
                `Git clone failed in E2B sandbox (exit code ${cloneResult.exitCode}): ${cloneResult.stderr || cloneResult.stdout}`.slice(
                    0,
                    500,
                ),
            );
        }

        // Verify repo contents after clone
        const verifyResult = await sandbox.commands.run(
            `ls -la ${REPO_DIR} && echo "---FILE-COUNT---" && find ${REPO_DIR} -maxdepth 2 -type f | head -20`,
            { timeoutMs: TIMEOUTS.VERIFY_MS },
        );
        this.logger.log({
            message: `[DEBUG] Repo contents after clone (first 500 chars): ${verifyResult.stdout?.slice(0, 500)}`,
            context: E2BSandboxService.name,
            metadata: {
                exitCode: verifyResult.exitCode,
                stdout: verifyResult.stdout?.slice(0, 500),
            },
        });
    }

    /**
     * Apply a unified diff on top of the currently-checked-out commit. Used
     * in CLI mode to recreate the user's local working state on top of the
     * merge-base SHA we just cloned. `--3way` makes apply tolerant to
     * context drift (it falls back to a 3-way merge using the blob SHAs
     * embedded in the diff). Failure is non-fatal: we log and continue —
     * worst case the agent reviews the merge-base instead of the user's
     * local changes, which is still better than self-contained mode.
     */
    private async applyLocalDiff(
        sandbox: Sandbox,
        unifiedDiff: string,
    ): Promise<void> {
        const PATCH_PATH = '/tmp/kodus-cli.patch';

        try {
            await sandbox.files.write(PATCH_PATH, unifiedDiff);
        } catch (error) {
            this.logger.warn({
                message:
                    '[DEBUG] Failed to write CLI diff to sandbox; agent will review merge-base only',
                context: E2BSandboxService.name,
                error,
            });
            return;
        }

        // Configure a dummy identity so `git apply --3way` (which records a
        // commit when it falls back) doesn't error on missing user.email.
        // Then try `git apply --3way` first; if that fails, retry with
        // `git apply --whitespace=fix` which is more permissive but loses
        // 3-way fallback. Last resort: log and move on.
        const result = await sandbox.commands.run(
            [
                `cd ${REPO_DIR}`,
                `git config user.email kodus-cli@kodus.local`,
                `git config user.name 'Kodus CLI'`,
                `git apply --3way --whitespace=nowarn ${PATCH_PATH}`,
            ].join(' && '),
            { timeoutMs: TIMEOUTS.COMMAND_LONG_MS },
        );

        if (result.exitCode === 0) {
            this.logger.log({
                message: `[DEBUG] CLI diff applied successfully on top of merge-base`,
                context: E2BSandboxService.name,
            });
            return;
        }

        this.logger.warn({
            message: `[DEBUG] git apply --3way failed (exit=${result.exitCode}), retrying with --whitespace=fix`,
            context: E2BSandboxService.name,
            metadata: {
                stderr: result.stderr?.slice(0, 500),
            },
        });

        const retry = await sandbox.commands.run(
            `cd ${REPO_DIR} && git apply --whitespace=fix --reject ${PATCH_PATH} || true`,
            { timeoutMs: TIMEOUTS.COMMAND_LONG_MS },
        );

        this.logger.warn({
            message: `[DEBUG] git apply fallback finished (exit=${retry.exitCode}); agent will see whichever hunks applied`,
            context: E2BSandboxService.name,
            metadata: {
                stdout: retry.stdout?.slice(0, 300),
                stderr: retry.stderr?.slice(0, 300),
            },
        });
    }

    /**
     * Fetch the base branch (e.g. main/develop) so that git diff origin/${baseBranch}...HEAD
     * works inside the sandbox. Returns the branch name on success, undefined on failure.
     * Failure is non-fatal — tools will fall back to the GitHub API.
     */
    private async fetchBaseBranch(
        sandbox: Sandbox,
        params: CreateSandboxParams,
    ): Promise<string | undefined> {
        const { cloneUrl, authToken, authUsername, platform, baseBranch } =
            params;
        if (!baseBranch) return undefined;

        const hasAuth = !!authToken;
        const authHeader = hasAuth
            ? this.buildAuthHeader(platform, authToken, authUsername)
            : '';

        this.logger.log({
            message: `[DEBUG] Fetching base branch: ${baseBranch}`,
            context: E2BSandboxService.name,
            metadata: { baseBranch, hasAuth },
        });

        const safeBaseBranch = shSingleQuote(baseBranch);
        const safeCloneUrl = shSingleQuote(cloneUrl);

        const baseCmd = hasAuth
            ? `cd ${REPO_DIR} && git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --depth=1 ${safeCloneUrl} refs/heads/${safeBaseBranch}:refs/remotes/origin/${safeBaseBranch}`
            : `cd ${REPO_DIR} && git fetch --depth=1 ${safeCloneUrl} refs/heads/${safeBaseBranch}:refs/remotes/origin/${safeBaseBranch}`;

        try {
            const result = await sandbox.commands.run(
                baseCmd,
                {
                    timeoutMs: TIMEOUTS.CLONE_MS,
                    ...(hasAuth && { envs: { GIT_AUTH_HEADER: authHeader } }),
                },
            );

            if (result.exitCode === 0) {
                this.logger.log({
                    message: `[DEBUG] Base branch fetched successfully: origin/${baseBranch}`,
                    context: E2BSandboxService.name,
                });
                return baseBranch;
            }

            this.logger.warn({
                message: `[DEBUG] Failed to fetch base branch ${baseBranch}: exitCode=${result.exitCode} stderr=${(result.stderr || '').slice(0, 300)}`,
                context: E2BSandboxService.name,
            });
            return undefined;
        } catch (error) {
            this.logger.warn({
                message: `[DEBUG] Error fetching base branch ${baseBranch}, tools will use API fallback`,
                context: E2BSandboxService.name,
                error,
            });
            return undefined;
        }
    }

    private async createSandbox(
        apiKey: string,
        metadata?: Record<string, string>,
    ): Promise<{ sandbox: Sandbox; usedTemplate: boolean }> {
        const isGraphStage =
            metadata?.stage === 'graph-build' ||
            metadata?.stage === 'graph-incremental';

        // Use dedicated graph template (2 GB) for graph build stages,
        // fall back to the default template (1 GB) for everything else.
        const templateId =
            (isGraphStage
                ? this.configService.get<string>('API_E2B_TEMPLATE_GRAPH_ID')
                : undefined) ??
            this.configService.get<string>('API_E2B_TEMPLATE_ID');

        if (templateId) {
            try {
                // autoResume: true is required — SDK default is false; omitting it causes Sandbox.connect() to throw on paused sandboxes
                const sandbox = await Sandbox.create(templateId, {
                    timeoutMs: SANDBOX_TIMEOUT_MS,
                    apiKey,
                    metadata,
                    lifecycle: { onTimeout: 'pause', autoResume: true },  // SBX-03: pause not kill; autoResume must be explicit
                });
                return { sandbox, usedTemplate: true };
            } catch (error) {
                this.logger.warn({
                    message: `Failed to create E2B sandbox with template "${templateId}", falling back to default`,
                    context: E2BSandboxService.name,
                    error,
                });
            }
        }

        // autoResume: true is required — SDK default is false; omitting it causes Sandbox.connect() to throw on paused sandboxes
        const sandbox = await Sandbox.create({
            timeoutMs: SANDBOX_TIMEOUT_MS,
            apiKey,
            metadata,
            lifecycle: { onTimeout: 'pause', autoResume: true },  // SBX-03: pause not kill; autoResume must be explicit
        });
        return { sandbox, usedTemplate: false };
    }

    private async setupProxy(sandbox: Sandbox): Promise<void> {
        const host = this.configService.get<string>('E2B_PROXY_HOST');
        if (!host) {
            this.logger.log({
                message: `[DEBUG] No E2B_PROXY_HOST configured, skipping proxy setup`,
                context: E2BSandboxService.name,
            });
            return;
        }

        const port = this.configService.get<string>('E2B_PROXY_PORT') ?? '8388';
        const password = this.configService.get<string>('E2B_PROXY_PASSWORD');
        const method =
            this.configService.get<string>('E2B_PROXY_METHOD') ?? 'aes-256-gcm';

        if (!password) {
            throw new Error(
                'E2B_PROXY_PASSWORD is required when E2B_PROXY_HOST is set',
            );
        }

        // Start ss-local daemon listening on SOCKS5 port 1080
        await sandbox.commands.run(
            `ss-local -s ${host} -p ${port} -l 1080 -k "$SS_PASSWORD" -m ${method} -d start`,
            {
                timeoutMs: TIMEOUTS.PROXY_DAEMON_MS,
                user: 'root',
                envs: { SS_PASSWORD: password },
            },
        );

        // Route all git traffic through the SOCKS5 proxy
        await sandbox.commands.run(
            'git config --global http.proxy socks5://127.0.0.1:1080',
            { timeoutMs: TIMEOUTS.PROXY_CONFIG_MS },
        );

        this.logger.log({
            message: `[DEBUG] Proxy configured: ${host}:${port} method=${method}`,
            context: E2BSandboxService.name,
        });
    }

    private buildAuthHeader(
        platform: PlatformType,
        token: string,
        username?: string,
    ): string {
        // Git http.extraHeader sends an Authorization header — token never embedded in URLs
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

    private buildRemoteCommands(sandbox: Sandbox): RemoteCommands {
        return {
            grep: async (
                pattern: string,
                path: string,
                glob?: string,
            ): Promise<string> => {
                // Validate path with the same security checks
                const fullPath = this.resolvePath(path);
                const escapedPath = fullPath.replace(/'/g, "'\\''");
                const globArg = glob
                    ? ` --glob '${glob.replace(/'/g, "'\\''")}'`
                    : '';
                // Use single quotes to prevent bash from interpreting
                // regex escape sequences (e.g. \b as backspace).
                const escapedPattern = pattern.replace(/'/g, "'\\''");

                // Run inside REPO_DIR so rg outputs relative paths (e.g. "./src/foo.ts")
                // instead of absolute ones. We pass the original `path` parameter instead of `fullPath`
                // because `resolvePath` already validated that `path` is safe (no .. or /).
                const safeRelativePath = path.replace(/'/g, "'\\''");

                const result = await sandbox.commands.run(
                    `cd ${REPO_DIR} && rg --no-heading -n '${escapedPattern}' '${safeRelativePath}'${globArg}`,
                    { timeoutMs: TIMEOUTS.COMMAND_LONG_MS },
                );
                // rg returns exit code 1 for "no matches" (not an error)
                // but stderr may contain actual errors like "permission denied"
                if (!result.stdout && result.stderr && result.exitCode !== 1) {
                    return `Error: ${result.stderr}`;
                }
                return result.stdout;
            },

            read: async (
                path: string,
                start: number,
                end: number,
            ): Promise<string> => {
                const fullPath = this.resolvePath(path);
                const escapedPath = fullPath.replace(/'/g, "'\\''");
                // When start=0 and end=0, read the entire file (cat).
                // GNU sed rejects address 0 so we must avoid `sed -n '0,0p'`.
                const cmd =
                    start === 0 && end === 0
                        ? `cat '${escapedPath}'`
                        : // sed is 1-indexed; a start address of 0 is invalid in GNU sed.
                          `sed -n '${start < 1 ? 1 : start},${end}p' '${escapedPath}'`;
                const result = await sandbox.commands.run(cmd, {
                    timeoutMs: TIMEOUTS.COMMAND_SHORT_MS,
                });
                // Debug: log when read returns empty
                if (!result.stdout) {
                    this.logger.warn({
                        message: `[SANDBOX-READ] Empty result for ${path}: exitCode=${result.exitCode} stderr=${(result.stderr || '').substring(0, 200)} cmd=${cmd}`,
                        context: E2BSandboxService.name,
                    });
                }
                // Return stderr if stdout is empty (e.g. "No such file or directory")
                if (!result.stdout && result.stderr) {
                    return `Error: ${result.stderr}`;
                }
                return result.stdout;
            },

            listDir: async (
                path: string,
                maxDepth: number,
            ): Promise<string> => {
                const fullPath = this.resolvePath(path);
                const escapedPath = fullPath.replace(/'/g, "'\\''");
                const result = await sandbox.commands.run(
                    `find '${escapedPath}' -maxdepth ${maxDepth} -type f`,
                    { timeoutMs: TIMEOUTS.COMMAND_LONG_MS },
                );
                return result.stdout;
            },

            exec: async (
                command: string,
            ): Promise<{ stdout: string; exitCode: number }> => {
                const result = await sandbox.commands.run(
                    `cd ${REPO_DIR} && ${command}`,
                    { timeoutMs: TIMEOUTS.COMMAND_LONG_MS },
                );
                return {
                    stdout: result.stdout + (result.stderr || ''),
                    exitCode: result.exitCode,
                };
            },
        };
    }

    private resolvePath(path: string): string {
        // Security: Prevent path traversal by disallowing absolute paths
        if (path.startsWith('/')) {
            throw new Error('Absolute paths are not allowed');
        }
        // Security: Prevent path traversal by disallowing '..' segments
        if (path.includes('..')) {
            throw new Error('Path traversal using ".." is not allowed');
        }
        // Resolve relative paths against the repo directory
        return `${REPO_DIR}/${path}`;
    }
}
// sandbox-test
