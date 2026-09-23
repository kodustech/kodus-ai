/**
 * Decide which submodules the review sandbox may fetch, and build the git
 * invocation that fetches them.
 *
 * Both providers (E2B and local/self-hosted) call this ONE module. The design
 * for #1939 asked for exactly that: the validation living in two places is how
 * this comes back the next time one provider is edited and the other is not.
 *
 * ## Why validation is required, not defence in depth
 *
 * `.gitmodules` ships inside the pull request, so its URLs are authored by
 * whoever opened the PR. Measured on a local git server that required an exact
 * `Authorization` header (feasibility run for #1939):
 *
 *   - with the GLOBAL `http.extraHeader` both providers use for the clone
 *     today, `git submodule update` sent the customer's git token verbatim to
 *     a foreign host named in `.gitmodules`;
 *   - with the SCOPED `http.<repo-url>.extraHeader` key this module emits, that
 *     foreign host received no `Authorization` header at all.
 *
 * So turning submodule fetching on with the existing global header would have
 * been a token-exfiltration bug. Scoping is the fix, and it is load-bearing.
 *
 * ## The rules
 *
 * 1. Same host as the repository under review. The PR author can therefore
 *    only ever point us at the git server we already fetched the PR from —
 *    there is no new network reachable from the sandbox.
 *
 *    The host is compared against the url GIT resolved, never one this module
 *    resolved itself. `.gitmodules` usually holds a RELATIVE url (`../x.git`),
 *    and git's resolution is not WHATWG URL resolution — measured against
 *    git 2.x with origin `https://github.com/acme/app.git`:
 *
 *      ../commons.git                     git: https://github.com/acme/commons.git
 *                                        ­ URL: https://github.com/commons.git
 *      ../../../../../../evil.example/x.git  git: `.:evil.example/x.git`  ← scp-like,
 *                                        ­ URL: https://github.com/evil.example/x.git
 *
 *    The second row is why: resolving it here would have approved it as
 *    "same host github.com" while git went somewhere else entirely over a
 *    different transport. So the provider runs `git submodule init` first —
 *    which registers the RESOLVED urls in `.git/config` and makes no network
 *    request — and this module validates what git actually wrote.
 * 2. Same scheme as the repository under review, and that scheme must be
 *    http(s). This is rule 1 applied to the transport: it rules out `git://`,
 *    `ssh://` and `file://` (which bypass the header and the proxy), without
 *    rejecting the plaintext-http git servers some self-hosted installs run.
 * 3. The auth header is scoped to that host, never global.
 *
 * A private/link-local IP check was considered and deliberately left out: under
 * rule 1 the only reachable target is the git server the review already talks
 * to, so the check protects nothing, while rejecting private ranges would
 * disable submodules for every self-hosted customer — whose git server is on a
 * private address by definition. Revisit this if rule 1 is ever relaxed.
 *
 * Nested submodules are NOT fetched (`--recursive` is deliberately absent): a
 * submodule's own `.gitmodules` has not been through these rules, and passing
 * `--recursive` would let it send git to a host this module never approved. A
 * nested submodule stays empty and is reported by the uninitialized-submodule
 * marker, which is the honest answer.
 */

export type SubmoduleDecision =
    | { path: string; name: string; url: string; allowed: true }
    | {
          path: string;
          name: string;
          url: string;
          allowed: false;
          reason: string;
      };

/**
 * `git` arguments that dump what GIT reads out of `.gitmodules`.
 *
 * This module used to scan `.gitmodules` itself. It must not: git's config
 * parser accepts shapes a line scanner does not, and `.gitmodules` is authored
 * by whoever opened the pull request. Measured with git 2.51 — a variable on
 * the same line as the section header:
 *
 *     [submodule "b"]
 *         path = vendor/good
 *         url  = https://github.com/acme/good.git
 *     [submodule "a"] url = https://evil.example/e.git
 *         path = vendor/evil
 *
 * git reads `a.url=evil.example` with `a.path=vendor/evil`. A line scanner
 * that only recognises a header occupying the whole line skips that header and
 * attaches `path = vendor/evil` to section `b` — so it validates b's github
 * url and then hands `vendor/evil` to `git submodule update`, which fetches it
 * from `evil.example` using a's registered url. The same-host rule is bypassed
 * entirely, and the cleanup step never sees `submodule.a` to remove.
 *
 * So the name AND the path come from git, exactly like the resolved url does.
 */
export const SUBMODULE_DECLARED_DUMP_ARGS = [
    'config',
    '-f',
    '.gitmodules',
    '--get-regexp',
    '^submodule\\.',
];

/** What `.gitmodules` declares, as GIT reads it: name -> { path, url }. */
export type DeclaredSubmodules = Map<string, { path?: string; url?: string }>;

/**
 * Parse `SUBMODULE_DECLARED_DUMP_ARGS` output.
 *
 * Keys look like `submodule.<name>.<key>`; a name may itself contain dots
 * ("pkg/a.b"), so the key is the LAST dot-separated segment and the name is
 * everything between.
 */
export function parseDeclaredSubmodules(
    configDump: string,
): DeclaredSubmodules {
    const declared: DeclaredSubmodules = new Map();
    for (const rawLine of String(configDump || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const space = line.indexOf(' ');
        if (space === -1) continue;
        const fullKey = line.slice(0, space);
        const value = line.slice(space + 1).trim();
        if (!fullKey.startsWith('submodule.')) continue;
        const rest = fullKey.slice('submodule.'.length);
        const lastDot = rest.lastIndexOf('.');
        if (lastDot <= 0) continue;
        const name = rest.slice(0, lastDot);
        const key = rest.slice(lastDot + 1);
        if (key !== 'path' && key !== 'url') continue;
        const entry = declared.get(name) ?? {};
        if (key === 'path') entry.path = normalizePath(value);
        else entry.url = value;
        declared.set(name, entry);
    }
    return declared;
}

function normalizePath(value: string): string {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^\.\//, '')
        .replace(/\/+/g, '/')
        .replace(/\/+$/, '');
}

/**
 * Parse a url git already resolved. Absolute only, by construction: anything
 * relative was turned into an absolute url by `git submodule init` before it
 * reached this module, and a value that is still relative here means the
 * resolution step was skipped — which must fail closed, not be re-resolved.
 */
function parseResolvedUrl(url: string): URL | null {
    const raw = String(url || '').trim();
    if (!raw) return null;
    try {
        return new URL(raw);
    } catch {
        // Includes git's own `host:path` scp-like form (and the `.:path` it can
        // produce from an over-deep `../` chain), which `new URL` rejects — and
        // which we would reject anyway as a non-http transport.
        return null;
    }
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Read `git config --get-regexp '^submodule\..*\.url$'` output into
 * name -> resolved url.
 *
 * A submodule name may itself contain dots ("packages/a.b"), so the name is
 * everything between the leading `submodule.` and the trailing `.url`.
 */
export function parseResolvedSubmoduleUrls(
    configDump: string,
): Map<string, string> {
    const resolved = new Map<string, string>();
    for (const rawLine of String(configDump || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) continue;
        const space = line.indexOf(' ');
        if (space === -1) continue;
        const key = line.slice(0, space);
        const value = line.slice(space + 1).trim();
        if (!key.startsWith('submodule.') || !key.endsWith('.url')) continue;
        const name = key.slice('submodule.'.length, -'.url'.length);
        if (name) resolved.set(name, value);
    }
    return resolved;
}

/**
 * Apply the rules to every entry in `.gitmodules`.
 *
 * Returns a decision per submodule rather than a filtered list, so callers can
 * log exactly what was skipped and why — a submodule silently not fetched is
 * the bug this whole change exists to stop.
 */
/**
 * Does this value stay inside the directory it is joined to?
 *
 * Both the submodule NAME and its PATH come out of `.gitmodules`, which ships
 * inside the pull request. The name is joined to `.git/modules/` and the
 * result is handed to `removeDir`, which is `rm -rf` on E2B and a recursive
 * `rm` on the self-hosted customer's own machine; the path is handed to
 * `git submodule update --`. Neither may contain a `..` segment, at the start
 * or in the middle, and neither may be absolute.
 *
 * git itself refuses a name with a `..` segment ("ignoring suspicious
 * submodule name", the CVE-2018-11235 fix), so nothing that reaches here
 * today carries one. That is git's guarantee, not this module's, and it is
 * the only thing standing between a crafted `.gitmodules` and a recursive
 * delete outside the checkout — so the check is made here too.
 */
export function isContainedRelativePath(value: string): boolean {
    if (!value) return false;
    if (value.startsWith('/')) return false;
    const segments = value.split('/');
    return !segments.some((seg) => seg === '' || seg === '.' || seg === '..');
}

export function decideSubmodules(
    declared: DeclaredSubmodules,
    resolvedUrls: Map<string, string>,
    repoCloneUrl: string,
): SubmoduleDecision[] {
    // Every entry is keyed by the name GIT reported, and carries the path GIT
    // reported for that same name — never a pairing this module inferred.
    const entries = [...declared.entries()]
        .filter(([, v]) => !!v.path)
        .map(([name, v]) => ({
            name,
            path: v.path as string,
            url: v.url ?? '',
        }));

    let repo: URL;
    try {
        repo = new URL(repoCloneUrl);
    } catch {
        return entries.map((entry) => ({
            path: entry.path,
            name: entry.name,
            url: entry.url,
            allowed: false,
            reason: 'repository clone URL is not an http(s) URL',
        }));
    }

    return entries.map((entry) => {
        // What GIT resolved, never what this module could resolve — see the
        // module docstring for the measured divergence that makes the
        // difference load-bearing.
        const resolvedUrl = resolvedUrls.get(entry.name) ?? '';

        const deny = (reason: string): SubmoduleDecision => ({
            path: entry.path,
            name: entry.name,
            url: resolvedUrl || entry.url,
            allowed: false,
            reason,
        });

        if (!isContainedRelativePath(entry.path)) {
            return deny('submodule path escapes the repository');
        }
        // The name reaches `rm -rf .git/modules/<name>` on the deep retry.
        if (!isContainedRelativePath(entry.name)) {
            return deny('submodule name escapes .git/modules');
        }
        if (!resolvedUrl) {
            // `git submodule init` did not register this one (or the dump was
            // not taken). Fail closed: an unresolved url is an unvalidated url.
            return deny('git did not resolve a url for this submodule');
        }

        const target = parseResolvedUrl(resolvedUrl);
        if (!target) {
            return deny('not an http(s) URL (ssh/scp/git/file transport)');
        }
        if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
            return deny(`scheme ${target.protocol}// is not allowed`);
        }
        if (target.protocol !== repo.protocol) {
            return deny(
                `scheme ${target.protocol}// differs from the repository's ${repo.protocol}//`,
            );
        }
        // `host` (not `hostname`) so a port difference counts as a different
        // host; userinfo is ignored by `URL.host`, which is what we want — a
        // crafted `https://user@same-host/` is still the same host.
        if (target.host.toLowerCase() !== repo.host.toLowerCase()) {
            return deny(
                `external submodule host, skipped (${target.host} is not ${repo.host})`,
            );
        }
        return {
            path: entry.path,
            name: entry.name,
            url: resolvedUrl,
            allowed: true,
        };
    });
}

/**
 * The git config key that scopes an auth header to the repository's own host.
 *
 * Git matches `http.<url>.extraHeader` when the request URL has the same
 * scheme, host and port and a path under `<url>`. Using the bare origin means
 * every repo on that server matches, and nothing off it does.
 */
export function scopedAuthHeaderConfigKey(repoCloneUrl: string): string | null {
    try {
        const repo = new URL(repoCloneUrl);
        if (!ALLOWED_PROTOCOLS.has(repo.protocol)) return null;
        return `http.${repo.protocol}//${repo.host}/.extraHeader`;
    } catch {
        return null;
    }
}

export interface SubmoduleUpdatePlan {
    /** Paths to fetch. Empty means: run nothing. */
    paths: string[];
    /** Submodules deliberately not fetched, with the reason, for logging. */
    skipped: Array<{ path: string; url: string; reason: string }>;
    /**
     * `git config --remove-section` arguments for every REJECTED submodule,
     * run before the update.
     *
     * `git submodule init` has already written each rejected url into
     * `.git/config`. `git submodule update -- <allowed>` would not use them,
     * but leaving a url we refused sitting in the checkout's config is a
     * landmine for any later `git submodule update` in that sandbox. Removing
     * them means the refusal survives in the checkout, not just in this call.
     */
    cleanupArgs: string[][];
    /**
     * One `git submodule update` per allowed path, run in order and tolerating
     * individual failures. Empty means: run nothing.
     *
     * Deliberately NOT one command listing every path. `git submodule update`
     * stops at the first submodule it cannot clone ("Failed to clone 'x' a
     * second time, aborting") and never reaches the rest — measured, with a
     * reachable submodule listed after an unreachable one left without its
     * files. That is the production shape of a GitHub App installation that
     * covers one submodule repository but not another, and batching would let
     * the inaccessible one take every accessible one down with it.
     *
     * Retrying the batch per path afterwards does not repair it either: the
     * aborted run leaves a half-initialized gitdir that the retry treats as
     * already done. Going per path from the start avoids that state entirely,
     * and costs exactly one command in the overwhelmingly common single-
     * submodule case.
     */
    updateArgs: string[][];
    /**
     * Full-history recovery for a submodule whose shallow update failed, in
     * the same order as `updateArgs`.
     *
     * A submodule is pinned to a commit, and that commit is usually NOT the
     * tip of any branch — the upstream moves on after the pin. `--depth=1`
     * only asks for the advertised tips, so unless the server sets
     * `uploadpack.allowAnySHA1InWant` git answers `error: Server does not
     * allow request for unadvertised object <sha>` and leaves the directory
     * EMPTY. Measured against git-http-backend with default settings, which is
     * what many self-hosted installs run.
     *
     * Re-running without `--depth=1` in place does NOT recover it: the failed
     * attempt leaves a SHALLOW gitdir under `.git/modules/<name>` and the
     * retry reuses it, failing the same way. Measured. The leftover has to go
     * first — hence deinit, remove the gitdir, re-init, then fetch full.
     */
    deepRetry: Array<{
        path: string;
        /** `git submodule deinit -f -- <path>` */
        deinitArgs: string[];
        /**
         * Repo-relative gitdir the failed attempt left behind. Keyed by the
         * submodule NAME, not its path — `.git/modules/commons-mod` for a
         * `[submodule "commons-mod"]` at `packages/commons`.
         */
        gitdirPath: string;
        /** Re-register it (with the origin, so relative urls still resolve). */
        initArgs: string[];
        /** `git submodule update -- <path>`, full history. */
        updateArgs: string[];
    }>;
    /**
     * Environment carrying the scoped auth header. Uses `GIT_CONFIG_*` on BOTH
     * providers so the token never reaches a process argument list — the local
     * provider already did this for the clone; the E2B clone path still passes
     * it via `-c`, and this new command does not copy that.
     */
    env: Record<string, string>;
}

/**
 * `git` arguments that resolve and register submodule urls — NO network.
 *
 * `remote.origin.url` is supplied explicitly instead of relying on the
 * checkout having an `origin` remote: git resolves a relative submodule url
 * against that config key, and the two providers do not agree on it — the E2B
 * clone adds an `origin`, the local clone never does. Without it git warns
 * ("Assuming this repository is its own authoritative upstream") and resolves
 * `../commons.git` to a LOCAL PATH, so the idiomatic relative form silently
 * fetched nothing on self-hosted. Passing it here makes both providers resolve
 * identically, which is the point of this module.
 */
export function buildSubmoduleInitArgs(
    repoCloneUrl: string,
    /**
     * Restrict the init to these paths. Omitted means "every submodule", which
     * is one round-trip and the right default — but see
     * `buildSubmoduleInitFallbackArgs` for why that is not enough on its own.
     */
    paths?: string[],
): string[] {
    return [
        '-c',
        `remote.origin.url=${repoCloneUrl}`,
        'submodule',
        'init',
        ...(paths?.length ? ['--', ...paths] : []),
    ];
}

/**
 * Per-path init commands, for when the all-at-once init failed.
 *
 * `git submodule init` is ALL OR NOTHING: a single unresolvable url aborts the
 * whole command, and every other submodule in the repository goes unregistered
 * with it. Measured — a `url = ../../../../../../evil.example/x.git` against an
 * origin whose path has one component makes git exit 128 with
 * `fatal: cannot strip one component off url '.'`. A repository with three
 * legitimate submodules plus one broken entry would then fetch NONE of them,
 * which is the bug this whole change exists to stop, reintroduced from the
 * other side.
 *
 * So the providers retry per path and keep whatever registers. The broken entry
 * still fails; it just no longer takes its siblings down with it.
 */
export function buildSubmoduleInitFallbackArgs(
    repoCloneUrl: string,
    declared: DeclaredSubmodules,
): string[][] {
    return [...declared.values()]
        .map((entry) => entry.path)
        .filter((path): path is string => !!path)
        .map((path) => buildSubmoduleInitArgs(repoCloneUrl, [path]));
}

/** `git` arguments that dump what the step above resolved. */
export const SUBMODULE_URL_DUMP_ARGS = [
    'config',
    '--get-regexp',
    '^submodule\\..*\\.url$',
];

/**
 * Build the `git submodule update` invocation for a checkout, or a plan with
 * no paths when there is nothing safe to fetch.
 *
 * `resolvedUrls` must come from `SUBMODULE_URL_DUMP_ARGS` run AFTER
 * `SUBMODULE_INIT_ARGS`. Passing an empty map rejects everything, which is the
 * correct failure mode: no resolution means no validation.
 */
export function buildSubmoduleUpdatePlan(params: {
    declared: DeclaredSubmodules;
    resolvedUrls: Map<string, string>;
    repoCloneUrl: string;
    /** The same header string the clone used; omitted for anonymous clones. */
    authHeader?: string;
}): SubmoduleUpdatePlan {
    const { declared, resolvedUrls, repoCloneUrl, authHeader } = params;
    const decisions = decideSubmodules(declared, resolvedUrls, repoCloneUrl);
    const paths = decisions.filter((d) => d.allowed).map((d) => d.path);
    const rejected = decisions.filter(
        (d): d is Extract<SubmoduleDecision, { allowed: false }> => !d.allowed,
    );
    const skipped = rejected.map(({ path, url, reason }) => ({
        path,
        url,
        reason,
    }));
    const cleanupArgs = rejected
        .filter((d) => d.name)
        .map((d) => ['config', '--remove-section', `submodule.${d.name}`]);

    const env: Record<string, string> = {};
    const configKey = authHeader
        ? scopedAuthHeaderConfigKey(repoCloneUrl)
        : null;
    if (authHeader && configKey) {
        env.GIT_CONFIG_COUNT = '1';
        env.GIT_CONFIG_KEY_0 = configKey;
        env.GIT_CONFIG_VALUE_0 = authHeader;
    }

    // No `--init`: the init step already ran, and re-running it here would
    // re-register the very sections `cleanupArgs` just removed.
    // `--depth=1` keeps a multi-submodule repository from pulling full history;
    // `--` separates the validated path from anything that could look like a
    // flag. No `--recursive` — see the module docstring.
    const updateArgs = paths.map((path) => [
        'submodule',
        'update',
        '--depth=1',
        '--',
        path,
    ]);
    const allowed = decisions.filter(
        (d): d is Extract<SubmoduleDecision, { allowed: true }> => d.allowed,
    );
    const deepRetry = allowed.map((d) => ({
        path: d.path,
        deinitArgs: ['submodule', 'deinit', '-f', '--', d.path],
        gitdirPath: `.git/modules/${d.name}`,
        initArgs: buildSubmoduleInitArgs(repoCloneUrl, [d.path]),
        updateArgs: ['submodule', 'update', '--', d.path],
    }));

    return { paths, skipped, cleanupArgs, updateArgs, deepRetry, env };
}

/**
 * The three things a sandbox has to be able to do for submodules to be
 * fetched. Everything else — the order, the retries, the time budget, what is
 * logged — lives in `fetchSubmodules` below, once, for both providers.
 *
 * The design for #1939 asked for the validation to live in one place so the
 * two providers could not drift. The sequence needs the same protection and
 * for the same reason: it is where the shallow/full retry, the gitdir cleanup
 * and the shared deadline live, and all three were found by running git, not
 * by reading it. Duplicated, they would drift the first time one provider is
 * edited alone.
 */
export interface SubmoduleGitHost {
    /** `.gitmodules` at the repo root, or null when the repository has none. */
    readGitmodules(): Promise<string | null>;
    /** Run `git <args>` at the repo root. Must reject on a non-zero exit. */
    git(
        args: string[],
        opts?: { timeoutMs?: number; env?: Record<string, string> },
    ): Promise<{ stdout: string }>;
    /** Recursively remove a repo-relative path. Must not throw if it is absent. */
    removeDir(repoRelativePath: string): Promise<void>;
}

/**
 * The logging surface this module needs, kept structural so both providers'
 * loggers satisfy it without this module importing either of them.
 */
export interface SubmoduleLogEntry {
    message: string;
    context: string;
    /** Typed as `Error` to match the providers' logger contract. */
    error?: Error;
    metadata?: Record<string, unknown>;
}

export interface SubmoduleLogger {
    log?: (entry: SubmoduleLogEntry) => void;
    warn?: (entry: SubmoduleLogEntry) => void;
}

export interface FetchSubmodulesParams {
    repoCloneUrl: string;
    /** The header the clone used; omitted for anonymous clones. */
    authHeader?: string;
    /** Budget for ALL submodules together, not per submodule. */
    totalBudgetMs: number;
    /** Ceiling for the cheap, local-only steps (init, config, deinit, rm). */
    stepTimeoutMs: number;
    logger?: SubmoduleLogger;
    logContext: string;
    /** Merged into every log entry — carries the pr number. */
    logMetadata?: Record<string, unknown>;
    now?: () => number;
}

export interface FetchSubmodulesResult {
    fetched: string[];
    failed: string[];
    skippedForTime: string[];
    skippedByPolicy: Array<{ path: string; url: string; reason: string }>;
}

/**
 * A fresh result object per return. Sharing one module-level value would hand
 * every caller the same arrays, and the docstring invites callers to assert on
 * what comes back.
 */
const emptyResult = (): FetchSubmodulesResult => ({
    fetched: [],
    failed: [],
    skippedForTime: [],
    skippedByPolicy: [],
});

/**
 * Populate the submodules a repository declares, as far as the rules and the
 * time budget allow.
 *
 * Best-effort by contract: a token with no access to a submodule repository
 * must degrade to "the agent is told the directory was never fetched"
 * (#1939's marker), never to a failed review. Nothing here throws.
 *
 * Returns what happened so a caller can assert on it; the logging is done
 * here so both providers say the same thing.
 */
export async function fetchSubmodules(
    host: SubmoduleGitHost,
    params: FetchSubmodulesParams,
): Promise<FetchSubmodulesResult> {
    const {
        repoCloneUrl,
        authHeader,
        totalBudgetMs,
        stepTimeoutMs,
        logger,
        logContext,
        logMetadata = {},
        now = () => Date.now(),
    } = params;

    const warn = (
        message: string,
        extra: Record<string, unknown> = {},
    ): void => {
        const { error, ...metadata } = extra;
        logger?.warn?.({
            message: `[SUBMODULES] ${message}`,
            context: logContext,
            // A rejected git command can throw anything; normalize so the
            // caller's logger always receives a real Error.
            ...(error
                ? {
                      error:
                          error instanceof Error
                              ? error
                              : new Error(String(error)),
                  }
                : {}),
            metadata: { ...logMetadata, ...metadata },
        });
    };

    // The budget covers EVERYTHING below, not just the update loop: a crafted
    // `.gitmodules` with thousands of sections would otherwise make the
    // per-path init fallback and the cleanup loop run thousands of sequential
    // commands before any deadline was consulted.
    const deadline = now() + totalBudgetMs;
    const remaining = () => deadline - now();
    /** Never let a cheap local step outlive what is left of the budget. */
    const stepMs = () => Math.min(stepTimeoutMs, Math.max(remaining(), 0));

    let gitmodules: string | null;
    try {
        gitmodules = await host.readGitmodules();
    } catch {
        gitmodules = null;
    }
    // No `.gitmodules` — the overwhelming majority of repositories, and the
    // whole cost they pay for this feature.
    if (!gitmodules || !gitmodules.trim()) return emptyResult();

    // Let GIT resolve the urls: `.gitmodules` usually holds relative ones and
    // git's resolution is not WHATWG URL resolution (see the module docstring).
    // `submodule init` only writes `.git/config` — no network yet.
    // What `.gitmodules` declares, read by GIT — never by a parser of our own,
    // which is how a crafted file got an unvalidated host past the same-host
    // rule (see SUBMODULE_DECLARED_DUMP_ARGS).
    let declared: DeclaredSubmodules;
    let resolvedUrls: Map<string, string>;
    try {
        const declaredDump = await host
            .git(SUBMODULE_DECLARED_DUMP_ARGS, { timeoutMs: stepMs() })
            .catch(() => ({ stdout: '' }));
        declared = parseDeclaredSubmodules(declaredDump.stdout || '');
        if (declared.size === 0) return emptyResult();

        try {
            await host.git(buildSubmoduleInitArgs(repoCloneUrl), {
                timeoutMs: stepMs(),
            });
        } catch {
            // One unresolvable url aborts the whole init, so retry per path:
            // a single broken entry must not unregister its siblings.
            for (const args of buildSubmoduleInitFallbackArgs(
                repoCloneUrl,
                declared,
            )) {
                if (remaining() <= 0) break;
                await host.git(args, { timeoutMs: stepMs() }).catch(() => null);
            }
        }
        // `git config --get-regexp` exits 1 when NOTHING matched, which is a
        // normal outcome, not a broken command. Continuing with an empty map
        // rather than bailing lets the plan report WHICH submodules were
        // skipped and why.
        const dump = await host
            .git(SUBMODULE_URL_DUMP_ARGS, { timeoutMs: stepMs() })
            .catch(() => ({ stdout: '' }));
        resolvedUrls = parseResolvedSubmoduleUrls(dump.stdout || '');
    } catch (error) {
        warn('Could not resolve submodule urls; none will be fetched', {
            error,
        });
        return emptyResult();
    }

    const plan = buildSubmoduleUpdatePlan({
        declared,
        resolvedUrls,
        repoCloneUrl,
        authHeader,
    });

    if (plan.skipped.length) {
        warn(
            `Skipped ${plan.skipped.length} submodule(s) that failed validation`,
            {
                skipped: plan.skipped,
            },
        );
    }

    // Drop every rejected url from the checkout's config, so the refusal
    // outlives this call — a later `git submodule update` in the same sandbox
    // must not be able to use it.
    for (const args of plan.cleanupArgs) {
        if (remaining() <= 0) break;
        await host.git(args, { timeoutMs: stepMs() }).catch(() => null);
    }

    if (!plan.updateArgs.length) {
        return { ...emptyResult(), skippedByPolicy: plan.skipped };
    }

    const fetched: string[] = [];
    const failed: string[] = [];
    const skippedForTime: string[] = [];

    for (let i = 0; i < plan.updateArgs.length; i++) {
        const args = plan.updateArgs[i];
        const path = args[args.length - 1];

        if (remaining() <= 0) {
            skippedForTime.push(path);
            continue;
        }
        try {
            await host.git(args, {
                timeoutMs: remaining(),
                env: plan.env,
            });
            fetched.push(path);
            continue;
        } catch {
            // Shallow failed. The usual cause is a pinned commit the server
            // will not serve unadvertised; a full fetch does reach it.
        }

        if (remaining() <= 0) {
            skippedForTime.push(path);
            continue;
        }
        const retry = plan.deepRetry[i];
        try {
            // Clear what the failed shallow attempt left behind, or the full
            // fetch reuses the same shallow gitdir and fails identically.
            await host
                .git(retry.deinitArgs, { timeoutMs: stepTimeoutMs })
                .catch(() => null);
            await host.removeDir(retry.gitdirPath).catch(() => undefined);
            await host.git(retry.initArgs, { timeoutMs: stepMs() });
            await host.git(retry.updateArgs, {
                timeoutMs: remaining(),
                env: plan.env,
            });
            fetched.push(path);
        } catch (error) {
            failed.push(path);
            warn(
                `Could not fetch ${path}; the review continues with it unpopulated`,
                { path, error },
            );
        }
    }

    if (skippedForTime.length) {
        warn(
            `Time budget exhausted; ${skippedForTime.length} submodule(s) left unpopulated`,
            { skippedForTime },
        );
    }
    logger?.log?.({
        message: `[SUBMODULES] Fetched ${fetched.length} of ${plan.updateArgs.length} submodule(s)`,
        context: logContext,
        metadata: { ...logMetadata, fetched, failed },
    });

    return { fetched, failed, skippedForTime, skippedByPolicy: plan.skipped };
}
