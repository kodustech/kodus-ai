import { createLogger } from '@kodus/flow';
import { PlatformType } from '@libs/core/domain/enums';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Sandbox } from 'e2b';

import { RemoteCommands } from './collectCrossFileContexts.service';

const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const REPO_DIR = '/home/user/repo';

interface CreateSandboxParams {
    cloneUrl: string;
    authToken: string;
    branch: string;
    prNumber?: number;
    platform: PlatformType;
}

interface SandboxWithCommands {
    remoteCommands: RemoteCommands;
    cleanup: () => Promise<void>;
}

@Injectable()
export class E2BSandboxService {
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
    ): Promise<SandboxWithCommands> {
        const { cloneUrl, authToken, branch, prNumber, platform } = params;
        const apiKey = this.configService.get<string>('API_E2B_KEY');

        if (!apiKey) {
            throw new Error('API_E2B_KEY is not configured');
        }

        const { sandbox, usedTemplate } = await this.createSandbox(apiKey);

        try {
            // Install dependencies only when not using a pre-built template
            // When using a template, git/ripgrep and proxy are already configured
            if (!usedTemplate) {
                await sandbox.commands.run(
                    'apt-get update -qq && apt-get install -y -qq git ripgrep shadowsocks-libev > /dev/null 2>&1',
                    { timeoutMs: 120_000, user: 'root' },
                );
            }

            // Configure Shadowsocks proxy for IP tunneling (clients with restricted git access)
            await this.setupProxy(sandbox);

            // Shallow-fetch the PR ref or branch (minimal network transfer)
            const refspec =
                prNumber != null
                    ? this.getPrRefspec(platform, prNumber)
                    : `refs/heads/${branch}`;
            const localRef = prNumber != null ? 'pr-head' : 'cli-head';
            const authHeader = this.buildAuthHeader(platform, authToken);

            await sandbox.commands.run(
                [
                    `git init ${REPO_DIR}`,
                    `cd ${REPO_DIR}`,
                    // Fetch using token from env var via git credential header (never touches disk/process args)
                    `git -c http.extraHeader="$GIT_AUTH_HEADER" fetch --depth=1 ${cloneUrl} ${refspec}:${localRef}`,
                    `git checkout ${localRef}`,
                    // Set a dummy remote for any tools that expect "origin" to exist
                    `git remote add origin ${cloneUrl}`,
                    // Block any push from the sandbox
                    `git remote set-url --push origin no-push-allowed`,
                ].join(' && '),
                {
                    timeoutMs: 120_000,
                    envs: { GIT_AUTH_HEADER: authHeader },
                },
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

            return { remoteCommands, cleanup };
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

    private async createSandbox(
        apiKey: string,
    ): Promise<{ sandbox: Sandbox; usedTemplate: boolean }> {
        const templateId = this.configService.get<string>(
            'API_E2B_TEMPLATE_ID',
        );

        if (templateId) {
            try {
                const sandbox = await Sandbox.create(templateId, {
                    timeoutMs: SANDBOX_TIMEOUT_MS,
                    apiKey,
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

        const sandbox = await Sandbox.create({
            timeoutMs: SANDBOX_TIMEOUT_MS,
            apiKey,
        });
        return { sandbox, usedTemplate: false };
    }

    private async setupProxy(sandbox: Sandbox): Promise<void> {
        const host = this.configService.get<string>('E2B_PROXY_HOST');
        if (!host) return;

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
                timeoutMs: 10_000,
                user: 'root',
                envs: { SS_PASSWORD: password },
            },
        );

        // Route all git traffic through the SOCKS5 proxy
        await sandbox.commands.run(
            'git config --global http.proxy socks5://127.0.0.1:1080',
            { timeoutMs: 5_000 },
        );
    }

    private buildAuthHeader(platform: PlatformType, token: string): string {
        // Git http.extraHeader sends an Authorization header — token never embedded in URLs
        switch (platform) {
            case PlatformType.GITHUB:
            case PlatformType.BITBUCKET:
                return `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
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

    private buildRemoteCommands(sandbox: Sandbox): RemoteCommands {
        return {
            grep: async (
                pattern: string,
                path: string,
                glob?: string,
            ): Promise<string> => {
                // Validate path (same security checks as resolvePath)
                if (path.startsWith('/')) {
                    throw new Error('Absolute paths are not allowed');
                }
                if (path.includes('..')) {
                    throw new Error(
                        'Path traversal using ".." is not allowed',
                    );
                }
                const escapedPath = path.replace(/'/g, "'\\''");
                const globArg = glob
                    ? ` --glob '${glob.replace(/'/g, "'\\''")}'`
                    : '';
                // Use single quotes to prevent bash from interpreting
                // regex escape sequences (e.g. \b as backspace).
                const escapedPattern = pattern.replace(/'/g, "'\\''");
                // Run inside REPO_DIR so rg outputs relative paths (e.g. "./src/foo.ts")
                // instead of absolute ones (which resolvePath rejects on read).
                const result = await sandbox.commands.run(
                    `cd ${REPO_DIR} && rg --no-heading -n '${escapedPattern}' '${escapedPath}'${globArg}`,
                    { timeoutMs: 30_000 },
                );
                return result.stdout;
            },

            read: async (
                path: string,
                start: number,
                end: number,
            ): Promise<string> => {
                const fullPath = this.resolvePath(path);
                const escapedPath = fullPath.replace(/'/g, "'\\''");
                const result = await sandbox.commands.run(
                    `sed -n '${start},${end}p' '${escapedPath}'`,
                    { timeoutMs: 10_000 },
                );
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
                    { timeoutMs: 30_000 },
                );
                return result.stdout;
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
