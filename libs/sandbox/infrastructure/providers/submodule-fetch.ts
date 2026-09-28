/**
 * Decide which submodules the review sandbox may fetch, and build the git
 * invocation that fetches them. Both providers call this one module.
 *
 * `.gitmodules` ships inside the pull request, so every value here is written
 * by whoever opened it. Four rules, in the order they bind:
 *
 * 1. ALREADY ON THE BASE BRANCH. Only a submodule whose declaration is
 *    byte-identical to the base branch's is fetched. Same host is not the
 *    same as authorized: the token is not scoped to the repository under
 *    review, so without this a fork PR could point it at any repository that
 *    token can read. See `baseDeclaredDumpArgs`.
 * 2. SAME HOST, SAME SCHEME, http(s) only — compared against the url GIT
 *    resolved, never one resolved here. `.gitmodules` usually holds a
 *    relative url and git's resolution is not WHATWG URL resolution, so the
 *    provider runs `git submodule init` first (config only, no network) and
 *    this module judges what git wrote. Still relative at that point is
 *    rejected. The scheme rule keeps `git://`, `ssh://` and `file://` out
 *    without rejecting the plaintext-http servers some self-hosted installs
 *    run.
 * 3. THE AUTH HEADER IS SCOPED to that host (`http.<origin>.extraHeader`),
 *    never global. With the global form a feasibility run captured the
 *    customer's token arriving verbatim at a foreign host named in
 *    `.gitmodules`; with the scoped key that host got no header at all.
 * 4. NO RECURSION. A nested `.gitmodules` has not been through these rules,
 *    so `--recursive` is deliberately absent. Nested submodules stay empty
 *    and the uninitialized-submodule marker explains them.
 *
 * A private/link-local IP check was considered and left out: it protects
 * nothing under rule 2 and would disable submodules for every self-hosted
 * customer, whose git server is on a private address by definition.
 *
 * The measurements behind each rule — git's relative-url resolution, the
 * captured token, the all-or-nothing behaviour of `submodule init` and
 * `submodule update`, the shallow-fetch recovery — are in the pull request
 * that introduced this file and in issue #1939.
 */

export type SubmoduleDecision =
    | {
          path: string;
          name: string;
          url: string;
          allowed: true;
          /** Set for a same-host ssh url fetched over https instead. */
          rewrite?: { key: string; value: string };
      }
    | {
          path: string;
          name: string;
          url: string;
          allowed: false;
          reason: string;
      };

/**
 * Dump what GIT reads out of `.gitmodules` — name, path and url all from
 * git's own config parser, never from a scanner here.
 *
 * git accepts a variable on the section-header line; a scanner that requires
 * a whole-line header pairs one submodule's path with another's url, which
 * walks the same-host rule straight past validation. The crafted file that
 * did it is in `submodule-fetch.spec.ts`.
 */
export const SUBMODULE_DECLARED_DUMP_ARGS = [
    'config',
    '-f',
    '.gitmodules',
    '--get-regexp',
    '^submodule\\.',
];

/**
 * Dump what `.gitmodules` declares ON THE BASE BRANCH, read from the blob by
 * git's own parser.
 *
 * Same host is not the same as authorized. The host check limits where git
 * connects, not which repositories the token may read, and the token is
 * scoped to neither: GitHub mints the installation token with no
 * `repositoryIds` (`github.service.ts`), GitLab clones with the integrating
 * user's OAuth token or PAT (`gitlab.service.ts`). Nothing in the pipeline
 * treats a fork pull request differently. So a fork PR could declare a
 * PRIVATE repository on the same host and have the sandbox fetch it for an
 * agent that quotes it back in a comment the fork author reads.
 *
 * Only a declaration byte-identical to the base branch's is fetched: that
 * content is already merged, and a pull request cannot change the base. One
 * it adds or edits stays unfetched until it merges, with the marker
 * explaining the empty directory meanwhile.
 */
export const baseDeclaredDumpArgs = (baseRef: string): string[] => [
    'config',
    '--blob',
    `${baseRef}:.gitmodules`,
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
/**
 * The ssh forms `.gitmodules` uses in practice, as {host, path}.
 *
 *   git@github.com:acme/x.git          scp-like, what most files carry
 *   ssh://git@github.com/acme/x.git    the explicit form
 *
 * Recognising them is not the same as using them: ssh bypasses the scoped
 * auth header and the proxy, so an ssh submodule is only ever fetched by
 * REWRITING it to https on the repository's own host (`url.<https>.insteadOf`
 * — see `sshRewriteFor`). Anything whose host is not the repository's is
 * refused exactly as before.
 */
function parseSshUrl(url: string): { host: string; prefix: string } | null {
    const raw = String(url || '').trim();
    if (!raw) return null;
    // ssh://[user@]host[:port]/path
    const explicit = /^ssh:\/\/(?:[^@/]+@)?([^/:]+(?::\d+)?)\//i.exec(raw);
    if (explicit) {
        return {
            host: explicit[1],
            prefix: raw.slice(0, explicit[0].length),
        };
    }
    // [user@]host:path. A single-label host is legitimate self-hosted
    // (`git@gitlab:acme/x.git`), so requiring a dot would reject exactly the
    // installs this feature exists for — and the `ssh://` branch above never
    // required one. Only two shapes are excluded: a url with a scheme, and a
    // Windows drive (`C:\repos\x`), which is the one other thing that looks
    // like `<token>:<path>`. Whether the host is the right one is decided by
    // the same-host comparison in `sshRewriteFor`, not here.
    if (raw.indexOf('://') !== -1) return null;
    if (/^[A-Za-z]:[\\/]/.test(raw)) return null;
    const scp = /^([^@/\s]+@)?([^@/:\s]+):(?!\/)/.exec(raw);
    if (scp) {
        return { host: scp[2], prefix: `${scp[1] ?? ''}${scp[2]}:` };
    }
    return null;
}

/**
 * The `url.<base>.insteadOf` pair that turns an ssh submodule on the
 * repository's own host into an https fetch, or null when it must not be
 * rewritten. Rewriting is only ever same-host and only onto https — the
 * scheme the clone itself used and the one the scoped header covers.
 */
export function sshRewriteFor(
    resolvedUrl: string,
    repoCloneUrl: string,
): { key: string; value: string } | null {
    const repo = parseResolvedUrl(repoCloneUrl);
    if (!repo || repo.protocol !== 'https:') return null;
    const ssh = parseSshUrl(resolvedUrl);
    if (!ssh) return null;
    if (ssh.host.toLowerCase() !== repo.host.toLowerCase()) return null;
    return {
        key: `url.https://${repo.host}/.insteadOf`,
        value: ssh.prefix,
    };
}

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
    // Both separators, and both absolute forms. `.gitmodules` is authored by
    // the pull request, the value is joined to a path this code then deletes,
    // and `path.join` on a win32 host resolves `..\..` exactly like `../..`.
    // Mirrors the guard at `local-sandbox.service.ts` on the exec path.
    if (/^[/\\]/.test(value)) return false; // POSIX absolute, and UNC `\\host`
    if (/^[a-zA-Z]:/.test(value)) return false; // win32 drive-relative or absolute
    const segments = value.split(/[/\\]/);
    return !segments.some((seg) => seg === '' || seg === '.' || seg === '..');
}

export function decideSubmodules(
    declared: DeclaredSubmodules,
    resolvedUrls: Map<string, string>,
    repoCloneUrl: string,
    /**
     * What `.gitmodules` declares on the BASE branch. `null` means it could
     * not be read, and then nothing is fetched — see `baseDeclaredDumpArgs`
     * for why this, and not the host check, is what bounds the token.
     */
    baseDeclared: DeclaredSubmodules | null,
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

    /** How many sections claim each path — see the check below. */
    const pathClaims = new Map<string, number>();
    for (const e of entries) {
        pathClaims.set(e.path, (pathClaims.get(e.path) ?? 0) + 1);
    }

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

        // One path, one section. Measured with git 2.51: when two sections
        // claim the same path, `submodule init` registers the LAST one and
        // only that one, so `resolvedUrls` describes the section git will
        // actually use and the losers are denied below for having no url.
        // That makes the ambiguity harmless today — but it is undocumented
        // git behaviour holding up a security boundary, and `update -- <path>`
        // and the deep retry's `init -- <path>` both re-resolve the path
        // through the pull request's own `.gitmodules`. Refusing the whole
        // path removes the class instead of relying on the tie-break.
        if ((pathClaims.get(entry.path) ?? 0) > 1) {
            return deny('path claimed by more than one submodule section');
        }
        // Already merged, or not fetched. See `baseDeclaredDumpArgs`: the
        // token is not scoped to the repository under review, so what a pull
        // request may point it at has to be bounded by what the base branch
        // already declares, not by the host alone.
        if (!baseDeclared) {
            return deny(
                'base branch .gitmodules could not be read, nothing fetched',
            );
        }
        const onBase = baseDeclared.get(entry.name);
        if (!onBase) {
            return deny('submodule added by this pull request, not fetched');
        }
        if (onBase.path !== entry.path || (onBase.url ?? '') !== entry.url) {
            return deny('submodule changed by this pull request, not fetched');
        }

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
            // `.gitmodules` very often carries `git@host:org/x.git`. Refusing
            // it outright leaves those repositories exactly as broken as
            // before the fix, so a SAME-HOST ssh url is rewritten to https
            // and fetched over the transport the clone already uses. Any
            // other host, or a non-https repository, still falls through to
            // the refusal below.
            const rewrite = sshRewriteFor(resolvedUrl, repoCloneUrl);
            if (rewrite) {
                return {
                    path: entry.path,
                    name: entry.name,
                    url: resolvedUrl,
                    allowed: true,
                    rewrite,
                };
            }
            return deny('not an http(s) URL (ssh/scp/git/file transport)');
        }
        if (!ALLOWED_PROTOCOLS.has(target.protocol)) {
            // `ssh://host/path` parses as a URL, so it lands here rather than
            // in the scp-like branch above. Same rule: same host, rewritten
            // onto https; anything else refused.
            const rewrite = sshRewriteFor(resolvedUrl, repoCloneUrl);
            if (rewrite) {
                return {
                    path: entry.path,
                    name: entry.name,
                    url: resolvedUrl,
                    allowed: true,
                    rewrite,
                };
            }
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
    /** What the BASE branch declares; `null` fetches nothing. */
    baseDeclared: DeclaredSubmodules | null;
    /** The same header string the clone used; omitted for anonymous clones. */
    authHeader?: string;
}): SubmoduleUpdatePlan {
    const { declared, resolvedUrls, repoCloneUrl, baseDeclared, authHeader } =
        params;
    const decisions = decideSubmodules(
        declared,
        resolvedUrls,
        repoCloneUrl,
        baseDeclared,
    );
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
    const configPairs: Array<{ key: string; value: string }> = [];
    if (authHeader && configKey) {
        configPairs.push({ key: configKey, value: authHeader });
    }
    // One `insteadOf` per distinct ssh prefix among the allowed submodules,
    // so git fetches them over https with the scoped header above instead of
    // over ssh, which has neither.
    for (const d of decisions) {
        if (!d.allowed || !d.rewrite) continue;
        const already = configPairs.some(
            (p) => p.key === d.rewrite!.key && p.value === d.rewrite!.value,
        );
        if (!already) configPairs.push(d.rewrite);
    }
    if (configPairs.length) {
        env.GIT_CONFIG_COUNT = String(configPairs.length);
        configPairs.forEach(({ key, value }, i) => {
            env[`GIT_CONFIG_KEY_${i}`] = key;
            env[`GIT_CONFIG_VALUE_${i}`] = value;
        });
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
    /**
     * Ref of the pull request's BASE branch, e.g. `origin/main`. Only a
     * submodule declared identically there is fetched — see
     * `baseDeclaredDumpArgs`. Omitted, or unreadable, means nothing is
     * fetched: the token this would use is not scoped to the repository
     * under review, so failing open would hand a pull request author a read
     * of any repository that token can reach.
     */
    baseRef?: string;
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
        baseRef,
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
    const startedAt = now();
    const deadline = startedAt + totalBudgetMs;
    const remaining = () => deadline - now();
    /**
     * Never let a cheap local step outlive what is left of the budget — and
     * never hand out 0: both `sandbox.commands.run` (E2B) and `execFile`
     * (node) read a 0 timeout as NO timeout, so an exhausted budget would
     * remove the limit instead of enforcing it. 1ms kills on the spot, which
     * is what an exhausted budget means.
     */
    const stepMs = () =>
        Math.max(1, Math.min(stepTimeoutMs, Math.max(remaining(), 0)));

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
    /** null until read; stays null without a base ref, which fetches nothing. */
    let baseDeclared: DeclaredSubmodules | null = null;
    try {
        const declaredDump = await host
            .git(SUBMODULE_DECLARED_DUMP_ARGS, { timeoutMs: stepMs() })
            .catch(() => ({ stdout: '' }));
        declared = parseDeclaredSubmodules(declaredDump.stdout || '');
        if (declared.size === 0) return emptyResult();

        // What the BASE branch declares. Read through git's own parser, from
        // the blob, so no temp file and no second parser. A repository with
        // no `.gitmodules` on the base exits non-zero here, which is the same
        // answer as "nothing was merged": an empty declaration.
        if (baseRef) {
            // Resolve the ref first, so "the base declares no submodule" and
            // "the base ref is not in this sandbox" are not the same answer.
            // Both fetch nothing; only the second is a problem to look into,
            // and the log has to say which one happened.
            const refPresent = await host
                .git(
                    ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`],
                    {
                        timeoutMs: stepMs(),
                    },
                )
                .then(() => true)
                .catch(() => false);
            if (refPresent) {
                const baseDump = await host
                    .git(baseDeclaredDumpArgs(baseRef), { timeoutMs: stepMs() })
                    .catch(() => ({ stdout: '' }));
                baseDeclared = parseDeclaredSubmodules(baseDump.stdout || '');
            } else {
                warn(
                    `Base ref ${baseRef} is not in the sandbox; no submodule will be fetched`,
                    { baseRef },
                );
            }
        }

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
        baseDeclared,
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
        message: `[SUBMODULES] Fetched ${fetched.length} of ${plan.updateArgs.length} submodule(s) in ${
            now() - startedAt
        }ms`,
        context: logContext,
        // `durationMs` is the number to watch after rollout: this step is new
        // latency on every sandbox create AND on every reconnect round, and
        // the full-history retry has no size cap.
        metadata: {
            ...logMetadata,
            fetched,
            failed,
            durationMs: now() - startedAt,
        },
    });

    return { fetched, failed, skippedForTime, skippedByPolicy: plan.skipped };
}
