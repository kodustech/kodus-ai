/**
 * Installs a team CLI into a user prefix under /workspace, as the sandbox's
 * own unprivileged user (no root exists in a runtime sandbox). It runs during
 * sandbox preparation, while the sandbox is still open to the install hosts
 * and before the egress seal; after the seal the binary runs with no network.
 */
export const CLI_PREFIX_ROOT = '/workspace/.kcli';
export const CLI_PREFIX_MARKER = 'KODUS_CLI_BINARY=';
export const CLI_PREFIX_INSTALL_TIMEOUT_SEC = 300;

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function cliPrefixHome(id: string): string {
    return `${CLI_PREFIX_ROOT}/${id}`;
}

/** The environment every package manager needs to stay inside the prefix. */
export function cliPrefixEnv(home: string): string[] {
    return [
        `HOME=${home}`,
        `PATH=${home}/.local/bin:${home}/node_modules/.bin:/usr/local/bin:/usr/bin:/bin`,
        `NPM_CONFIG_PREFIX=${home}/.local`,
        `NPM_CONFIG_CACHE=${home}/.cache/npm`,
        `PNPM_HOME=${home}/.local/bin`,
        'PIP_USER=1',
        'PIP_BREAK_SYSTEM_PACKAGES=1',
        `PYTHONUSERBASE=${home}/.local`,
        `PIPX_HOME=${home}/.local/pipx`,
        `PIPX_BIN_DIR=${home}/.local/bin`,
        `UV_TOOL_DIR=${home}/.local/uv`,
        `UV_TOOL_BIN_DIR=${home}/.local/bin`,
    ];
}

export function buildCliPrefixInstallScript(params: {
    id: string;
    argv: readonly string[];
    binary: string;
}): string {
    const home = cliPrefixHome(params.id);
    const env = cliPrefixEnv(home).map(q).join(' ');
    const dirs = [`${home}/.local/bin`, `${home}/node_modules/.bin`]
        .map(q)
        .join(' ');
    return [
        'set -eu',
        `mkdir -p ${q(`${home}/.local/bin`)}`,
        `cd ${q(home)}`,
        `/usr/bin/env -i ${env} /usr/bin/timeout -k 5 ${CLI_PREFIX_INSTALL_TIMEOUT_SEC} ${params.argv.map(q).join(' ')} >&2`,
        `for d in ${dirs}; do`,
        `  if [ -x "$d"/${q(params.binary)} ]; then echo "${CLI_PREFIX_MARKER}$d/"${q(params.binary)}; exit 0; fi`,
        'done',
        `echo ${q(`binary ${params.binary} not found after install`)} >&2`,
        'exit 3',
    ].join('\n');
}

/** The binary path the install script printed, only if it is inside the
 *  prefix (whatever a package's own output claims). */
export function parseCliPrefixBinary(
    id: string,
    stdout: string,
): string | undefined {
    const home = cliPrefixHome(id);
    const path = stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith(CLI_PREFIX_MARKER))
        .pop()
        ?.slice(CLI_PREFIX_MARKER.length);
    return path && path.startsWith(`${home}/`) && !path.includes('..')
        ? path
        : undefined;
}
