import type {
    CliToolConfig,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

import { cliSandboxIdentity } from './cli-command';
import {
    customAgentMatchesFiles,
    provisionCustomAgentClis,
} from './custom-agent-cli.provisioner';

const cli = (overrides: Partial<CliToolConfig> = {}): CliToolConfig => ({
    name: 'lintkit',
    install: 'npm install -g lintkit@2.4.1',
    binary: 'lintkit',
    allowedPrefixes: ['check'],
    usage: '',
    runsProjectCode: false,
    allowedDomains: ['api.lintkit.example'],
    ...overrides,
});

const agent = (overrides: Partial<CustomAgentConfig> = {}): CustomAgentConfig =>
    ({
        id: 'agent-1',
        name: 'Ledger reviewer',
        enabled: true,
        instructions: '',
        scope: { include: ['src/ledger/**'] },
        tools: { cli: [cli()] },
        presentation: {
            tag: { color: '#3366ff' },
            format: 'inline',
            suggestedFix: 'never',
            mode: 'shadow',
        },
        ...overrides,
    }) as CustomAgentConfig;

const sandbox = (
    type: SandboxInstance['type'],
    handler?: (script: string) => {
        stdout?: string;
        stderr?: string;
        exitCode: number;
    },
) => {
    const run = jest.fn(async (script: string) => {
        if (handler) {
            const r = handler(script);
            return {
                stdout: r.stdout ?? '',
                stderr: r.stderr ?? '',
                exitCode: r.exitCode,
            };
        }
        // Install scripts print the binary marker; fence scripts succeed.
        const match = /useradd .* '(kcli[a-f0-9]+)'/.exec(script);
        return {
            stdout: match
                ? `added 1 package\nKODUS_CLI_BINARY=/home/${match[1]}/.local/bin/lintkit\n`
                : '',
            stderr: '',
            exitCode: 0,
        };
    });
    return { type, run } as unknown as SandboxInstance & { run: typeof run };
};

const isInstall = (s: string) => s.includes('useradd');
const isFence = (s: string) => s.includes('iptables');

describe('customAgentMatchesFiles', () => {
    it('runs only enabled agents with a changed file in scope', () => {
        expect(customAgentMatchesFiles(agent(), ['src/ledger/post.ts'])).toBe(
            true,
        );
        expect(customAgentMatchesFiles(agent(), ['src/ui/button.tsx'])).toBe(
            false,
        );
        expect(
            customAgentMatchesFiles(agent({ enabled: false }), [
                'src/ledger/a.ts',
            ]),
        ).toBe(false);
        expect(
            customAgentMatchesFiles(
                agent({
                    scope: { include: ['src/**'], exclude: ['**/*.spec.ts'] },
                }),
                ['src/ledger/a.spec.ts'],
            ),
        ).toBe(false);
        expect(
            customAgentMatchesFiles(agent({ scope: {} }), ['anything.md']),
        ).toBe(true);
    });
});

describe('provisionCustomAgentClis', () => {
    it('never installs on the local sandbox', async () => {
        const sb = sandbox('local');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result).toEqual({ byAgentId: {}, warnings: [] });
        expect(sb.run).not.toHaveBeenCalled();
    });

    it('skips agents whose scope the change does not touch', async () => {
        const sb = sandbox('e2b');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['docs/readme.md'],
        });
        expect(result.byAgentId).toEqual({});
        expect(sb.run).not.toHaveBeenCalled();
    });

    it('installs, fences and returns the CLI with its own user and binary', async () => {
        const sb = sandbox('e2b');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        const identity = cliSandboxIdentity('agent-1', 'lintkit');
        expect(result.warnings).toEqual([]);
        expect(result.byAgentId['agent-1']).toEqual([
            expect.objectContaining({
                identity,
                binaryPath: `${identity.home}/.local/bin/lintkit`,
            }),
        ]);
        const scripts = sb.run.mock.calls.map(([s]) => s);
        expect(scripts.findIndex(isInstall)).toBeLessThan(
            scripts.findIndex(isFence),
        );
    });

    it('refuses an unpinned install without touching the sandbox', async () => {
        const sb = sandbox('e2b');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [
                agent({
                    tools: { cli: [cli({ install: 'npm i -g lintkit' })] },
                }),
            ],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result.byAgentId).toEqual({});
        expect(result.warnings).toEqual([
            expect.objectContaining({
                kind: 'CLI_INSTALL_FAILED',
                detail: expect.stringContaining('pin'),
            }),
        ]);
        expect(sb.run).not.toHaveBeenCalled();
    });

    it('reports a failed install and leaves the agent without that CLI', async () => {
        const sb = sandbox('e2b', (s) =>
            isInstall(s)
                ? { exitCode: 1, stderr: 'E404 lintkit@2.4.1 not found' }
                : { exitCode: 0 },
        );
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result.byAgentId).toEqual({});
        expect(result.warnings).toEqual([
            expect.objectContaining({
                kind: 'CLI_INSTALL_FAILED',
                agentName: 'Ledger reviewer',
            }),
        ]);
    });

    it('does not believe a binary path the install output made up', async () => {
        const sb = sandbox('e2b', (s) =>
            isInstall(s)
                ? { exitCode: 0, stdout: 'KODUS_CLI_BINARY=/usr/bin/bash\n' }
                : { exitCode: 0 },
        );
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result.byAgentId).toEqual({});
        expect(result.warnings[0].kind).toBe('CLI_INSTALL_FAILED');
    });

    it('fails closed when the network fence cannot be applied', async () => {
        const sb = sandbox('e2b', (s) => {
            if (isFence(s))
                return { exitCode: 1, stderr: 'iptables: not found' };
            const match = /useradd .* '(kcli[a-f0-9]+)'/.exec(s);
            return {
                exitCode: 0,
                stdout: `KODUS_CLI_BINARY=/home/${match?.[1]}/.local/bin/lintkit`,
            };
        });
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result.byAgentId).toEqual({});
        expect(result.warnings).toEqual([
            expect.objectContaining({
                kind: 'CLI_INSTALL_FAILED',
                detail: expect.stringContaining('network'),
            }),
        ]);
    });

    it('refuses a wildcard domain or a reserved secret name up front', async () => {
        const sb = sandbox('e2b');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [
                agent({
                    tools: {
                        cli: [
                            cli({ allowedDomains: ['*.lintkit.example'] }),
                            cli({
                                name: 'other',
                                secrets: [
                                    { env: 'LD_PRELOAD', ciphertext: 'x' },
                                ],
                            }),
                        ],
                    },
                }),
            ],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result.warnings).toHaveLength(2);
        expect(sb.run).not.toHaveBeenCalled();
    });
});
