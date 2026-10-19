import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    mkdirSync,
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
    CLI_EGRESS_PROXY_DIR,
    cliSandboxIdentity,
} from './cli-command';
import { ROOT_SAFE_PATH_LINE } from '@libs/sandbox/infrastructure/providers/review-user-privileges';

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
    write('mktemp', `echo '${dir}/run-tmp'`);
    write('chown', 'exit 0');
    write('chmod', 'exit 0');
    write('rm', 'exit 0');
    write('find', 'exit 0');
    for (const [name, body] of Object.entries(stubs)) write(name, body);
    try {
        run(dir, () =>
            readFileSync(logFile, 'utf8').split('\n').filter(Boolean),
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

// The scripts pin a system-only PATH for root; the stubs live elsewhere.
const runBash = (dir: string, script: string) =>
    spawnSync('bash', ['-c', script.split(ROOT_SAFE_PATH_LINE).join(':')], {
        env: { PATH: `${dir}:/usr/bin:/bin` } as unknown as NodeJS.ProcessEnv,
        encoding: 'utf8',
    });

/**
 * The fence script, made runnable outside a sandbox: the proxy's home and
 * source path move to a temp dir and the real Node runs the proxy, so the
 * test proves the shipped source survives the shell quoting and starts.
 */
const runFence = (
    dir: string,
    identity: ReturnType<typeof cliSandboxIdentity>,
    domains: string[],
    wrap: (script: string) => string = (x) => x,
) => {
    const home = join(dir, 'proxy-home');
    mkdirSync(home, { recursive: true });
    const script = buildNetworkScript({ identity, domains })
        .split(identity.proxyHome)
        .join(home)
        .split(CLI_EGRESS_PROXY_DIR)
        .join(dir)
        .split('/usr/bin/node /usr/local/bin/node')
        .join(process.execPath);
    try {
        return runBash(dir, wrap(script));
    } finally {
        spawnSync('pkill', ['-f', join(dir, 'egress-proxy.js')]);
    }
};

const fenceStubs = (ip: string) => ({
    getent: `echo "${ip}       STREAM api.lintkit.example"`,
    useradd: 'exit 0',
    stat: 'echo 0',
    setsid: '"$@"',
});

describe('network fence script', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');
    const port = identity.proxyPort;

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
        withStubs(fenceStubs(ip), (dir, log) => {
            const result = runFence(dir, identity, ['api.lintkit.example']);
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('non-public');
            expect(log().join('\n')).not.toContain('redirect');
        });
    });

    it.each(['93.184.216.34', '172.32.0.1', '100.128.0.1', '8.8.8.8'])(
        'accepts a public address %s and starts the proxy',
        (ip) => {
            withStubs(fenceStubs(ip), (dir, log) => {
                const result = runFence(dir, identity, ['api.lintkit.example']);
                expect(result.stderr).toBe('');
                expect(result.status).toBe(0);
                expect(log().join('\n')).toContain(
                    `nft add rule ip kodus_cli_nat out meta skuid 4242 tcp dport 443 redirect to :${port}`,
                );
            });
        },
    );

    it('lets the CLI user reach only its proxy, by host name, not addresses', () => {
        withStubs(fenceStubs('93.184.216.34'), (dir, log) => {
            expect(
                runFence(dir, identity, ['api.lintkit.example']).status,
            ).toBe(0);
            const rules = log().filter((line) =>
                line.startsWith(
                    `nft add rule inet kodus_cli ${identity.chain} `,
                ),
            );
            expect(rules).toEqual([
                `nft add rule inet kodus_cli ${identity.chain} meta nfproto ipv6 reject`,
                `nft add rule inet kodus_cli ${identity.chain} ip daddr 127.0.0.1 tcp dport ${port} accept`,
                `nft add rule inet kodus_cli ${identity.chain} reject`,
            ]);
            const calls = log().join('\n');
            expect(calls).not.toContain('iptables');
            expect(calls).toContain(
                `nft add rule inet kodus_cli out meta skuid 4242 jump ${identity.chain}`,
            );
            expect(calls).toContain(
                `nft add rule inet kodus_cli out meta skuid 4242 jump ${identity.proxyChain}`,
            );
        });
    });

    it('lets the proxy user reach DNS and public HTTPS only', () => {
        withStubs(fenceStubs('93.184.216.34'), (dir, log) => {
            expect(
                runFence(dir, identity, ['api.lintkit.example']).status,
            ).toBe(0);
            const rules = log().filter((line) =>
                line.startsWith(
                    `nft add rule inet kodus_cli ${identity.proxyChain} `,
                ),
            );
            const nonPublic = rules.findIndex((r) =>
                r.includes('169.254.0.0/16'),
            );
            const https = rules.findIndex((r) =>
                r.endsWith('ct original proto-dst 443 accept'),
            );
            expect(nonPublic).toBeGreaterThanOrEqual(0);
            expect(https).toBeGreaterThan(nonPublic);
            expect(rules[rules.length - 1]).toMatch(/ reject$/);
            expect(rules.join('\n')).not.toContain('proto-dst 80 ');
        });
    });

    it('runs the proxy as its own user with the allowlist', () => {
        withStubs(fenceStubs('93.184.216.34'), (dir, log) => {
            expect(
                runFence(dir, identity, ['api.lintkit.example']).status,
            ).toBe(0);
            expect(
                log().some(
                    (c) =>
                        c.startsWith(`sudo -n -u ${identity.proxyUser} -- `) &&
                        c.includes('["api.lintkit.example"]') &&
                        c.includes(` ${port} `),
                ),
            ).toBe(true);
        });
    });

    it('fails when the proxy does not start', () => {
        withStubs(
            {
                ...fenceStubs('93.184.216.34'),
                setsid: 'exit 0',
                sleep: 'exit 0',
            },
            (dir) => {
                const result = runFence(dir, identity, ['api.lintkit.example']);
                expect(result.status).toBe(4);
                expect(result.stderr).toContain('egress proxy did not start');
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

describe('runCli command temp files', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');
    const command = buildRunCommand({
        identity,
        binaryPath: `${identity.home}/.local/bin/lintkit`,
        args: ['check'],
        secretEnvNames: ['LINTKIT_TOKEN'],
        timeoutSec: 5,
    });
    const tmp = `${identity.home}/.run-abc12345`;
    const stubs = {
        mktemp: `echo '${tmp}'`,
        chown: 'exit 0',
        chmod: 'exit 0',
        rm: 'exit 0',
        find: 'exit 0',
        env: 'exit 0',
    };

    it('gives the CLI a private temp directory and umask 077', () => {
        withStubs(stubs, (dir, log) => {
            expect(runBash(dir, command).status).toBe(0);
            const calls = log();
            expect(calls).toContain(`mktemp -d ${identity.home}/.run-XXXXXXXX`);
            expect(calls).toContain(`chown ${identity.user}: ${tmp}`);
            expect(calls).toContain(`chmod 700 ${tmp}`);
            const envCall = calls.find((c) => c.startsWith('env '));
            expect(envCall).toContain(
                `TMPDIR=${tmp} TMP=${tmp} TEMP=${tmp} /bin/sh -c umask 077; exec "$@" sh /usr/bin/timeout`,
            );
        });
    });

    it('removes what the CLI wrote once its processes are gone', () => {
        withStubs({ ...stubs, env: 'exit 9' }, (dir, log) => {
            expect(runBash(dir, command).status).toBe(9);
            const calls = log();
            const kill = calls.indexOf(`pkill -KILL -u ${identity.user}`);
            const rmTmp = calls.indexOf(`rm -rf ${tmp}`);
            const sweep = calls.findIndex(
                (c) =>
                    c.startsWith('find /tmp /var/tmp /dev/shm') &&
                    c.includes(`-user ${identity.user}`),
            );
            expect(kill).toBeGreaterThanOrEqual(0);
            expect(rmTmp).toBeGreaterThan(kill);
            expect(sweep).toBeGreaterThan(kill);
        });
    });

    it('does not run the CLI when its temp directory cannot be made private', () => {
        withStubs({ ...stubs, chown: 'exit 1' }, (dir, log) => {
            expect(runBash(dir, command).status).toBe(125);
            expect(log().some((c) => c.startsWith('env '))).toBe(false);
        });
    });
});

describe('install script', () => {
    const identity = cliSandboxIdentity('agent-1', 'semver');

    it('kills what the install left running as the CLI user', () => {
        withStubs(
            {
                chmod: 'exit 0',
                useradd: 'exit 0',
                env: 'exit 0',
                test: 'exit 0',
            },
            (dir, log) => {
                const result = runBash(
                    dir,
                    buildInstallScript({
                        identity,
                        argv: ['npm', 'i', '-g', 'semver@7.6.3'],
                        binary: 'semver',
                    }),
                );
                expect(result.status).toBe(0);
                const calls = log();
                const install = calls.findIndex((c) => c.startsWith('env '));
                const kill = calls.findIndex(
                    (c) => c === `pkill -KILL -u ${identity.user}`,
                );
                expect(install).toBeGreaterThanOrEqual(0);
                expect(kill).toBeGreaterThan(install);
            },
        );
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

    it('hands the secret to the CLI by name only', () => {
        withStubs({ env: 'echo "cli-token $LINTKIT_TOKEN"' }, (dir) => {
            const result = runBash(
                dir,
                `export LINTKIT_TOKEN=s3cret; ${command}`,
            );
            expect(result.stdout).toContain('cli-token s3cret');
            expect(result.status).toBe(0);
            expect(command).not.toContain('s3cret');
            expect(command).toContain('--preserve-env=LINTKIT_TOKEN');
        });
    });
});

/**
 * The review user has no sudo once the sandbox is set up: every script here
 * runs as root through the sandbox's root channel. sudo only ever appears to
 * step DOWN to a CLI user, and every script pins root's PATH.
 */
describe('scripts are written for the root channel', () => {
    const identity = cliSandboxIdentity('agent-1', 'lintkit');
    const scripts = {
        install: buildInstallScript({
            identity,
            argv: ['npm', 'i', '-g', 'lintkit@2.4.1'],
            binary: 'lintkit',
        }),
        fence: buildNetworkScript({
            identity,
            domains: ['api.lintkit.example'],
        }),
        run: buildRunCommand({
            identity,
            binaryPath: `${identity.home}/.local/bin/lintkit`,
            args: ['check'],
            secretEnvNames: ['LINTKIT_TOKEN'],
            timeoutSec: 5,
        }),
    };

    it.each(Object.entries(scripts))(
        '%s never elevates through sudo',
        (_name, script) => {
            const sudoCalls = script.match(/sudo [^\n]*/g) ?? [];
            for (const call of sudoCalls) {
                expect(call).toMatch(
                    new RegExp(
                        `^sudo -n -u '(${identity.user}|${identity.proxyUser})' `,
                    ),
                );
            }
            expect(script).not.toMatch(/exec sudo/);
        },
    );

    it.each(Object.entries(scripts))('%s pins root PATH', (_name, script) => {
        expect(script).toContain(ROOT_SAFE_PATH_LINE);
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
        withStubs(fenceStubs('93.184.216.34'), (dir) => {
            const result = runFence(dir, identity, [], onE2bShell);
            expect(result.status).toBe(0);
        });
    });
});
