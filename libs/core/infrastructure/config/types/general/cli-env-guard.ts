/**
 * Calls that would print a custom agent CLI's credentials (#2172).
 *
 * A CLI's secrets live in its process env. Output masking catches the common
 * spellings of a value, but the safer rule is to never run a call whose only
 * purpose is to print the env or a stored token. The save DTO, the config
 * schema, the provisioner and `runCli` all use these checks, so what is
 * accepted on save is what is enforced at run time.
 *
 * argv never passes through a shell (it is quoted token by token and run with
 * exec), so `$VAR` in an argument is not expanded by Kodus. Some CLIs expand
 * env references in their own arguments, so an argument naming one of the
 * CLI's secrets that way is refused too.
 */

/** Words that, as an argument, ask a shell, an env tool or a CLI's `env`
 *  subcommand to list variables. */
const ENV_LISTING_WORDS = new Set([
    'printenv',
    'env',
    'set',
    'export',
    'declare',
    'typeset',
    'environ',
]);

/**
 * Argument sequences that print a stored credential in widely used CLIs:
 * `gh auth token`, `gh|glab auth status --show-token|-t`, `heroku auth:token`,
 * `npm|pnpm|yarn config get`, `aws configure get`,
 * `gcloud auth print-access-token|print-identity-token`,
 * `az account get-access-token`.
 */
const TOKEN_PRINTING_SEQUENCES: string[][] = [
    ['auth', 'token'],
    ['auth:token'],
    ['--show-token'],
    ['auth', 'status', '-t'],
    ['config', 'get'],
    ['configure', 'get'],
    ['print-access-token'],
    ['print-identity-token'],
    ['get-access-token'],
];

/**
 * Binaries that run arbitrary code or print the environment on request
 * (shells, interpreters, env tools, package runners): with one of these as
 * the CLI, no prefix allowlist can keep the env from being printed.
 */
const ENV_EXPOSING_BINARIES = new Set([
    'sh',
    'bash',
    'zsh',
    'dash',
    'ksh',
    'fish',
    'busybox',
    'env',
    'printenv',
    'node',
    'nodejs',
    'deno',
    'bun',
    'bunx',
    'npx',
    'pnpx',
    'python',
    'python2',
    'python3',
    'perl',
    'ruby',
    'php',
    'awk',
    'gawk',
    'mawk',
    'xargs',
]);

const tokensOf = (value: string) => value.trim().split(/\s+/).filter(Boolean);

/** Why these argv tokens would print the env or a credential, or null. */
export function cliEnvExposureProblem(
    tokens: readonly string[],
): string | null {
    const lower = tokens.map((token) => token.toLowerCase());
    for (const token of lower) {
        // Whole tokens only: flags such as `--env production` stay usable.
        if (ENV_LISTING_WORDS.has(token)) {
            return `"${token}" lists environment variables`;
        }
        // No review tool needs /proc, and /proc/<pid>/environ is the env.
        if (token.includes('/proc/') || token === '/proc') {
            return `"${token}" reads process information`;
        }
    }
    for (const sequence of TOKEN_PRINTING_SEQUENCES) {
        for (let i = 0; i + sequence.length <= lower.length; i++) {
            if (sequence.every((part, j) => lower[i + j] === part)) {
                return `"${sequence.join(' ')}" prints a stored credential`;
            }
        }
    }
    return null;
}

/** Why an allowed prefix would let a call print the env, or null. */
export function cliPrefixExposureProblem(prefix: string): string | null {
    return cliEnvExposureProblem(tokensOf(String(prefix ?? '')));
}

/** Why a binary cannot be a CLI with credentials, or null. */
export function cliBinaryExposureProblem(binary: string): string | null {
    const name = String(binary ?? '')
        .trim()
        .toLowerCase();
    return ENV_EXPOSING_BINARIES.has(name)
        ? `"${name}" runs arbitrary code or prints the environment; name the CLI's own binary`
        : null;
}

/** Why an argument would hand one of these secrets to the CLI's own env
 *  expansion, or null. */
export function cliSecretReferenceProblem(
    args: readonly string[],
    secretEnvNames: readonly string[],
): string | null {
    for (const name of secretEnvNames) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) continue;
        const reference = new RegExp(`\\$\\{?${name}(?![A-Za-z0-9_])`);
        if (args.some((arg) => reference.test(arg))) {
            return `an argument refers to the secret ${name}`;
        }
    }
    return null;
}
