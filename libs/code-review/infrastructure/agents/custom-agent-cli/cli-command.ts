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
 * - secrets travel only in the process env (named here, never valued);
 * - every script here runs as root through the sandbox's root channel
 *   (`run(..., { asRoot: true })`), with a system-only PATH: the review user
 *   has no sudo, and no step of a CLI's life passes through that user.
 */
import { createHash } from 'node:crypto';

import { CliToolConfig } from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { checkCliInstallCommand } from '@libs/core/infrastructure/config/types/general/cli-install';
import { shSingleQuote } from '@libs/code-review/infrastructure/adapters/services/shell-quote';
import { ROOT_SAFE_PATH_LINE } from '@libs/sandbox/infrastructure/providers/review-user-privileges';

import { CLI_EGRESS_PROXY_SOURCE } from './cli-egress-proxy.source';

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
    /** nft chain fencing the CLI user to its egress proxy. */
    chain: string;
    /** Marker on the /etc/hosts lines pinned for this CLI. */
    tag: string;
    /** Unprivileged user the CLI's egress proxy runs as. */
    proxyUser: string;
    proxyHome: string;
    /** nft chain fencing the proxy user to public HTTPS (and DNS). */
    proxyChain: string;
    /** Loopback port the proxy listens on. */
    proxyPort: number;
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
    const proxyUser = `kpx${key}`;
    return {
        user,
        home: `/home/${user}`,
        chain: `KCLI_${key}`,
        tag: `kodus-cli:${key}`,
        proxyUser,
        proxyHome: `/home/${proxyUser}`,
        proxyChain: `KPX_${key}`,
        proxyPort: 20_000 + (parseInt(key.slice(0, 4), 16) % 20_000),
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
 * the user's home, then kill whatever the install left running as that user.
 * Prints the resolved absolute binary path after the marker. No secret
 * exists in the sandbox at this point.
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
        ROOT_SAFE_PATH_LINE,
        // The review user's home holds the proxy config and the checkout: the
        // CLI user may traverse to the repo, never list or read the rest.
        'chmod 711 /home/user 2>/dev/null || true',
        'chmod 600 /home/user/config.json 2>/dev/null || true',
        `id -u ${shSingleQuote(identity.user)} >/dev/null 2>&1 || useradd --create-home --home-dir ${shSingleQuote(h)} --shell /usr/sbin/nologin ${shSingleQuote(identity.user)}`,
        `chmod 700 ${shSingleQuote(h)}`,
        `sudo -n -u ${shSingleQuote(identity.user)} -- /usr/bin/env -C ${shSingleQuote(h)} -i ${shellJoin(env)} /usr/bin/timeout -k 5 ${CLI_INSTALL_TIMEOUT_SEC} ${shellJoin(argv)}`,
        // Nothing the install started (a lifecycle script's background
        // process) may live on as the CLI user into the calls that carry
        // its secrets.
        `pkill -KILL -u ${shSingleQuote(identity.user)} >/dev/null 2>&1 || true`,
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

/** Where the egress proxy source is written in the sandbox (root-owned). */
export const CLI_EGRESS_PROXY_DIR = '/usr/local/lib/kodus-cli';
export const CLI_EGRESS_PROXY_PATH = `${CLI_EGRESS_PROXY_DIR}/egress-proxy.js`;

/** Node binaries the proxy may run with: root-owned, from the image. */
const NODE_CANDIDATES = ['/usr/bin/node', '/usr/local/bin/node'];

/**
 * Fence the CLI user's egress to its allowlist, by host name.
 *
 * - The CLI user may open TCP only to its own egress proxy on loopback; its
 *   port 443 connections, whatever address they dial, are redirected there
 *   (nat, ahead of the image's transparent proxy). Everything else (other
 *   ports, UDP, DNS, IPv6, other loopback services) is rejected.
 * - The proxy (CLI_EGRESS_PROXY_SOURCE) runs as its own user, forwards a
 *   connection only when the TLS server name is on the allowlist, and
 *   resolves that name itself, refusing non-public addresses.
 * - The proxy user may reach only DNS and public addresses on 443.
 * - Allowed names are also resolved now and pinned in /etc/hosts (public
 *   addresses only, else the CLI is refused), so the CLI, which has no DNS,
 *   can look them up.
 *
 * Plain HTTP is not forwarded: a credential must not travel in clear text,
 * and HTTPS is the only protocol whose destination name can be checked
 * without decrypting it.
 */
export function buildNetworkScript(params: {
    identity: CliSandboxIdentity;
    domains: readonly string[];
}): string {
    const { identity, domains } = params;
    const user = shSingleQuote(identity.user);
    const proxyUser = shSingleQuote(identity.proxyUser);
    const proxyHome = shSingleQuote(identity.proxyHome);
    const ready = shSingleQuote(`${identity.proxyHome}/ready`);
    const port = identity.proxyPort;
    // `KCLI_`/`KPX_` and hex (cliSandboxIdentity): safe unquoted in nft syntax.
    const chain = identity.chain;
    const proxyChain = identity.proxyChain;
    const tag = identity.tag;
    const table = 'inet kodus_cli';
    const natTable = 'ip kodus_cli_nat';
    const lines = [
        'set -eu',
        ROOT_SAFE_PATH_LINE,
        'NFT="nft"',
        `sed -i '/# ${tag}$/d' /etc/hosts`,
    ];
    for (const domain of domains) {
        const d = shSingleQuote(domain);
        lines.push(
            `R=$(getent ahostsv4 ${d} | awk '{print $1}' | sort -u)`,
            `[ -n "$R" ] || { echo ${shSingleQuote(`cannot resolve ${domain}`)} >&2; exit 4; }`,
            // A domain that resolves inside the sandbox's network (metadata
            // endpoint, loopback services, private hosts) is refused whole.
            `for ip in $R; do echo "$ip" | awk ${shSingleQuote(PUBLIC_IPV4_AWK)} || { echo ${shSingleQuote(`${domain} resolves to a non-public address`)} "$ip" >&2; exit 4; }; done`,
            `for ip in $R; do echo "$ip ${domain} # ${tag}" | tee -a /etc/hosts >/dev/null; done`,
        );
    }
    lines.push(
        // The proxy: its own user, the source written by root, restarted
        // with this review's allowlist.
        `id -u ${proxyUser} >/dev/null 2>&1 || useradd --create-home --home-dir ${proxyHome} --shell /usr/sbin/nologin ${proxyUser}`,
        `chmod 700 ${proxyHome}`,
        'NODE=""',
        `for c in ${NODE_CANDIDATES.join(' ')}; do if [ -x "$c" ] && [ "$(stat -L -c %u "$c")" = 0 ]; then NODE="$c"; break; fi; done`,
        `[ -n "$NODE" ] || { echo 'no root-owned node for the egress proxy' >&2; exit 4; }`,
        `mkdir -p ${shSingleQuote(CLI_EGRESS_PROXY_DIR)}`,
        `printf '%s' ${shSingleQuote(CLI_EGRESS_PROXY_SOURCE)} > ${shSingleQuote(CLI_EGRESS_PROXY_PATH)}`,
        `chmod 644 ${shSingleQuote(CLI_EGRESS_PROXY_PATH)}`,
        `pkill -KILL -u ${proxyUser} >/dev/null 2>&1 || true`,
        `rm -f ${ready}`,
        `setsid sudo -n -u ${proxyUser} -- /usr/bin/env -i HOME=${proxyHome} "$NODE" ${shSingleQuote(CLI_EGRESS_PROXY_PATH)} ${shSingleQuote(JSON.stringify(domains))} ${port} ${ready} </dev/null >>${shSingleQuote(`${identity.proxyHome}/proxy.log`)} 2>&1 &`,
        'i=0',
        `while [ ! -e ${ready} ] && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done`,
        `[ -e ${ready} ] || { echo 'egress proxy did not start' >&2; exit 4; }`,
        // nft, not iptables: the E2B kernel has no iptables owner match, but
        // nftables matches the socket's user natively (`meta skuid`).
        `$NFT add table ${table}`,
        `$NFT add chain ${table} out '{ type filter hook output priority 0 ; policy accept ; }'`,
        `$NFT add table ${natTable}`,
        // Ahead of the image's transparent proxy (nat priority -100).
        `$NFT add chain ${natTable} out '{ type nat hook output priority -150 ; policy accept ; }'`,
        `UID_=$(id -u ${user})`,
        `PUID_=$(id -u ${proxyUser})`,
        `$NFT list chain ${natTable} out | grep -q "meta skuid $UID_ tcp dport 443 redirect to :${port}" || $NFT add rule ${natTable} out meta skuid "$UID_" tcp dport 443 redirect to :${port}`,
        // The CLI user: its proxy only.
        `$NFT add chain ${table} ${chain}`,
        `$NFT flush chain ${table} ${chain}`,
        `$NFT add rule ${table} ${chain} meta nfproto ipv6 reject`,
        `$NFT add rule ${table} ${chain} ip daddr 127.0.0.1 tcp dport ${port} accept`,
        `$NFT add rule ${table} ${chain} reject`,
        // The proxy user: DNS, and public addresses on 443. Matching on the
        // ORIGINAL destination (`ct original`) keeps the rule right behind
        // the image's transparent proxy, which rewrites the destination.
        `$NFT add chain ${table} ${proxyChain}`,
        `$NFT flush chain ${table} ${proxyChain}`,
        `$NFT add rule ${table} ${proxyChain} meta nfproto ipv6 reject`,
        `$NFT add rule ${table} ${proxyChain} ct state established,related accept`,
        `$NFT add rule ${table} ${proxyChain} ct original proto-dst 53 accept`,
        `$NFT add rule ${table} ${proxyChain} ct original ip daddr '{ ${NON_PUBLIC_IPV4_CIDRS.join(', ')} }' reject`,
        `$NFT add rule ${table} ${proxyChain} ct original proto-dst 443 accept`,
        `$NFT add rule ${table} ${proxyChain} reject`,
        `$NFT list chain ${table} out | grep -q "meta skuid $UID_ jump ${chain}" || $NFT add rule ${table} out meta skuid "$UID_" jump ${chain}`,
        `$NFT list chain ${table} out | grep -q "meta skuid $PUID_ jump ${proxyChain}" || $NFT add rule ${table} out meta skuid "$PUID_" jump ${proxyChain}`,
    );
    return inSubshell(lines);
}

/** Shared temp directories a CLI might write to despite TMPDIR. */
const SHARED_TMP_DIRS = ['/tmp', '/var/tmp', '/dev/shm'];

/**
 * The command that runs one CLI call, as root through the sandbox's root
 * channel. Secrets are named in `--preserve-env` and arrive through that
 * root process's env, so their values are never part of this string, and no
 * process of the review user ever holds them (only root can read a root
 * process's env).
 *
 * Files the CLI writes stay its own: each call gets a fresh private temp
 * directory inside the CLI user's home (0700, as TMPDIR/TMP/TEMP) and runs
 * under umask 077, so even a file it drops in /tmp is unreadable to the
 * review user. After the call, timed out or not, every process the CLI user
 * still owns is killed (nothing it started outlives the call), its temp
 * directory is removed, and so is anything it left in the shared temp
 * directories. The call's exit code is kept.
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
    const tmpTemplate = shSingleQuote(`${identity.home}/.run-XXXXXXXX`);
    // umask is set inside the CLI user's process: sudo may apply its own.
    const withUmask = `/bin/sh -c ${shSingleQuote('umask 077; exec "$@"')} sh`;
    return [
        ROOT_SAFE_PATH_LINE,
        `T=$(mktemp -d ${tmpTemplate}) || exit 125`,
        `chown ${user}: "$T" && chmod 700 "$T" || { rm -rf "$T"; exit 125; }`,
        `sudo -n -u ${user} -H${preserve} -- /usr/bin/env -C ${shSingleQuote(CLI_REPO_DIR)} TMPDIR="$T" TMP="$T" TEMP="$T" ${withUmask} /usr/bin/timeout -k 5 ${timeoutSec} ${shellJoin([binaryPath, ...args])}; rc=$?`,
        `pkill -KILL -u ${user} >/dev/null 2>&1`,
        'rm -rf "$T"',
        `find ${SHARED_TMP_DIRS.join(' ')} -xdev -mindepth 1 -user ${user} -exec rm -rf {} + >/dev/null 2>&1`,
        'exit $rc',
    ].join('\n');
}

export function resolveCliTimeoutSec(cli: Pick<CliToolConfig, 'timeoutSec'>) {
    // A config that skipped validation (YAML) can carry NaN or a string,
    // which would reach `timeout` as an invalid duration.
    const configured = Number.isFinite(cli.timeoutSec)
        ? cli.timeoutSec!
        : CLI_DEFAULT_TIMEOUT_SEC;
    return Math.min(Math.max(1, configured), CLI_MAX_TIMEOUT_SEC);
}
