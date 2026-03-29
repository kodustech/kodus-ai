import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { E2BSandboxService } from '@libs/code-review/infrastructure/adapters/services/e2bSandbox.service';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

// Mock e2b SDK — globally mapped via moduleNameMapper in jest.config.ts
// to avoid ESM parse errors from chalk v5+. Re-mock here to set test-specific shape.
jest.mock('e2b', () => ({
    Sandbox: {
        create: jest.fn(),
    },
}));

jest.mock('@kodus/flow', () => ({
    createLogger: () => ({
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    }),
}));

describe('E2BSandboxService', () => {
    let service: E2BSandboxService;
    let mockConfigService: any;

    const createService = async (envVars: Record<string, string> = {}) => {
        mockConfigService = {
            get: jest.fn((key: string) => envVars[key]),
        };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                E2BSandboxService,
                {
                    provide: ConfigService,
                    useValue: mockConfigService,
                },
            ],
        }).compile();

        return module.get<E2BSandboxService>(E2BSandboxService);
    };

    beforeEach(() => {
        jest.clearAllMocks();
    });

    // ─── isAvailable ───────────────────────────────────────────────────────

    describe('isAvailable()', () => {
        it('should return true when API_E2B_KEY is set', async () => {
            service = await createService({
                API_E2B_KEY: 'test-key-123',
            });
            expect(service.isAvailable()).toBe(true);
        });

        it('should return false when API_E2B_KEY is not set', async () => {
            service = await createService({});
            expect(service.isAvailable()).toBe(false);
        });
    });

    // ─── isProxyConfigured ──────────────────────────────────────────────────

    describe('isProxyConfigured()', () => {
        it('should return true when E2B_PROXY_HOST is set', async () => {
            service = await createService({
                API_E2B_KEY: 'key',
                E2B_PROXY_HOST: '10.0.0.1',
            });
            expect(service.isProxyConfigured()).toBe(true);
        });

        it('should return false when E2B_PROXY_HOST is not set', async () => {
            service = await createService({ API_E2B_KEY: 'key' });
            expect(service.isProxyConfigured()).toBe(false);
        });
    });

    // ─── buildAuthHeader ───────────────────────────────────────────────────

    describe('buildAuthHeader()', () => {
        beforeEach(async () => {
            service = await createService({ API_E2B_KEY: 'key' });
        });

        const buildAuthHeader = (
            platform: PlatformType,
            token: string,
            username?: string,
        ) => (service as any).buildAuthHeader(platform, token, username);

        it('should use x-access-token for GitHub', () => {
            const header = buildAuthHeader(PlatformType.GITHUB, 'mytoken');
            const expectedBase64 = Buffer.from(
                'x-access-token:mytoken',
            ).toString('base64');
            expect(header).toBe(`Authorization: Basic ${expectedBase64}`);
        });

        it('should use oauth2 for GitLab', () => {
            const header = buildAuthHeader(PlatformType.GITLAB, 'mytoken');
            const expectedBase64 =
                Buffer.from('oauth2:mytoken').toString('base64');
            expect(header).toBe(`Authorization: Basic ${expectedBase64}`);
        });

        it('should use actual username for Bitbucket when provided', () => {
            const header = buildAuthHeader(
                PlatformType.BITBUCKET,
                'app-pass',
                'bbuser',
            );
            const expectedBase64 =
                Buffer.from('bbuser:app-pass').toString('base64');
            expect(header).toBe(`Authorization: Basic ${expectedBase64}`);
        });

        it('should throw when Bitbucket username is missing', () => {
            expect(() =>
                buildAuthHeader(PlatformType.BITBUCKET, 'app-pass'),
            ).toThrow('Bitbucket authentication requires a username');
        });
    });

    // ─── getPrRefspec ──────────────────────────────────────────────────────

    describe('getPrRefspec()', () => {
        beforeEach(async () => {
            service = await createService({ API_E2B_KEY: 'key' });
        });

        const getPrRefspec = (platform: PlatformType, prNumber: number) =>
            (service as any).getPrRefspec(platform, prNumber);

        it('should return GitHub refspec', () => {
            expect(getPrRefspec(PlatformType.GITHUB, 42)).toBe(
                'refs/pull/42/head',
            );
        });

        it('should return GitLab refspec', () => {
            expect(getPrRefspec(PlatformType.GITLAB, 42)).toBe(
                'refs/merge-requests/42/head',
            );
        });
    });

    // ─── createSandboxWithRepo ─────────────────────────────────────────────

    describe('createSandboxWithRepo()', () => {
        const defaultParams = {
            cloneUrl: 'https://github.com/org/repo.git',
            authToken: 'token',
            branch: 'main',
            prNumber: 42,
            platform: PlatformType.GITHUB,
        };

        const setupSandboxMock = () => {
            const mockKill = jest.fn().mockResolvedValue(undefined);
            const mockRun = jest
                .fn()
                .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
            const mockSandbox = {
                commands: { run: mockRun },
                kill: mockKill,
            };

            const { Sandbox } = require('e2b');
            Sandbox.create.mockResolvedValue(mockSandbox);

            return { mockKill, mockRun, mockSandbox, Sandbox };
        };

        it('should throw when API_E2B_KEY is not configured', async () => {
            service = await createService({});

            await expect(
                service.createSandboxWithRepo(defaultParams),
            ).rejects.toThrow('API_E2B_KEY is not configured');
        });

        it('should kill sandbox on setup failure', async () => {
            service = await createService({ API_E2B_KEY: 'test-key' });

            const { Sandbox } = require('e2b');
            const mockKill = jest.fn().mockResolvedValue(undefined);
            const mockRun = jest
                .fn()
                .mockRejectedValue(new Error('apt-get failed'));

            Sandbox.create.mockResolvedValue({
                commands: { run: mockRun },
                kill: mockKill,
            });

            await expect(
                service.createSandboxWithRepo(defaultParams),
            ).rejects.toThrow('apt-get failed');

            expect(mockKill).toHaveBeenCalledTimes(1);
        });

        it('should create sandbox with correct apiKey and timeout', async () => {
            service = await createService({ API_E2B_KEY: 'my-e2b-key' });
            const { Sandbox } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            expect(Sandbox.create).toHaveBeenCalledWith({
                timeoutMs: 10 * 60 * 1000,
                apiKey: 'my-e2b-key',
            });
        });

        it('should run apt-get install as first command', async () => {
            service = await createService({ API_E2B_KEY: 'key' });
            const { mockRun } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            const firstCall = mockRun.mock.calls[0];
            expect(firstCall[0]).toContain('apt-get');
            expect(firstCall[0]).toContain('git');
            expect(firstCall[0]).toContain('ripgrep');
            expect(firstCall[1]).toEqual({ timeoutMs: 120_000, user: 'root' });
        });

        it('should run git commands with correct refspec and auth header', async () => {
            service = await createService({ API_E2B_KEY: 'key' });
            const { mockRun } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            const gitCall = mockRun.mock.calls[1];
            const gitCommand = gitCall[0];

            // Should init, fetch with refspec, checkout, add remote, block push
            expect(gitCommand).toContain('git init /home/user/repo');
            expect(gitCommand).toContain('refs/pull/42/head:pr-head');
            expect(gitCommand).toContain('git checkout pr-head');
            expect(gitCommand).toContain(
                `git remote add origin ${defaultParams.cloneUrl}`,
            );
            expect(gitCommand).toContain('no-push-allowed');

            // Auth header passed via envs, not embedded in URL
            const opts = gitCall[1];
            expect(opts.envs.GIT_AUTH_HEADER).toContain('Authorization: Basic');
            expect(opts.timeoutMs).toBe(120_000);
        });

        it('should return remoteCommands and cleanup function', async () => {
            service = await createService({ API_E2B_KEY: 'key' });
            setupSandboxMock();

            const result = await service.createSandboxWithRepo(defaultParams);

            expect(result.remoteCommands).toBeDefined();
            expect(typeof result.remoteCommands.grep).toBe('function');
            expect(typeof result.remoteCommands.read).toBe('function');
            expect(typeof result.remoteCommands.listDir).toBe('function');
            expect(typeof result.cleanup).toBe('function');
        });

        it('should use template ID when API_E2B_TEMPLATE_ID is configured', async () => {
            service = await createService({
                API_E2B_KEY: 'key',
                API_E2B_TEMPLATE_ID: 'kodus-sandbox',
            });
            const { mockRun, Sandbox } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            expect(Sandbox.create).toHaveBeenCalledWith('kodus-sandbox', {
                timeoutMs: 10 * 60 * 1000,
                apiKey: 'key',
            });

            // Should NOT run apt-get install when using template
            const commands = mockRun.mock.calls.map((c: any[]) => c[0]);
            expect(
                commands.some((cmd: string) => cmd.includes('apt-get')),
            ).toBe(false);
        });

        it('should install git, ripgrep and shadowsocks-libev via apt-get when no template is configured', async () => {
            service = await createService({ API_E2B_KEY: 'key' });
            const { mockRun } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            const firstCall = mockRun.mock.calls[0];
            expect(firstCall[0]).toContain('git');
            expect(firstCall[0]).toContain('ripgrep');
            expect(firstCall[0]).toContain('shadowsocks-libev');
        });

        it('should fallback to default sandbox when template creation fails', async () => {
            service = await createService({
                API_E2B_KEY: 'key',
                API_E2B_TEMPLATE_ID: 'bad-template',
            });

            const mockRun = jest
                .fn()
                .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
            const mockKill = jest.fn().mockResolvedValue(undefined);
            const fallbackSandbox = {
                commands: { run: mockRun },
                kill: mockKill,
            };

            const { Sandbox } = require('e2b');
            Sandbox.create
                .mockRejectedValueOnce(new Error('Template not found'))
                .mockResolvedValueOnce(fallbackSandbox);

            const result = await service.createSandboxWithRepo(defaultParams);

            // Should have tried template first, then fallback
            expect(Sandbox.create).toHaveBeenCalledTimes(2);
            expect(Sandbox.create).toHaveBeenNthCalledWith(1, 'bad-template', {
                timeoutMs: 10 * 60 * 1000,
                apiKey: 'key',
            });
            expect(Sandbox.create).toHaveBeenNthCalledWith(2, {
                timeoutMs: 10 * 60 * 1000,
                apiKey: 'key',
            });

            // Should install deps via apt-get since fallback doesn't have template
            const commands = mockRun.mock.calls.map((c: any[]) => c[0]);
            expect(
                commands.some((cmd: string) => cmd.includes('apt-get')),
            ).toBe(true);

            expect(result.remoteCommands).toBeDefined();
        });

        it('should use branch refspec when prNumber is undefined (CLI mode)', async () => {
            service = await createService({ API_E2B_KEY: 'key' });
            const { mockRun } = setupSandboxMock();

            await service.createSandboxWithRepo({
                ...defaultParams,
                prNumber: undefined,
                branch: 'feat/my-feature',
            });

            const gitCall = mockRun.mock.calls[1];
            const gitCommand = gitCall[0];

            expect(gitCommand).toContain('refs/heads/feat/my-feature:cli-head');
            expect(gitCommand).toContain('git checkout cli-head');
            expect(gitCommand).not.toContain('pr-head');
        });
    });

    // ─── setupProxy ─────────────────────────────────────────────────────────

    describe('setupProxy()', () => {
        const defaultParams = {
            cloneUrl: 'https://github.com/org/repo.git',
            authToken: 'token',
            branch: 'main',
            prNumber: 42,
            platform: PlatformType.GITHUB,
        };

        const setupSandboxMock = () => {
            const mockKill = jest.fn().mockResolvedValue(undefined);
            const mockRun = jest
                .fn()
                .mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
            const mockSandbox = {
                commands: { run: mockRun },
                kill: mockKill,
            };

            const { Sandbox } = require('e2b');
            Sandbox.create.mockResolvedValue(mockSandbox);

            return { mockKill, mockRun, mockSandbox, Sandbox };
        };

        it('should start ss-local and configure git proxy when proxy env vars are set', async () => {
            service = await createService({
                API_E2B_KEY: 'key',
                E2B_PROXY_HOST: '10.0.0.1',
                E2B_PROXY_PORT: '9999',
                E2B_PROXY_PASSWORD: 'secret',
                E2B_PROXY_METHOD: 'chacha20-ietf-poly1305',
            });
            const { mockRun } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            // ss-local command
            const ssLocalCall = mockRun.mock.calls.find((c: any[]) =>
                c[0].includes('ss-local'),
            );
            expect(ssLocalCall).toBeDefined();
            expect(ssLocalCall[0]).toContain('-s 10.0.0.1');
            expect(ssLocalCall[0]).toContain('-p 9999');
            expect(ssLocalCall[0]).toContain('-l 1080');
            expect(ssLocalCall[0]).toContain('-m chacha20-ietf-poly1305');
            expect(ssLocalCall[1].envs.SS_PASSWORD).toBe('secret');
            expect(ssLocalCall[1].user).toBe('root');

            // git config proxy command
            const gitProxyCall = mockRun.mock.calls.find((c: any[]) =>
                c[0].includes('git config --global http.proxy'),
            );
            expect(gitProxyCall).toBeDefined();
            expect(gitProxyCall[0]).toContain('socks5://127.0.0.1:1080');
        });

        it('should use default port and method when not specified', async () => {
            service = await createService({
                API_E2B_KEY: 'key',
                E2B_PROXY_HOST: '10.0.0.1',
                E2B_PROXY_PASSWORD: 'secret',
            });
            const { mockRun } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            const ssLocalCall = mockRun.mock.calls.find((c: any[]) =>
                c[0].includes('ss-local'),
            );
            expect(ssLocalCall).toBeDefined();
            expect(ssLocalCall[0]).toContain('-p 8388');
            expect(ssLocalCall[0]).toContain('-m aes-256-gcm');
        });

        it('should skip proxy setup when E2B_PROXY_HOST is not set', async () => {
            service = await createService({ API_E2B_KEY: 'key' });
            const { mockRun } = setupSandboxMock();

            await service.createSandboxWithRepo(defaultParams);

            const commands = mockRun.mock.calls.map((c: any[]) => c[0]);
            expect(
                commands.some((cmd: string) => cmd.includes('ss-local')),
            ).toBe(false);
            expect(
                commands.some((cmd: string) => cmd.includes('http.proxy')),
            ).toBe(false);
        });

        it('should throw when E2B_PROXY_HOST is set but E2B_PROXY_PASSWORD is missing', async () => {
            service = await createService({
                API_E2B_KEY: 'key',
                E2B_PROXY_HOST: '10.0.0.1',
            });
            setupSandboxMock();

            await expect(
                service.createSandboxWithRepo(defaultParams),
            ).rejects.toThrow(
                'E2B_PROXY_PASSWORD is required when E2B_PROXY_HOST is set',
            );
        });
    });

    // ─── cleanup ────────────────────────────────────────────────────────────

    describe('cleanup()', () => {
        it('should call sandbox.kill()', async () => {
            service = await createService({ API_E2B_KEY: 'key' });

            const mockKill = jest.fn().mockResolvedValue(undefined);
            const { Sandbox } = require('e2b');
            Sandbox.create.mockResolvedValue({
                commands: {
                    run: jest
                        .fn()
                        .mockResolvedValue({ exitCode: 0, stdout: '' }),
                },
                kill: mockKill,
            });

            const { cleanup } = await service.createSandboxWithRepo({
                cloneUrl: 'https://github.com/org/repo.git',
                authToken: 'token',
                branch: 'main',
                prNumber: 1,
                platform: PlatformType.GITHUB,
            });

            await cleanup();

            expect(mockKill).toHaveBeenCalledTimes(1);
        });

        it('should swallow sandbox.kill() errors (logged internally)', async () => {
            service = await createService({ API_E2B_KEY: 'key' });

            const mockKill = jest
                .fn()
                .mockRejectedValue(new Error('kill failed'));
            const { Sandbox } = require('e2b');
            Sandbox.create.mockResolvedValue({
                commands: {
                    run: jest
                        .fn()
                        .mockResolvedValue({ exitCode: 0, stdout: '' }),
                },
                kill: mockKill,
            });

            const { cleanup } = await service.createSandboxWithRepo({
                cloneUrl: 'https://github.com/org/repo.git',
                authToken: 'token',
                branch: 'main',
                prNumber: 1,
                platform: PlatformType.GITHUB,
            });

            // Should NOT throw — cleanup wraps kill() in try/catch
            await expect(cleanup()).resolves.toBeUndefined();
        });
    });

    // ─── buildRemoteCommands ────────────────────────────────────────────────

    describe('buildRemoteCommands()', () => {
        let mockRun: jest.Mock;
        let remoteCommands: any;

        beforeEach(async () => {
            service = await createService({ API_E2B_KEY: 'key' });

            mockRun = jest
                .fn()
                .mockResolvedValue({ exitCode: 0, stdout: 'output' });
            const { Sandbox } = require('e2b');
            Sandbox.create.mockResolvedValue({
                commands: { run: mockRun },
                kill: jest.fn().mockResolvedValue(undefined),
            });

            const result = await service.createSandboxWithRepo({
                cloneUrl: 'https://github.com/org/repo.git',
                authToken: 'token',
                branch: 'main',
                prNumber: 1,
                platform: PlatformType.GITHUB,
            });
            remoteCommands = result.remoteCommands;

            // Clear calls from sandbox setup (apt-get, git commands)
            mockRun.mockClear();
        });

        describe('grep()', () => {
            it('should run rg with pattern and resolved path', async () => {
                const result = await remoteCommands.grep(
                    'myFunc\\(',
                    'src/index.ts',
                );

                expect(mockRun).toHaveBeenCalledWith(
                    "cd /home/user/repo && rg --no-heading -n 'myFunc\\(' 'src/index.ts'",
                    { timeoutMs: 30_000 },
                );
                expect(result).toBe('output');
            });

            it('should append --glob when glob argument is provided', async () => {
                await remoteCommands.grep('pattern', 'src', '*.ts');

                expect(mockRun).toHaveBeenCalledWith(
                    "cd /home/user/repo && rg --no-heading -n 'pattern' 'src' --glob '*.ts'",
                    { timeoutMs: 30_000 },
                );
            });

            it('should reject absolute paths', async () => {
                await expect(
                    remoteCommands.grep('pattern', '/tmp/other'),
                ).rejects.toThrow('Absolute paths are not allowed');
            });
        });

        describe('read()', () => {
            it('should run sed with start and end lines', async () => {
                const result = await remoteCommands.read('src/app.ts', 10, 20);

                expect(mockRun).toHaveBeenCalledWith(
                    "sed -n '10,20p' '/home/user/repo/src/app.ts'",
                    { timeoutMs: 10_000 },
                );
                expect(result).toBe('output');
            });
        });

        describe('listDir()', () => {
            it('should run find with maxDepth', async () => {
                const result = await remoteCommands.listDir('src', 3);

                expect(mockRun).toHaveBeenCalledWith(
                    "find '/home/user/repo/src' -maxdepth 3 -type f",
                    { timeoutMs: 30_000 },
                );
                expect(result).toBe('output');
            });
        });
    });

    // ─── resolvePath ────────────────────────────────────────────────────────

    describe('resolvePath()', () => {
        beforeEach(async () => {
            service = await createService({ API_E2B_KEY: 'key' });
        });

        const resolvePath = (path: string) =>
            (service as any).resolvePath(path);

        it('should prefix relative paths with REPO_DIR', () => {
            expect(resolvePath('src/index.ts')).toBe(
                '/home/user/repo/src/index.ts',
            );
        });

        it('should reject absolute paths', () => {
            expect(() => resolvePath('/tmp/somefile')).toThrow(
                'Absolute paths are not allowed',
            );
        });

        it('should reject path traversal with ".."', () => {
            expect(() => resolvePath('../etc/passwd')).toThrow(
                'Path traversal using ".." is not allowed',
            );
        });
    });
});
