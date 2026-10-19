import type {
    CliToolConfig,
    CustomAgentConfig,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import type {
    SandboxInstance,
    SandboxRunOptions,
} from '@libs/sandbox/domain/contracts/sandbox.provider';
import { PRIVILEGES_DROPPED_MARKER } from '@libs/sandbox/infrastructure/providers/review-user-privileges';

const mockWarn = jest.fn();
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({
        log: jest.fn(),
        warn: (...args: unknown[]) => mockWarn(...args),
        error: jest.fn(),
        debug: jest.fn(),
    }),
}));

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
        },
        ...overrides,
    }) as CustomAgentConfig;

const isPrivilegeCheck = (s: string) => s.includes('gpasswd');

const sandbox = (
    type: SandboxInstance['type'],
    handler?: (script: string) => {
        stdout?: string;
        stderr?: string;
        exitCode: number;
    },
    lockdown: { atCreation?: boolean; now?: boolean } = {},
) => {
    const run = jest.fn(async (script: string, _opts?: SandboxRunOptions) => {
        if (isPrivilegeCheck(script)) {
            return lockdown.now === false
                ? {
                      stdout: '',
                      stderr: 'review user can still use sudo',
                      exitCode: 5,
                  }
                : {
                      stdout: `${PRIVILEGES_DROPPED_MARKER}\n`,
                      stderr: '',
                      exitCode: 0,
                  };
        }
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
    return {
        type,
        run,
        privilegesDropped: lockdown.atCreation ?? true,
    } as unknown as SandboxInstance & { run: typeof run };
};

const isInstall = (s: string) => s.includes('useradd');
const isFence = (s: string) => s.includes('inet kodus_cli');

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
        expect(result.byAgentId).toEqual({});
        expect(sb.run).not.toHaveBeenCalled();
    });

    it('says why the CLI is missing when the review has no isolated sandbox', async () => {
        for (const sb of [sandbox('local'), undefined]) {
            const result = await provisionCustomAgentClis({
                sandbox: sb,
                agents: [agent()],
                changedFiles: ['src/ledger/post.ts'],
            });
            expect(result.warnings).toHaveLength(1);
            expect(result.warnings[0].kind).toBe('CLI_INSTALL_FAILED');
            expect(result.warnings[0].detail).toContain(
                'needs the isolated (E2B) sandbox',
            );
        }
    });

    it('says why the CLI is missing on a Kodus CLI review, even on E2B', async () => {
        const sb = sandbox('e2b');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
            skipReason: 'not run on Kodus CLI reviews',
        });
        expect(sb.run).not.toHaveBeenCalled();
        expect(result.byAgentId).toEqual({});
        expect(result.warnings[0].detail).toContain(
            'not run on Kodus CLI reviews',
        );
    });

    it('stays silent without an isolated sandbox when no running agent has a CLI', async () => {
        const result = await provisionCustomAgentClis({
            sandbox: sandbox('local'),
            agents: [agent()],
            changedFiles: ['docs/readme.md'],
        });
        expect(result.warnings).toEqual([]);
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

    it('installs for an agent whose only file is an ignored one it names', async () => {
        const manifest = agent({ scope: { include: ['package.json'] } });
        const broad = agent({
            id: 'agent-2',
            name: 'Json reviewer',
            scope: { include: ['**/*.json'] },
        });
        const result = await provisionCustomAgentClis({
            sandbox: sandbox('e2b'),
            agents: [manifest, broad],
            changedFiles: ['docs/readme.md'],
            ignoredFiles: ['package.json'],
        });
        expect(Object.keys(result.byAgentId)).toEqual(['agent-1']);
    });

    it('installs the CLIs of a disabled agent asked for by `@kody -v`', async () => {
        const sb = sandbox('e2b');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent({ enabled: false })],
            changedFiles: ['src/ledger/post.ts'],
            onlyCustomAgent: 'ledger-reviewer',
        });
        expect(result.byAgentId['agent-1']).toHaveLength(1);
    });

    it('installs nothing for the other agents on a `@kody -v` run', async () => {
        const sb = sandbox('e2b');
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
            onlyCustomAgent: 'another-agent',
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

    it('runs every sandbox step as root, the lockdown check first', async () => {
        const sb = sandbox('e2b');
        await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        const calls = sb.run.mock.calls;
        expect(calls.length).toBeGreaterThanOrEqual(3);
        expect(isPrivilegeCheck(calls[0][0])).toBe(true);
        for (const [, opts] of calls) {
            expect(opts).toEqual(expect.objectContaining({ asRoot: true }));
        }
    });

    it('installs nothing in a sandbox not locked down at creation', async () => {
        const sb = sandbox('e2b', undefined, { atCreation: false });
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result.byAgentId).toEqual({});
        expect(result.warnings[0].detail).toContain('could not be locked down');
        expect(sb.run).not.toHaveBeenCalled();
    });

    it('installs nothing when the review user can become root again', async () => {
        const sb = sandbox('e2b', undefined, { now: false });
        const result = await provisionCustomAgentClis({
            sandbox: sb,
            agents: [agent()],
            changedFiles: ['src/ledger/post.ts'],
        });
        expect(result.byAgentId).toEqual({});
        expect(result.warnings[0].detail).toContain('could not be locked down');
        const scripts = sb.run.mock.calls.map(([s]) => s);
        expect(scripts.some(isInstall)).toBe(false);
    });

    it('refuses an unpinned install without touching the sandbox', async () => {
        const sb = sandbox('e2b');
        mockWarn.mockClear();
        const result = await provisionCustomAgentClis({
            logContext: { organizationId: 'org-1', prNumber: 7 },
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
        // A refusal before any install is logged too, with the review's ids.
        expect(mockWarn).toHaveBeenCalledWith(
            expect.objectContaining({
                metadata: expect.objectContaining({
                    organizationId: 'org-1',
                    prNumber: 7,
                    agentId: 'agent-1',
                    cli: 'lintkit',
                    reason: expect.stringContaining('pin'),
                }),
            }),
        );
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
            if (isFence(s)) return { exitCode: 1, stderr: 'nft: not found' };
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
