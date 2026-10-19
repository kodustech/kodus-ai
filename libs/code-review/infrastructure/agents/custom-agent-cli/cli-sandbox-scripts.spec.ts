import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    buildInstallScript,
    buildNetworkScript,
    buildRunCommand,
    CLI_BINARY_MARKER,
    cliSandboxIdentity,
} from './cli-command';

/**
 * Runs the generated sandbox scripts under bash with the system tools they
 * call (sudo, getent, nft, id, pkill) replaced by stubs that log their
 * arguments, so what the script does is checked, not only what it says.
 */
const withStubs = (
    stubs: Record<string, string>,
    run: (dir: string, log: () => string[]) => void,
) => {
    const dir = mkdtempSync(join(tmpdir(), 'kcli-stubs-'));
    const logFile = join(dir, 'calls.log');
    writeFileSync(logFile, '');
    const write = (name: string, body: string) => {
        const path = join(dir, name);
        writeFileSync(
            path,
            `#!/bin/bash\necho "${name} $*" >> '${logFile}'\n${body}\n`,
        );
        chmodSync(path, 0o755);
    };
    // sudo drops its own flags and runs the command through the stubs,
    // also when the script names it by absolute path (/usr/bin/env).
    write(
        'sudo',
        [
            'while [ "${1:-}" = "-n" ] || [ "${1:-}" = "-H" ] || [[ "${1:-}" == --preserve-env* ]]; do shift; done',
            'if [ "${1:-}" = "-u" ]; then shift 2; fi',
            'while [ "${1:-}" = "-H" ] || [[ "${1:-}" == --preserve-env* ]]; do shift; done',
            '[ "${1:-}" = "--" ] && shift',
            'cmd="$1"; shift',
            `stub='${dir}'/"$(basename "$cmd")"`,
            'if [ -x "$stub" ]; then "$stub" "$@"; else "$cmd" "$@"; fi',
        ].join('\n'),
    );
    write('nft', 'exit 0');
    write('sed', 'exit 0');
    write('tee', 'cat >/dev/null');
    write('id', 'echo 4242');
    write('pkill', 'exit 0');
    for (const [name, body] of Object.entries(stubs)) write(name, body);
    try {
        run(dir, () =>
            readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

const runBash = (dir: string, script: string) =>
    spawnSync('bash', ['-c', script], {
        env: { PATH: `${dir}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
    });

describe('network fence script', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');
    const fence = buildNetworkScript({
        identity,
        domains: ['api.lintkit.example'],
    });

    it.each([
        '127.0.0.1',
        '10.1.2.3',
        '172.16.0.9',
        '172.31.255.1',
        '192.168.1.1',
        '169.254.169.254',
        '100.64.0.1',
        '0.0.0.0',
        '224.0.0.1',
        '198.18.0.1',
    ])('refuses an allowed domain that resolves to %s', (ip) => {
        withStubs(
            { getent: `echo "${ip}       STREAM api.lintkit.example"` },
            (dir, log) => {
                const result = runBash(dir, fence);
                expect(result.status).not.toBe(0);
                expect(result.stderr).toContain('non-public');
                expect(log().join('\n')).not.toContain(
                    `ct original ip daddr ${ip} accept`,
                );
            },
        );
    });

    it.each(['93.184.216.34', '172.32.0.1', '100.128.0.1', '8.8.8.8'])(
        'accepts a public address %s',
        (ip) => {
            withStubs(
                { getent: `echo "${ip}       STREAM api.lintkit.example"` },
                (dir, log) => {
                    const result = runBash(dir, fence);
                    expect(result.stderr).toBe('');
                    expect(result.status).toBe(0);
                    expect(log().join('\n')).toContain(
                        `ct original ip daddr ${ip} accept`,
                    );
                },
            );
        },
    );

    it('fences the CLI user with nft, which E2B supports, not the iptables owner match it lacks', () => {
        withStubs(
            { getent: 'echo "93.184.216.34  STREAM api.lintkit.example"' },
            (dir, log) => {
                expect(runBash(dir, fence).status).toBe(0);
                const calls = log().join('\n');
                expect(calls).not.toContain('iptables');
                expect(calls).toContain(
                    `nft add rule inet kodus_cli out meta skuid 4242 jump ${identity.chain}`,
                );
                expect(calls).toContain(
                    `nft add rule inet kodus_cli ${identity.chain} meta nfproto ipv6 reject`,
                );
            },
        );
    });

    it('rejects non-public ranges in the chain before any accept', () => {
        withStubs(
            { getent: 'echo "93.184.216.34  STREAM api.lintkit.example"' },
            (dir, log) => {
                expect(runBash(dir, fence).status).toBe(0);
                const rules = log().filter((line) =>
                    line.startsWith(
                        `nft add rule inet kodus_cli ${identity.chain} `,
                    ),
                );
                const firstAccept = rules.findIndex((r) =>
                    r.endsWith(' accept'),
                );
                const privateRejects = rules
                    .slice(0, firstAccept)
                    .filter((r) => r.endsWith(' reject'));
                for (const cidr of [
                    '10.0.0.0/8',
                    '127.0.0.0/8',
                    '169.254.0.0/16',
                    '172.16.0.0/12',
                    '192.168.0.0/16',
                ]) {
                    expect(privateRejects.join('\n')).toContain(cidr);
                }
            },
        );
    });
});

describe('runCli command', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');
    const command = buildRunCommand({
        identity,
        binaryPath: `${identity.home}/.local/bin/lintkit`,
        args: ['check'],
        secretEnvNames: [],
        timeoutSec: 5,
    });

    it('kills every process of the CLI user after the call and keeps its exit code', () => {
        withStubs({ env: 'exit 7' }, (dir, log) => {
            const result = runBash(dir, command);
            expect(result.status).toBe(7);
            const calls = log();
            const envCall = calls.findIndex((c) => c.startsWith('env '));
            const killCall = calls.findIndex(
                (c) => c === `pkill -KILL -u ${identity.user}`,
            );
            expect(envCall).toBeGreaterThanOrEqual(0);
            expect(killCall).toBeGreaterThan(envCall);
        });
    });
});

describe('runCli command with secrets', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');
    const command = buildRunCommand({
        identity,
        binaryPath: `${identity.home}/.local/bin/lintkit`,
        args: ['check'],
        secretEnvNames: ['LINTKIT_TOKEN'],
        timeoutSec: 5,
    });

    // The sandbox starts the command in a shell of the review user with the
    // secret in its env; that shell must be replaced by sudo, not wait for
    // the CLI while other review-user commands could read its /proc env.
    it('replaces the review user shell holding the secret with sudo', () => {
        withStubs(
            {
                sh: 'echo "sh-parent $PPID"; exec /bin/sh "$@"',
                env: 'echo "cli-token $LINTKIT_TOKEN"',
            },
            (dir) => {
                const result = runBash(
                    dir,
                    `export LINTKIT_TOKEN=s3cret; echo "outer $$"; ${command}`,
                );
                const outer = /outer (\d+)/.exec(result.stdout)?.[1];
                const parent = /sh-parent (\d+)/.exec(result.stdout)?.[1];
                expect(outer).toBeDefined();
                expect(parent).toBe(outer);
                expect(result.stdout).toContain('cli-token s3cret');
                expect(result.status).toBe(0);
            },
        );
    });
});

describe('scripts on a sandbox shell whose exit hook fails (E2B)', () => {
    // E2B runs commands in a bash whose exit hook returns non-zero; under
    // `set -e` that turned the script's own `exit 0` into exit 1.
    const onE2bShell = (script: string) => `trap false EXIT\n${script}`;
    const identity = cliSandboxIdentity('agent-1', 'semver');

    it('an install that found its binary exits 0', () => {
        withStubs(
            {
                chmod: 'exit 0',
                useradd: 'exit 0',
                env: 'exit 0',
                test: 'exit 0',
            },
            (dir) => {
                const result = runBash(
                    dir,
                    onE2bShell(
                        buildInstallScript({
                            identity,
                            argv: ['npm', 'i', '-g', 'semver@7.6.3'],
                            binary: 'semver',
                        }),
                    ),
                );
                expect(result.stdout).toContain(CLI_BINARY_MARKER);
                expect(result.status).toBe(0);
            },
        );
    });

    it('an install whose binary is missing still exits with its own code', () => {
        withStubs(
            {
                chmod: 'exit 0',
                useradd: 'exit 0',
                env: 'exit 0',
                test: 'exit 1',
            },
            (dir) => {
                const result = runBash(
                    dir,
                    onE2bShell(
                        buildInstallScript({
                            identity,
                            argv: ['npm', 'i', '-g', 'semver@7.6.3'],
                            binary: 'semver',
                        }),
                    ),
                );
                expect(result.status).toBe(3);
            },
        );
    });

    it('a fence with no domains exits 0', () => {
        withStubs({}, (dir) => {
            const result = runBash(
                dir,
                onE2bShell(buildNetworkScript({ identity, domains: [] })),
            );
            expect(result.status).toBe(0);
        });
    });
});
