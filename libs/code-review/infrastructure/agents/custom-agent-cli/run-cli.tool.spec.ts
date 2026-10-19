import type { CliToolConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { cliSandboxIdentity } from './cli-command';
import type { InstalledCustomAgentCli } from './custom-agent-cli.provisioner';
import { buildRunCliTool, RUN_CLI_TOOL_NAME } from './run-cli.tool';

const SECRET = 'lk_live_9f8e7d6c5b4a3210';
const CIPHERTEXT = 'cafe:0123abcd';
const decrypt = jest.fn((c: string) => (c === CIPHERTEXT ? SECRET : ''));

const cliConfig = (overrides: Partial<CliToolConfig> = {}): CliToolConfig => ({
    name: 'lintkit',
    install: 'npm install -g lintkit@2.4.1',
    binary: 'lintkit',
    allowedPrefixes: ['check --format json'],
    usage: 'Run `check --format json <path>` on changed files.',
    runsProjectCode: false,
    allowedDomains: ['api.lintkit.example'],
    secrets: [{ env: 'LINTKIT_TOKEN', ciphertext: CIPHERTEXT }],
    ...overrides,
});

const installed = (cli = cliConfig()): InstalledCustomAgentCli => {
    const identity = cliSandboxIdentity('agent-1', cli.name);
    return {
        agentId: 'agent-1',
        agentName: 'Ledger reviewer',
        cli,
        identity,
        binaryPath: `${identity.home}/.local/bin/${cli.binary}`,
    };
};

/** A sandbox whose CLI echoes its env back, as a careless CLI would. */
const sandbox = (type: SandboxInstance['type'] = 'e2b') => {
    const run = jest.fn(
        async (_command: string, opts?: { envs?: Record<string, string> }) => ({
            stdout: `token is ${opts?.envs?.LINTKIT_TOKEN ?? 'none'}\nb64 ${Buffer.from(
                opts?.envs?.LINTKIT_TOKEN ?? 'none',
            ).toString('base64')}`,
            stderr: '',
            exitCode: 0,
        }),
    );
    return {
        type,
        run,
        repoDir: '/home/user/repo',
        sandboxId: 'sbx',
        remoteCommands: {} as any,
        cleanup: jest.fn(),
        readFile: jest.fn(),
        writeFile: jest.fn(),
    } as unknown as SandboxInstance & { run: typeof run };
};

const toolOf = (deps: Parameters<typeof buildRunCliTool>[0]) =>
    buildRunCliTool(deps)[RUN_CLI_TOOL_NAME];

beforeEach(() => decrypt.mockClear());

describe('buildRunCliTool', () => {
    it('is absent on the local sandbox', () => {
        expect(
            buildRunCliTool({
                sandbox: sandbox('local'),
                installed: [installed()],
                decrypt,
            }),
        ).toEqual({});
    });

    it('is absent without a sandbox or without an installed CLI', () => {
        expect(
            buildRunCliTool({
                sandbox: undefined,
                installed: [installed()],
                decrypt,
            }),
        ).toEqual({});
        expect(
            buildRunCliTool({ sandbox: sandbox(), installed: [], decrypt }),
        ).toEqual({});
    });

    it('describes usage and prefixes without any secret', () => {
        const tool = toolOf({
            sandbox: sandbox(),
            installed: [installed()],
            decrypt,
        });
        expect(tool.description).toContain('check --format json');
        expect(tool.description).toContain('on changed files');
        expect(tool.description).not.toContain(SECRET);
        expect(tool.description).not.toContain(CIPHERTEXT);
        expect(decrypt).not.toHaveBeenCalled();
    });
});

describe('runCli execute', () => {
    it('runs the call as root, never through the review user', async () => {
        const sb = sandbox();
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json', 'src/a.ts'],
        });
        expect(sb.run).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ asRoot: true }),
        );
    });

    it.each([
        [['check', '--format', 'json', 'printenv']],
        [['check', '--format', 'json', '/proc/self/environ']],
        [['check', '--format', 'json', '$LINTKIT_TOKEN']],
        [['check', '--format', 'json', '--x=${LINTKIT_TOKEN}']],
    ])(
        'refuses %j on a CLI with secrets, without decrypting or running',
        async (args) => {
            const sb = sandbox();
            const tool = toolOf({
                sandbox: sb,
                installed: [installed()],
                decrypt,
            });
            const out = await tool.execute({ cli: 'lintkit', args });
            expect(out).toMatch(/^Error: refused/);
            expect(sb.run).not.toHaveBeenCalled();
            expect(decrypt).not.toHaveBeenCalled();
        },
    );

    it('masks hex and JSON-escaped spellings of a secret', async () => {
        const sb = sandbox();
        sb.run.mockResolvedValueOnce({
            stdout: `hex ${Buffer.from(SECRET).toString('hex').toUpperCase()} json ${JSON.stringify(SECRET)}`,
            stderr: '',
            exitCode: 0,
        });
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json', 'src/a.ts'],
        });
        expect(out).not.toContain(SECRET);
        expect(out).not.toContain(
            Buffer.from(SECRET).toString('hex').toUpperCase(),
        );
    });

    it('refuses a CLI the agent does not have', async () => {
        const sb = sandbox();
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        const out = await tool.execute({ cli: 'other', args: ['check'] });
        expect(out).toMatch(/^Error: unknown CLI/);
        expect(sb.run).not.toHaveBeenCalled();
    });

    it('refuses argv outside the allowed prefixes, without running anything', async () => {
        const sb = sandbox();
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['auth', 'export-token'],
        });
        expect(out).toMatch(/not allowed/);
        expect(sb.run).not.toHaveBeenCalled();
        expect(decrypt).not.toHaveBeenCalled();
    });

    it('drops the binary when the agent passes it as the first argument', async () => {
        const sb = sandbox();
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['lintkit', 'check', '--format', 'json', 'src/a.ts'],
        });
        expect(out).not.toMatch(/not allowed/);
        const [command] = sb.run.mock.calls[0];
        expect(command).toContain(
            `${installed().binaryPath}' 'check' '--format' 'json' 'src/a.ts'`,
        );
    });

    it('runs argv as the CLI user with secrets only in the process env', async () => {
        const sb = sandbox();
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json', 'src/$(id).ts'],
        });
        const [command, opts] = sb.run.mock.calls[0];
        expect(command).not.toContain(SECRET);
        expect(command).toContain("'src/$(id).ts'");
        expect(command).toContain('--preserve-env=LINTKIT_TOKEN');
        expect(command).toContain(installed().binaryPath);
        expect(opts?.envs).toEqual({ LINTKIT_TOKEN: SECRET });
    });

    it('masks the secret, plain and base64, in what the agent reads back', async () => {
        const tool = toolOf({
            sandbox: sandbox(),
            installed: [installed()],
            decrypt,
        });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json'],
        });
        expect(out).not.toContain(SECRET);
        expect(out).not.toContain(
            Buffer.from(SECRET).toString('base64').replace(/=+$/, ''),
        );
        expect(out).toContain('token is ***');
        expect(out).toContain('[exit code 0]');
    });

    it('masks the secret in errors the sandbox throws', async () => {
        const sb = sandbox();
        sb.run.mockRejectedValueOnce(
            Object.assign(new Error('exit 2'), {
                stdout: '',
                stderr: `bad token ${SECRET}`,
                exitCode: 2,
            }),
        );
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json'],
        });
        expect(out).not.toContain(SECRET);
        expect(out).toContain('[exit code 2]');
    });

    it('gives a CLI that runs project code no secret at all', async () => {
        const sb = sandbox();
        const tool = toolOf({
            sandbox: sb,
            installed: [installed(cliConfig({ runsProjectCode: true }))],
            decrypt,
        });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json'],
        });
        const [command, opts] = sb.run.mock.calls[0];
        expect(opts?.envs).toBeUndefined();
        expect(command).not.toContain('--preserve-env');
        expect(decrypt).not.toHaveBeenCalled();
        expect(out).toContain('token is none');
    });

    it('does not run when a secret cannot be decrypted', async () => {
        const sb = sandbox();
        const tool = toolOf({
            sandbox: sb,
            installed: [
                installed(
                    cliConfig({
                        secrets: [
                            { env: 'LINTKIT_TOKEN', ciphertext: '••••••••' },
                        ],
                    }),
                ),
            ],
            decrypt,
        });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json'],
        });
        expect(out).toMatch(/not available/);
        expect(sb.run).not.toHaveBeenCalled();
    });

    it('caps long output', async () => {
        const sb = sandbox();
        sb.run.mockResolvedValueOnce({
            stdout: 'x'.repeat(50_000),
            stderr: '',
            exitCode: 0,
        });
        const tool = toolOf({ sandbox: sb, installed: [installed()], decrypt });
        const out = await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json'],
        });
        expect(out.length).toBeLessThan(20_100);
        expect(out).toContain('truncated');
    });

    it('uses the configured timeout for the process and the sandbox call', async () => {
        const sb = sandbox();
        const tool = toolOf({
            sandbox: sb,
            installed: [installed(cliConfig({ timeoutSec: 30 }))],
            decrypt,
        });
        await tool.execute({
            cli: 'lintkit',
            args: ['check', '--format', 'json'],
        });
        const [command, opts] = sb.run.mock.calls[0];
        expect(command).toContain('/usr/bin/timeout -k 5 30 ');
        expect((opts as { timeoutMs?: number })?.timeoutMs).toBe(45_000);
    });
});
