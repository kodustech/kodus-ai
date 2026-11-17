/**
 * Leave the sandbox's review user with no way to become root.
 *
 * The review user runs everything a review does inside the sandbox: git, the
 * analyzers, the agent's tools, and through them tooling the repository
 * ships. The base image gives that user passwordless sudo. Custom agent CLIs
 * run as their own users with credentials in their process env; a review
 * user that can become root can read that env. So, as root and before any
 * repository content is in the sandbox:
 *
 * - every setuid/setgid bit on system files is cleared, which removes sudo,
 *   su and any other set-id path at once, whatever grants the image has;
 * - the review user leaves the admin groups, in case a bit comes back;
 * - file capabilities are removed where the tools to do so exist;
 * - the egress proxy's config, which holds the proxy's password, is left
 *   readable by root only: the template ships it in the review user's home;
 * - the result is checked from the review user's side, and the script fails
 *   unless sudo is refused, no set-id file is left and no proxy config is
 *   readable.
 *
 * Privileged work after this goes through the provider's root channel
 * (`SandboxInstance.run(..., { asRoot: true })`), never through the review
 * user. Idempotent: re-running it on a resumed sandbox only re-checks.
 */

/** The user the sandbox runs review commands as (E2B's default user). */
export const SANDBOX_REVIEW_USER = 'user';

/** Printed last when the review user is confirmed unprivileged. */
export const PRIVILEGES_DROPPED_MARKER = 'KODUS_REVIEW_USER_UNPRIVILEGED';

/**
 * PATH for every script run as root: system directories only, so nothing a
 * less privileged user can write is ever looked up by root.
 */
export const ROOT_SAFE_PATH_LINE = 'export PATH=/usr/sbin:/usr/bin:/sbin:/bin';

/** System trees searched for set-id files. Home and temp directories hold
 *  only files their (unprivileged) owners created. */
const SYSTEM_DIRS = [
    '/bin',
    '/sbin',
    '/usr',
    '/lib',
    '/lib32',
    '/lib64',
    '/libx32',
    '/opt',
    '/etc',
    '/var',
    '/root',
    '/srv',
];

export const DROP_PRIVILEGES_TIMEOUT_MS = 120_000;

/** Where root keeps files no other user of the sandbox may read. */
export const ROOT_ONLY_DIR = '/etc/kodus';

/** The template's sslocal config, moved out of the review user's home. */
export const PROXY_CONFIG_FILE = 'proxy.json';

/** The config `setupProxy` writes for ss-local. */
export const SS_LOCAL_CONFIG_FILE = 'ss-local.json';

export function buildDropReviewUserPrivilegesScript(
    user: string = SANDBOX_REVIEW_USER,
    rootOnlyDir: string = ROOT_ONLY_DIR,
): string {
    const dirs = SYSTEM_DIRS.join(' ');
    const proxyConfig = `${rootOnlyDir}/${PROXY_CONFIG_FILE}`;
    const proxyConfigs = `'${proxyConfig}' '${rootOnlyDir}/${SS_LOCAL_CONFIG_FILE}'`;
    const setIdFiles = `for d in ${dirs}; do [ -d "$d" ] && find "$d" -xdev -type f -perm /6000 -print 2>/dev/null; done`;
    return [
        '(',
        'set -u',
        ROOT_SAFE_PATH_LINE,
        `U='${user}'`,
        'id -u "$U" >/dev/null 2>&1 || { echo "review user $U not found" >&2; exit 5; }',
        'for g in sudo admin wheel; do gpasswd -d "$U" "$g" >/dev/null 2>&1 || true; done',
        `${setIdFiles} | while IFS= read -r f; do chmod ug-s "$f" 2>/dev/null || true; done`,
        // sslocal, running as root, read the template's config at start;
        // a symlink is never followed out of the review user's home.
        'H=$(getent passwd "$U" | cut -d: -f6)',
        `if [ -n "$H" ] && [ -f "$H/config.json" ] && [ ! -L "$H/config.json" ] && grep -q '"password"' "$H/config.json"; then install -D -m 600 -o root -g root "$H/config.json" '${proxyConfig}' && rm -f "$H/config.json"; fi`,
        `for f in ${proxyConfigs}; do [ -e "$f" ] && { chown root:root "$f"; chmod 600 "$f"; }; done`,
        `if command -v getcap >/dev/null 2>&1 && command -v setcap >/dev/null 2>&1; then for d in ${dirs}; do [ -d "$d" ] && getcap -r "$d" 2>/dev/null; done | awk '{print $1}' | while IFS= read -r f; do setcap -r "$f" 2>/dev/null || true; done; fi`,
        // Checked from the review user's side: switching to it must work (or
        // the check proves nothing), and sudo from it must not.
        '[ "$(sudo -n -u "$U" -- id -u 2>/dev/null)" = "$(id -u "$U")" ] || { echo "cannot run as the review user to verify" >&2; exit 5; }',
        'if sudo -n -u "$U" -- sudo -n true </dev/null >/dev/null 2>&1; then echo "review user can still use sudo" >&2; exit 5; fi',
        `for f in ${proxyConfigs}; do if [ -e "$f" ] && sudo -n -u "$U" -- test -r "$f"; then echo "review user can read $f" >&2; exit 5; fi; done`,
        `LEFT=$(${setIdFiles} | head -n 1)`,
        '[ -z "$LEFT" ] || { echo "set-id file left: $LEFT" >&2; exit 5; }',
        `echo ${PRIVILEGES_DROPPED_MARKER}`,
        ')',
    ].join('\n');
}

/** Whether a run of the script above confirmed the drop. */
export function confirmsPrivilegesDropped(run: {
    exitCode: number;
    stdout?: string;
}): boolean {
    return (
        run.exitCode === 0 &&
        (run.stdout ?? '')
            .split('\n')
            .some((line) => line.trim() === PRIVILEGES_DROPPED_MARKER)
    );
}
