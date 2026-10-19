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

/** An allowed prefix as argv tokens, without a leading binary or CLI name. */
export function prefixTokens(
    raw: string,
    cli: Pick<CliToolConfig, 'binary' | 'name'>,
): string[] {
    const tokens = tokenizePrefix(raw);
    return tokens.length > 0 &&
        (tokens[0] === cli.binary || tokens[0] === cli.name)
        ? tokens.slice(1)
        : tokens;
}

/**
 * Models often send an allowed prefix as ONE argument ("check --format
 * json"). When an argument's words start an allowed prefix, it is split into
 * them; any other argument keeps its spaces (a file name may have them).
 */
export function normalizeCliArgs(
    args: readonly string[],
    cli: Pick<CliToolConfig, 'allowedPrefixes' | 'binary' | 'name'>,
): string[] {
    const prefixes = (cli.allowedPrefixes ?? []).map((raw) =>
        prefixTokens(raw, cli),
    );
    const out: string[] = [];
    for (const arg of args) {
        const words = tokenizePrefix(arg);
        const at = out.length;
        const startsAPrefix =
            words.length > 1 &&
            prefixes.some((tokens) =>
                words.every((word, i) => tokens[at + i] === word),
            );
        out.push(...(startsAPrefix ? words : [arg]));
    }
    return out;
}

function tokenMatches(token: string, arg: string | undefined): boolean {
    if (arg === undefined) return false;
    if (arg === token) return true;
    // "scripts/" covers any path under it, never one that climbs out.
    return (
        token.endsWith('/') &&
        arg.startsWith(token) &&
        !arg.split('/').includes('..')
    );
}

/**
 * Whether argv starts with one of the allowed prefixes, token for token.
 * A prefix may spell the binary (or CLI name) first; it is ignored, since the
 * binary is never part of the agent's argv. A token ending in "/" matches any
 * path below that directory.
 */
export function matchesAllowedPrefix(
    args: readonly string[],
    cli: Pick<CliToolConfig, 'allowedPrefixes' | 'binary' | 'name'>,
): boolean {
    for (const raw of cli.allowedPrefixes ?? []) {
        const tokens = prefixTokens(raw, cli);
        if (!tokens.length) continue;
        if (tokens.length > args.length) continue;
        if (tokens.every((token, i) => tokenMatches(token, args[i]))) {
            return true;
        }
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
/**
 * A `set -e` script run in a subshell, so its `exit` code is what the
 * sandbox command reports. E2B's shell runs an exit hook that fails, and
 * under `set -e` that hook turned the script's own `exit 0` into exit 1.
 */
function inSubshell(lines: readonly string[]): string {
    return ['(', ...lines, ')'].join('\n');
}

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
    return inSubshell([
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
    ]);
}

/**
 * IPv4 ranges a CLI may never reach, even when an allowed domain resolves
 * there: loopback, private (RFC 1918), link-local (cloud metadata), CGNAT,
 * benchmarking, documentation, multicast and reserved space.
 */
export const NON_PUBLIC_IPV4_CIDRS = [
    '0.0.0.0/8',
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.0.0.0/24',
    '192.0.2.0/24',
    '192.168.0.0/16',
    '198.18.0.0/15',
    '198.51.100.0/24',
    '203.0.113.0/24',
    '224.0.0.0/4',
    '240.0.0.0/4',
] as const;

/** awk program over one dotted quad: exits 0 when the address is public and
 *  1 when it is not (or is not an IPv4 address at all). Mirrors
 *  NON_PUBLIC_IPV4_CIDRS. */
const PUBLIC_IPV4_AWK = [
    '{',
    'if ($0 !~ /^[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+$/) exit 1;',
    'split($0, o, "."); a = o[1] + 0; b = o[2] + 0; c = o[3] + 0;',
    'if (a > 255 || b > 255 || c > 255 || o[4] + 0 > 255) exit 1;',
    'if (a == 0 || a == 10 || a == 127 || a >= 224) exit 1;',
    'if (a == 100 && b >= 64 && b <= 127) exit 1;',
    'if (a == 169 && b == 254) exit 1;',
    'if (a == 172 && b >= 16 && b <= 31) exit 1;',
    'if (a == 192 && b == 168) exit 1;',
    'if (a == 192 && b == 0 && (c == 0 || c == 2)) exit 1;',
    'if (a == 198 && (b == 18 || b == 19)) exit 1;',
    'if (a == 198 && b == 51 && c == 100) exit 1;',
    'if (a == 203 && b == 0 && c == 113) exit 1;',
    'exit 0',
    '}',
].join(' ');

/**
 * Fence the CLI user's egress to its allowlist. Domains are resolved now and
 * pinned in /etc/hosts; the user's DNS, loopback and every other address are
 * rejected. Matching on the ORIGINAL destination (`ct original ip daddr`) keeps the
 * rule right behind the transparent egress proxy, which rewrites the
 * destination to loopback before the filter table sees the packet.
 */
export function buildNetworkScript(params: {
    identity: CliSandboxIdentity;
    domains: readonly string[];
}): string {
    const { identity, domains } = params;
    const user = shSingleQuote(identity.user);
    // `KCLI_` and hex (cliSandboxIdentity): safe unquoted in nft syntax.
    const chain = identity.chain;
    const tag = identity.tag;
    const table = 'inet kodus_cli';
    const lines = [
        'set -eu',
        'NFT="sudo -n nft"',
        'IPS=""',
        `sudo -n sed -i '/# ${tag}$/d' /etc/hosts`,
    ];
    for (const domain of domains) {
        const d = shSingleQuote(domain);
        lines.push(
            `R=$(getent ahostsv4 ${d} | awk '{print $1}' | sort -u)`,
            `[ -n "$R" ] || { echo ${shSingleQuote(`cannot resolve ${domain}`)} >&2; exit 4; }`,
            // A domain that resolves inside the sandbox's network (metadata
            // endpoint, loopback services, private hosts) is refused whole.
            `for ip in $R; do echo "$ip" | awk ${shSingleQuote(PUBLIC_IPV4_AWK)} || { echo ${shSingleQuote(`${domain} resolves to a non-public address`)} "$ip" >&2; exit 4; }; done`,
            `for ip in $R; do echo "$ip ${domain} # ${tag}" | sudo -n tee -a /etc/hosts >/dev/null; IPS="$IPS $ip"; done`,
        );
    }
    lines.push(
        // nft, not iptables: the E2B kernel has no iptables owner match, but
        // nftables matches the socket's user natively (`meta skuid`).
        `$NFT add table ${table}`,
        `$NFT add chain ${table} out '{ type filter hook output priority 0 ; policy accept ; }'`,
        `$NFT add chain ${table} ${chain}`,
        `$NFT flush chain ${table} ${chain}`,
        `$NFT add rule ${table} ${chain} meta nfproto ipv6 reject`,
        // Non-public ranges are rejected before any accept, whatever DNS says.
        `$NFT add rule ${table} ${chain} ct original ip daddr '{ ${NON_PUBLIC_IPV4_CIDRS.join(', ')} }' reject`,
        `for ip in $IPS; do $NFT add rule ${table} ${chain} ct original ip daddr "$ip" accept; done`,
        `$NFT add rule ${table} ${chain} reject`,
        `UID_=$(id -u ${user})`,
        `$NFT list chain ${table} out | grep -q "meta skuid $UID_ jump ${identity.chain}" || $NFT add rule ${table} out meta skuid "$UID_" jump ${chain}`,
    );
    return inSubshell(lines);
}

/**
 * The single line that runs one CLI call. Secrets are named in
 * `--preserve-env` and arrive through the sandbox process env, so their
 * values are never part of this string. The shell the sandbox starts holds
 * that env and runs as the review user, whose other commands could read a
 * process's env under /proc: it `exec`s into sudo at once, so the env lives
 * only in root's shell and the CLI user's processes from then on. After the
 * call, timed out or not, every process the CLI user still owns is killed,
 * so nothing it started (a daemon, a forked child) outlives the call; the
 * call's exit code is kept.
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
    const user = shSingleQuote(identity.user);
    const asRoot = `sudo -n -u ${user} -H${preserve} -- /usr/bin/env -C ${shSingleQuote(CLI_REPO_DIR)} /usr/bin/timeout -k 5 ${timeoutSec} ${shellJoin([binaryPath, ...args])}; rc=$?; pkill -KILL -u ${user} >/dev/null 2>&1; exit $rc`;
    return `exec sudo -n${preserve} -- /bin/sh -c ${shSingleQuote(asRoot)}`;
}

export function resolveCliTimeoutSec(cli: Pick<CliToolConfig, 'timeoutSec'>) {
    // A config that skipped validation (YAML) can carry NaN or a string,
    // which would reach `timeout` as an invalid duration.
    const configured = Number.isFinite(cli.timeoutSec)
        ? cli.timeoutSec!
        : CLI_DEFAULT_TIMEOUT_SEC;
    return Math.min(Math.max(1, configured), CLI_MAX_TIMEOUT_SEC);
}
