/**
 * The ambient GIT_* variables the CLI hands to git.
 *
 * simple-git 4 strips every GIT_* variable (and EDITOR, PAGER…) from the
 * environment of the git it spawns unless the caller allows it. The CLI runs
 * git for the user, in the user's own shell, so the variables that tell git
 * which repository, index and config to use must still reach it:
 * - a pre-commit hook after `git commit -a` points GIT_INDEX_FILE at a
 *   temporary index; without it `diff --cached` reads the wrong index and the
 *   review sees no changes;
 * - GIT_DIR / GIT_WORK_TREE checkouts (bare or dotfiles repos);
 * - config passed by env (`git -c` sets GIT_CONFIG_PARAMETERS; CI sets
 *   safe.directory through GIT_CONFIG_COUNT/KEY_n/VALUE_n).
 * Credential and editor variables stay stripped: the CLI never needs them.
 */
const REPOSITORY_VARIABLES = [
    'GIT_INDEX_FILE',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_CEILING_DIRECTORIES',
    'GIT_DISCOVERY_ACROSS_FILESYSTEM',
    'GIT_NAMESPACE',
    'GIT_CONFIG_PARAMETERS',
    'GIT_CONFIG_COUNT',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_SYSTEM',
    'GIT_CONFIG_NOSYSTEM',
];

const INDEXED_CONFIG = /^GIT_CONFIG_(KEY|VALUE)_\d+$/i;

export function gitEnvironmentToKeep(
    env: NodeJS.ProcessEnv = process.env,
): string[] {
    const indexed = Object.keys(env).filter((key) => INDEXED_CONFIG.test(key));
    return [...REPOSITORY_VARIABLES, ...indexed];
}
