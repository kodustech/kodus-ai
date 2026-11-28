/**
 * Installs a team CLI into a user prefix under /workspace, as the sandbox's
 * own unprivileged user (no root exists in a runtime sandbox). It runs during
 * sandbox preparation, while the sandbox is still open to the install hosts
 * and before the egress seal; after the seal the binary runs with no network.
 */
export const CLI_PREFIX_ROOT = '/workspace/.kcli';
export const CLI_PREFIX_MARKER = 'KODUS_CLI_BINARY=';
export const CLI_PREFIX_INTERPRETER_MARKER = 'KODUS_CLI_INTERPRETER=';
/** The runtime sandbox mounts /workspace and /tmp noexec (a defense kept on),
 *  so the kernel cannot execve anything installed there: a CLI runs as
 *  `<interpreter> <script>`, the interpreter being a binary of the image. */
export const CLI_PREFIX_INTERPRETERS = ['node', 'python3', 'bash', 'sh'] as const;
export type CliPrefixInterpreter = (typeof CLI_PREFIX_INTERPRETERS)[number];
export const CLI_PREFIX_INSTALL_TIMEOUT_SEC = 300;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function cliPrefixHome(id: string): string {
    return `${CLI_PREFIX_ROOT}/${id}`;
}

/**
 * Where a tool layer of the cell is mounted, read-only, in a review sandbox
 * (docs/runtime/persistent-state.md D11): the same absolute path the layer was
 * built at, so what the install wrote into the prefix still resolves.
 */
export const CLI_LAYER_ROOT = '/opt/kcli';

export function cliLayerPrefix(id: string): string {
    return `${CLI_LAYER_ROOT}/${id}`;
}

/**
 * The environment every package manager needs to stay inside the prefix. The
 * prefix holds what the CLI is installed in (read-only when it is a tool layer);
 * HOME and the package manager's cache are the throwaway home, which stays
 * writable. An install into the workspace has both in one directory.
 */
export function cliPrefixEnv(dirs: { prefix: string; home: string }): string[] {
    const { prefix, home } = dirs;
    return [
        `HOME=${home}`,
        `PATH=${prefix}/.local/bin:${prefix}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
        `NPM_CONFIG_PREFIX=${prefix}/.local`,
        `NPM_CONFIG_CACHE=${home}/.cache/npm`,
        `PNPM_HOME=${prefix}/.local/bin`,
        'PIP_USER=1',
        'PIP_BREAK_SYSTEM_PACKAGES=1',
        `PYTHONUSERBASE=${prefix}/.local`,
        `PIPX_HOME=${prefix}/.local/pipx`,
        `PIPX_BIN_DIR=${prefix}/.local/bin`,
        `UV_TOOL_DIR=${prefix}/.local/uv`,
        `UV_TOOL_BIN_DIR=${prefix}/.local/bin`,
    ];
}

export function buildCliPrefixInstallScript(params: {
    id: string;
    argv: readonly string[];
    binary: string;
}): string {
    const home = cliPrefixHome(params.id);
    const env = cliPrefixEnv({ prefix: home, home }).map(q).join(' ');
    const dirs = [`${home}/.local/bin`, `${home}/node_modules/.bin`]
        .map(q)
        .join(' ');
    return [
        'set -eu',
        `mkdir -p ${q(`${home}/.local/bin`)}`,
        `cd ${q(home)}`,
        `/usr/bin/env -i ${env} /usr/bin/timeout -k 5 ${CLI_PREFIX_INSTALL_TIMEOUT_SEC} ${params.argv.map(q).join(' ')} >&2`,
        `for d in ${dirs}; do`,
        // -e, not -x: on a noexec mount the exec bit tests false. readlink -f
        // follows node_modules/.bin/<name> -> ../<pkg>/cli.js to the real file.
        `  b="$d"/${q(params.binary)}`,
        '  [ -e "$b" ] || continue',
        '  r=$(readlink -f "$b") || continue',
        '  [ -f "$r" ] || continue',
        `  magic=$(head -c 4 "$r" | od -An -tx1 | tr -d ' \n')`,
        '  if [ "$magic" = 7f454c46 ]; then',
        `    echo ${q(`binary ${params.binary} is a native executable; it cannot run in the runtime sandbox (its workspace is noexec). Use a script CLI (node, python or shell).`)} >&2`,
        '    exit 4',
        '  fi',
        `  line=$(head -n 1 "$r" | tr -d '\r')`,
        '  case "$line" in',
        "    '#!'*node*) i=node ;;",
        "    '#!'*python*) i=python3 ;;",
        "    '#!'*bash*) i=bash ;;",
        "    '#!'*sh*) i=sh ;;",
        '    *) i= ;;',
        '  esac',
        '  if [ -z "$i" ]; then',
        `    echo ${q(`binary ${params.binary} has no supported shebang (node, python, bash or sh); it cannot run in the runtime sandbox`)} >&2`,
        '    exit 5',
        '  fi',
        `  echo "${CLI_PREFIX_MARKER}$r"`,
        `  echo "${CLI_PREFIX_INTERPRETER_MARKER}$i"`,
        '  exit 0',
        'done',
        `echo ${q(`binary ${params.binary} not found after install`)} >&2`,
        'exit 3',
    ].join('\n');
}

export interface ParsedCliPrefixInstall {
    binaryPath: string;
    interpreter: CliPrefixInterpreter;
}

/** The resolved script path and interpreter the install script printed, only
 *  if the path is inside the prefix (whatever a package's own output claims)
 *  and the interpreter is one we know. */
export function parseCliPrefixInstall(
    id: string,
    stdout: string,
): ParsedCliPrefixInstall | undefined {
    const home = cliPrefixHome(id);
    const last = (marker: string) =>
        stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith(marker))
            .pop()
            ?.slice(marker.length);
    const binaryPath = last(CLI_PREFIX_MARKER);
    const interpreter = last(CLI_PREFIX_INTERPRETER_MARKER);
    if (
        !binaryPath ||
        !binaryPath.startsWith(`${home}/`) ||
        binaryPath.includes('..') ||
        !(CLI_PREFIX_INTERPRETERS as readonly string[]).includes(interpreter ?? '')
    ) {
        return undefined;
    }
    return { binaryPath, interpreter: interpreter as CliPrefixInterpreter };
}

/**
 * What the cell answered for a tool layer it holds (claim.ready, through the
 * hub): the CLI's path and interpreter, trusted only when the path is under the
 * layer's own mount and the interpreter is one we know, whatever the answer says.
 */
export function parseToolLayerHit(
    id: string,
    hit: { binaryPath?: string; interpreter?: string },
): ParsedCliPrefixInstall | undefined {
    const prefix = cliLayerPrefix(id);
    if (
        !hit.binaryPath ||
        !hit.binaryPath.startsWith(`${prefix}/`) ||
        hit.binaryPath.includes('..') ||
        !(CLI_PREFIX_INTERPRETERS as readonly string[]).includes(hit.interpreter ?? '')
    ) {
        return undefined;
    }
    return { binaryPath: hit.binaryPath, interpreter: hit.interpreter as CliPrefixInterpreter };
}
