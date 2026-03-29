import { createLogger } from '@kodus/flow';
import { PlatformType } from '@libs/core/domain/enums';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { lstat, mkdtemp, realpath, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import {
    CreateSandboxParams,
    ISandboxProvider,
    SandboxInstance,
} from '@libs/code-review/domain/contracts/sandbox.provider';
import { RemoteCommands } from './collectCrossFileContexts.service';

const execFileAsync = promisify(execFile);

const CLONE_TIMEOUT_MS = 120_000;
const CMD_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 5 * 1024 * 1024; // 5 MB — cap output to prevent memory issues

@Injectable()
export class LocalSandboxService implements ISandboxProvider {
    private readonly logger = createLogger(LocalSandboxService.name);

    constructor(private readonly configService: ConfigService) {}

    isAvailable(): boolean {
        return this.configService.get<string>('SANDBOX_PROVIDER') === 'local';
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
        } = params;

        const tempDir = await mkdtemp(join(tmpdir(), 'kodus-sandbox-'));

        try {
            const authHeader = this.buildAuthHeader(
                platform,
                authToken,
                authUsername,
            );
            const refspec =
                prNumber != null
                    ? this.getPrRefspec(platform, prNumber)
                    : `refs/heads/${branch}`;
            const localRef = prNumber != null ? 'pr-head' : 'cli-head';

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
                },
            );

            await execFileAsync('git', ['-C', tempDir, 'checkout', localRef], {
                timeout: CLONE_TIMEOUT_MS,
            });

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

            return { remoteCommands, cleanup };
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
                const { stdout } = await execFileAsync(
                    'sed',
                    ['-n', `${start},${end}p`, safePath],
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
        };
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
            case PlatformType.BITBUCKET:
                // Bitbucket App Passwords require the actual username, not x-access-token
                if (!username) {
                    throw new Error(
                        'Bitbucket authentication requires a username, but it was not provided.',
                    );
                }
                return `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString('base64')}`;
            case PlatformType.GITLAB:
            case PlatformType.AZURE_REPOS:
                return `Authorization: Basic ${Buffer.from(`oauth2:${token}`).toString('base64')}`;
            default:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
        }
    }

    private getPrRefspec(platform: PlatformType, prNumber: number): string {
        switch (platform) {
            case PlatformType.GITHUB:
                return `refs/pull/${prNumber}/head`;
            case PlatformType.GITLAB:
                return `refs/merge-requests/${prNumber}/head`;
            case PlatformType.BITBUCKET:
                return `refs/pull-requests/${prNumber}/from`;
            case PlatformType.AZURE_REPOS:
                return `refs/pull/${prNumber}/merge`;
            default:
                return `refs/pull/${prNumber}/head`;
        }
    }
}
