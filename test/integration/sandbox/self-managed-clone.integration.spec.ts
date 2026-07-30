import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ConfigService } from '@nestjs/config';

import { IntegrationCategory, PlatformType } from '@libs/core/domain/enums';
import { AuthMode } from '@libs/platform/domain/platformIntegrations/enums/codeManagement/authMode.enum';
import { CloneParamsResolverService } from '@libs/code-review/pipeline/services/clone-params-resolver.service';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { GithubService } from '@libs/platform/infrastructure/adapters/services/github/github.service';
import { GitlabService } from '@libs/platform/infrastructure/adapters/services/gitlab.service';
import { PlatformIntegrationFactory } from '@libs/platform/infrastructure/adapters/services/platformIntegration.factory';
import { LocalSandboxService } from '@libs/sandbox/infrastructure/providers/local-sandbox.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

const execFileAsync = promisify(execFile);
const GIT_ENV = {
    GIT_AUTHOR_NAME: 'kodus-test',
    GIT_AUTHOR_EMAIL: 'test@kodus.io',
    GIT_COMMITTER_NAME: 'kodus-test',
    GIT_COMMITTER_EMAIL: 'test@kodus.io',
};

/**
 * End-to-end coverage for issue #1541 — the one layer the mocked specs cannot
 * give us.
 *
 * A real git repository is served over HTTP by git-http-backend on 127.0.0.1,
 * standing in for a self-managed instance: a host that, by definition, is not
 * on the CLI's SaaS allowlist, so `inferredPlatform` arrives undefined exactly
 * as it does for the reporter's GitLab. The real platform adapters resolve the
 * clone params, and the real sandbox runs the real `git fetch` — the same
 * command that appears in the issue's log:
 *
 *   git -C /tmp/kodus-sandbox-XXXX fetch --depth=1 <url> <sha>:cli-base
 *
 * Before the fix this fetched github.com and died with "repository not found".
 * The assertion here is that the working tree really materializes from the
 * self-managed host.
 */
describe('CLI sandbox clone against a self-managed git host', () => {
    jest.setTimeout(60_000);

    let server: Server;
    let port: number;
    let serverRoot: string;
    let workDir: string;
    let sandboxService: LocalSandboxService;
    let headSha: string;

    /** Minimal git-http-backend CGI bridge — enough for a smart-protocol fetch. */
    const startGitServer = async (root: string) =>
        new Promise<{ server: Server; port: number }>((resolve) => {
            const srv = createServer((req, res) => {
                const [path, query = ''] = (req.url || '').split('?');

                const cgi = spawn(
                    join(
                        process.env.GIT_EXEC_PATH || '',
                        'git-http-backend',
                    ),
                    [],
                    {
                        env: {
                            ...process.env,
                            GIT_PROJECT_ROOT: root,
                            GIT_HTTP_EXPORT_ALL: '1',
                            PATH_INFO: path,
                            QUERY_STRING: query,
                            REQUEST_METHOD: req.method || 'GET',
                            CONTENT_TYPE: req.headers['content-type'] || '',
                        },
                    },
                );

                req.pipe(cgi.stdin);

                let raw = Buffer.alloc(0);
                cgi.stdout.on('data', (c) => {
                    raw = Buffer.concat([raw, c]);
                });
                cgi.stdout.on('end', () => {
                    // Split CGI headers from body.
                    const sep = raw.indexOf('\r\n\r\n');
                    const head = raw.subarray(0, sep).toString();
                    const body = raw.subarray(sep + 4);

                    for (const line of head.split('\r\n')) {
                        const idx = line.indexOf(':');
                        if (idx > 0) {
                            res.setHeader(
                                line.slice(0, idx),
                                line.slice(idx + 1).trim(),
                            );
                        }
                    }
                    res.end(body);
                });
            });

            srv.listen(0, '127.0.0.1', () => {
                resolve({ server: srv, port: (srv.address() as any).port });
            });
        });

    beforeAll(async () => {
        // Resolve git's exec path so the CGI binary can be spawned.
        const { stdout } = await execFileAsync('git', ['--exec-path']);
        process.env.GIT_EXEC_PATH = stdout.trim();

        serverRoot = await mkdtemp(join(tmpdir(), 'kodus-git-server-'));
        workDir = await mkdtemp(join(tmpdir(), 'kodus-git-work-'));

        // A real repository with a real commit.
        await execFileAsync('git', ['init', '-b', 'main', workDir]);
        await writeFile(
            join(workDir, 'app.ts'),
            'export const answer = 42;\n',
            'utf8',
        );
        await execFileAsync('git', ['-C', workDir, 'add', '.']);
        await execFileAsync(
            'git',
            ['-C', workDir, 'commit', '-m', 'initial'],
            { env: { ...process.env, ...GIT_ENV } },
        );

        const { stdout: sha } = await execFileAsync('git', [
            '-C',
            workDir,
            'rev-parse',
            'HEAD',
        ]);
        headSha = sha.trim();

        // Publish it as group/repo.git under the server root.
        const barePath = join(serverRoot, 'group', 'repo.git');
        await execFileAsync('git', ['clone', '--bare', workDir, barePath]);
        // The CLI path fetches a bare SHA, which upload-pack refuses by default.
        await execFileAsync('git', [
            '-C',
            barePath,
            'config',
            'uploadpack.allowAnySHA1InWant',
            'true',
        ]);

        ({ server, port } = await startGitServer(serverRoot));

        sandboxService = new LocalSandboxService({
            get: jest.fn(),
        } as unknown as ConfigService);
    });

    afterAll(async () => {
        await new Promise<void>((resolve) => server?.close(() => resolve()));
        await rm(serverRoot, { recursive: true, force: true });
        await rm(workDir, { recursive: true, force: true });
    });

    /** Real adapters, with only the integration lookup faked. */
    const buildResolver = (host: string, connected?: PlatformType) => {
        const integrationService = {
            // What getTypeIntegration reads to resolve the team's platform.
            findOne: jest.fn(async (filter: any) =>
                filter?.integrationCategory ===
                    IntegrationCategory.CODE_MANAGEMENT && connected
                    ? { platform: connected }
                    : null,
            ),
            getPlatformAuthDetails: jest.fn(async (_org, platform) =>
                platform === PlatformType.GITLAB
                    ? {
                          accessToken: 'oauth-token',
                          authMode: AuthMode.OAUTH,
                          host,
                      }
                    : undefined,
            ),
        };

        const factory = new PlatformIntegrationFactory();
        factory.registerCodeManagementService(
            PlatformType.GITLAB,
            new GitlabService(
                integrationService as any,
                {} as any,
                {} as any,
                { get: jest.fn() } as unknown as ConfigService,
                {} as any,
            ) as any,
        );
        factory.registerCodeManagementService(
            PlatformType.GITHUB,
            new GithubService(
                integrationService as any,
                {} as any,
                {} as any,
                {} as any,
                { get: jest.fn() } as unknown as ConfigService,
            ) as any,
        );

        return new CloneParamsResolverService(
            new CodeManagementService(integrationService as any, factory),
        );
    };

    it('materializes the working tree from the self-managed host', async () => {
        const host = `http://127.0.0.1:${port}`;
        const resolver = buildResolver(host, PlatformType.GITLAB);

        const cloneInfo = await resolver.resolve(
            { origin: 'cli', organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' } } as any,
            {
                gitContext: {
                    // No inferredPlatform: 127.0.0.1 is not a SaaS host, which
                    // is precisely the reporter's situation.
                    remote: `${host}/group/repo.git`,
                    branch: 'main',
                    mergeBaseSha: headSha,
                },
            } as any,
        );

        expect(cloneInfo).not.toBeNull();
        expect(cloneInfo!.url).not.toContain('github.com');
        expect(new URL(cloneInfo!.url).port).toBe(String(port));

        const sandbox = await sandboxService.createSandboxWithRepo({
            cloneUrl: cloneInfo!.url,
            authToken: cloneInfo!.authToken,
            authUsername: cloneInfo!.authUsername,
            branch: cloneInfo!.branch,
            platform: cloneInfo!.platform,
            checkoutSha: cloneInfo!.checkoutSha,
        } as any);

        try {
            // The real proof: the file only exists if the real fetch hit the
            // real self-managed host and checked the commit out.
            const read = await sandbox.run('cat app.ts');

            expect(read.exitCode).toBe(0);
            expect(read.stdout).toContain('export const answer = 42;');
        } finally {
            await sandbox.cleanup?.();
        }
    });

    it('fails loudly instead of silently cloning github.com when nothing is connected', async () => {
        const host = `http://127.0.0.1:${port}`;
        const resolver = buildResolver(host, undefined);

        const cloneInfo = await resolver.resolve(
            { origin: 'cli', organizationAndTeamData: { organizationId: 'org-1', teamId: 'team-1' } } as any,
            {
                gitContext: {
                    remote: `${host}/group/repo.git`,
                    branch: 'main',
                    mergeBaseSha: headSha,
                },
            } as any,
        );

        // Pre-fix this returned https://github.com/group/repo with an empty
        // token, and the sandbox burned three lease retries on it.
        expect(cloneInfo).toBeNull();
    });
});
