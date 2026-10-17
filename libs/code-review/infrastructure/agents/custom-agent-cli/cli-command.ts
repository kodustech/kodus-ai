/**
 * Pure command building for custom agent CLIs (#2172).
 *
 * Everything that ends up in a sandbox shell line is built here, so the
 * security rules live in one place and are testable without a sandbox:
 *
 * - the agent's call is argv, never a shell string: every token is single
 *   quoted, so `;`, `$()`, `|` or globbing in an argument stay literal;
 * - argv must start with one of the CLI's allowed prefixes, compared token by
 *   token (`scan` does not allow `scanner`);
 * - each CLI runs as its own unprivileged user, from the absolute path its
 *   pinned install produced, under a timeout;
 * - secrets travel only in the process env (named here, never valued).
 */
import { createHash } from 'node:crypto';

import { CliToolConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { checkCliInstallCommand } from '@libs/core/infrastructure/config/types/general/cli-install';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';

export const CLI_OUTPUT_MAX_CHARS = 20_000;
export const CLI_DEFAULT_TIMEOUT_SEC = 120;
export const CLI_MAX_TIMEOUT_SEC = 600;
export const CLI_INSTALL_TIMEOUT_SEC = 300;
export const CLI_MAX_ARGS = 64;
export const CLI_MAX_ARG_LENGTH = 4_096;

/** Where the sandbox keeps the checkout the CLI reads. */
export const CLI_REPO_DIR = '/home/user/repo';

const NODE_INSTALLERS = new Set(['npm', 'pnpm', 'yarn']);
const PIP_INSTALLERS = new Set(['pip', 'pip3']);

/** Env names that would change how the CLI process itself loads or resolves,
 *  rather than carry a credential. */
const RESERVED_ENV = new Set([
    'PATH',
    'HOME',
    'USER',
    'SHELL',
    'IFS',
    'ENV',
    'BASH_ENV',
    'NODE_OPTIONS',
    'PYTHONPATH',
    'PYTHONSTARTUP',
]);

export function isReservedSecretEnv(name: string): boolean {
    return (
        RESERVED_ENV.has(name) ||
        name.startsWith('LD_') ||
        name.startsWith('DYLD_')
    );
}

export function isValidBinaryName(binary: string): boolean {
    return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(binary);
}

/** Plain host names only: no scheme, port, path or wildcard. */
export function isValidDomain(domain: string): boolean {
    return (
        domain.length <= 253 &&
        /^(?=.*[a-z])[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(
            domain,
        )
    );
}

export function tokenizePrefix(prefix: string): string[] {
    return prefix.trim().split(/\s+/).filter(Boolean);
}

/**
 * Whether argv starts with one of the allowed prefixes, token for token.
 * A prefix may spell the binary (or CLI name) first; it is ignored, since the
 * binary is never part of the agent's argv.
 */
export function matchesAllowedPrefix(
    args: readonly string[],
    cli: Pick<CliToolConfig, 'allowedPrefixes' | 'binary' | 'name'>,
): boolean {
    for (const raw of cli.allowedPrefixes ?? []) {
        let tokens = tokenizePrefix(raw);
        if (
            tokens.length > 0 &&
            (tokens[0] === cli.binary || tokens[0] === cli.name)
        ) {
            tokens = tokens.slice(1);
        }
        if (!tokens.length) continue;
        if (tokens.length > args.length) continue;
        if (tokens.every((token, i) => args[i] === token)) return true;
    }
    return false;
}

/** Returns why argv is unacceptable, or null when it is fine. */
export function validateCliArgs(args: unknown): string | null {
    if (!Array.isArray(args)) return 'args must be an array of strings';
    if (args.length === 0) return 'args must not be empty';
    if (args.length > CLI_MAX_ARGS) {
        return `at most ${CLI_MAX_ARGS} arguments are allowed`;
    }
    for (const arg of args) {
        if (typeof arg !== 'string') return 'every argument must be a string';
        if (arg.length > CLI_MAX_ARG_LENGTH) {
            return `an argument is longer than ${CLI_MAX_ARG_LENGTH} characters`;
        }
        if (arg.includes('\0')) return 'arguments must not contain NUL bytes';
    }
    return null;
}

export type CliInstallPlan =
    { ok: true; argv: string[] } | { ok: false; reason: string };

/**
 * Turn the configured install command into argv, refusing anything that is
 * not a single, pinned package-manager install. Every package the command
 * names must be pinned, not just one of them (`npm i a@1.2.3 b` is refused).
 * A CLI that runs project code installs without lifecycle scripts.
 */
export function planCliInstall(cli: CliToolConfig): CliInstallPlan {
    const check = checkCliInstallCommand(cli.install);
    if (check.ok === false) return { ok: false, reason: check.reason };
    const { argv, installer } = check;

    if (cli.runsProjectCode) {
        if (
            NODE_INSTALLERS.has(installer) &&
            !argv.includes('--ignore-scripts')
        ) {
            argv.push('--ignore-scripts');
        }
        if (
            PIP_INSTALLERS.has(installer) &&
            !argv.some((t) => t.startsWith('--only-binary'))
        ) {
            argv.push('--only-binary=:all:');
        }
    }

    return { ok: true, argv };
}

export interface CliSandboxIdentity {
    /** Unprivileged Linux user the CLI installs and runs as. */
    user: string;
    home: string;
    /** iptables chain holding this CLI's egress allowlist. */
    chain: string;
    /** Marker on the /etc/hosts lines pinned for this CLI. */
    tag: string;
}

/** One user per (agent, CLI): CLIs never share a home, env or egress rules. */
export function cliSandboxIdentity(
    agentId: string,
    cliName: string,
): CliSandboxIdentity {
    const key = createHash('sha256')
        .update(`${agentId}\0${cliName}`)
        .digest('hex')
        .slice(0, 12);
    const user = `kcli${key}`;
    return {
        user,
        home: `/home/${user}`,
        chain: `KCLI_${key}`,
        tag: `kodus-cli:${key}`,
    };
}

export function shellJoin(argv: readonly string[]): string {
    return argv.map(shSingleQuote).join(' ');
}

/** Directories a pinned install may leave the binary in, all inside the CLI
 *  user's own home: a binary of the base image is never what runs. */
export function cliBinaryCandidates(home: string): string[] {
    return [
        `${home}/.local/bin`,
        `${home}/node_modules/.bin`,
        `${home}/.yarn/bin`,
    ];
}

export const CLI_BINARY_MARKER = 'KODUS_CLI_BINARY=';

/**
 * Create the CLI user (idempotent, so a warm-resumed sandbox re-runs it) and
 * run the pinned install as that user, with every package manager pointed at
 * the user's home. Prints the resolved absolute binary path after the marker.
 * No secret exists in the sandbox at this point.
 */
export function buildInstallScript(params: {
    identity: CliSandboxIdentity;
    argv: readonly string[];
    binary: string;
}): string {
    const { identity, argv, binary } = params;
    const h = identity.home;
    const env = [
        `HOME=${h}`,
        `PATH=${h}/.local/bin:/usr/local/bin:/usr/bin:/bin`,
        `NPM_CONFIG_PREFIX=${h}/.local`,
        `PNPM_HOME=${h}/.local/bin`,
        'PIP_USER=1',
        'PIP_BREAK_SYSTEM_PACKAGES=1',
        `PIPX_HOME=${h}/.local/pipx`,
        `PIPX_BIN_DIR=${h}/.local/bin`,
        `UV_TOOL_DIR=${h}/.local/uv`,
        `UV_TOOL_BIN_DIR=${h}/.local/bin`,
        `GOPATH=${h}/go`,
        `GOBIN=${h}/.local/bin`,
        `GOCACHE=${h}/.cache/go`,
        `CARGO_HOME=${h}/.cargo`,
        `CARGO_INSTALL_ROOT=${h}/.local`,
    ];
    const candidates = cliBinaryCandidates(h).map(shSingleQuote).join(' ');
    return [
        'set -eu',
        // The review user's home holds the proxy config and the checkout: the
        // CLI user may traverse to the repo, never list or read the rest.
        'sudo -n chmod 711 /home/user 2>/dev/null || true',
        'sudo -n chmod 600 /home/user/config.json 2>/dev/null || true',
        `id -u ${shSingleQuote(identity.user)} >/dev/null 2>&1 || sudo -n useradd --create-home --home-dir ${shSingleQuote(h)} --shell /usr/sbin/nologin ${shSingleQuote(identity.user)}`,
        `sudo -n chmod 700 ${shSingleQuote(h)}`,
        `sudo -n -u ${shSingleQuote(identity.user)} -- /usr/bin/env -C ${shSingleQuote(h)} -i ${shellJoin(env)} /usr/bin/timeout -k 5 ${CLI_INSTALL_TIMEOUT_SEC} ${shellJoin(argv)}`,
        `for d in ${candidates}; do`,
        `  if sudo -n -u ${shSingleQuote(identity.user)} test -x "$d"/${shSingleQuote(binary)}; then echo "${CLI_BINARY_MARKER}$d/"${shSingleQuote(binary)}; exit 0; fi`,
        'done',
        `echo ${shSingleQuote(`binary ${binary} not found after install`)} >&2`,
        'exit 3',
    ].join('\n');
}

/**
 * Fence the CLI user's egress to its allowlist. Domains are resolved now and
 * pinned in /etc/hosts; the user's DNS, loopback and every other address are
 * rejected. Matching on the ORIGINAL destination (`--ctorigdst`) keeps the
 * rule right behind the transparent egress proxy, which rewrites the
 * destination to loopback before the filter table sees the packet.
 */
export function buildNetworkScript(params: {
    identity: CliSandboxIdentity;
    domains: readonly string[];
}): string {
    const { identity, domains } = params;
    const user = shSingleQuote(identity.user);
    const chain = shSingleQuote(identity.chain);
    const tag = identity.tag;
    const lines = [
        'set -eu',
        'IPT="sudo -n iptables -w"',
        'IPS=""',
        `sudo -n sed -i '/# ${tag}$/d' /etc/hosts`,
    ];
    for (const domain of domains) {
        const d = shSingleQuote(domain);
        lines.push(
            `R=$(getent ahostsv4 ${d} | awk '{print $1}' | sort -u)`,
            `[ -n "$R" ] || { echo ${shSingleQuote(`cannot resolve ${domain}`)} >&2; exit 4; }`,
            `for ip in $R; do echo "$ip ${domain} # ${tag}" | sudo -n tee -a /etc/hosts >/dev/null; IPS="$IPS $ip"; done`,
        );
    }
    lines.push(
        `$IPT -N ${chain} 2>/dev/null || $IPT -F ${chain}`,
        `for ip in $IPS; do $IPT -A ${chain} -m conntrack --ctorigdst "$ip" -j ACCEPT; done`,
        `$IPT -A ${chain} -j REJECT`,
        `UID_=$(id -u ${user})`,
        `$IPT -C OUTPUT -m owner --uid-owner "$UID_" -j ${chain} 2>/dev/null || $IPT -I OUTPUT 1 -m owner --uid-owner "$UID_" -j ${chain}`,
        'if [ -e /proc/net/if_inet6 ]; then',
        '  sudo -n ip6tables -w -C OUTPUT -m owner --uid-owner "$UID_" -j REJECT 2>/dev/null || sudo -n ip6tables -w -I OUTPUT 1 -m owner --uid-owner "$UID_" -j REJECT',
        'fi',
        `$IPT -C OUTPUT -m owner --uid-owner "$UID_" -j ${chain}`,
    );
    return lines.join('\n');
}

/**
 * The single line that runs one CLI call. Secrets are named in
 * `--preserve-env` and arrive through the sandbox process env, so their
 * values are never part of this string.
 */
export function buildRunCommand(params: {
    identity: CliSandboxIdentity;
    binaryPath: string;
    args: readonly string[];
    secretEnvNames: readonly string[];
    timeoutSec: number;
}): string {
    const { identity, binaryPath, args, secretEnvNames, timeoutSec } = params;
    const preserve = secretEnvNames.length
        ? ` --preserve-env=${secretEnvNames.join(',')}`
        : '';
    return `sudo -n -u ${shSingleQuote(identity.user)} -H${preserve} -- /usr/bin/env -C ${shSingleQuote(CLI_REPO_DIR)} /usr/bin/timeout -k 5 ${timeoutSec} ${shellJoin([binaryPath, ...args])}`;
}

export function resolveCliTimeoutSec(cli: Pick<CliToolConfig, 'timeoutSec'>) {
    const configured = cli.timeoutSec ?? CLI_DEFAULT_TIMEOUT_SEC;
    return Math.min(Math.max(1, configured), CLI_MAX_TIMEOUT_SEC);
}
