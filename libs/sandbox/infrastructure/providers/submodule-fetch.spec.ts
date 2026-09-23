import {
    buildSubmoduleInitArgs,
    buildSubmoduleInitFallbackArgs,
    parseDeclaredSubmodules,
    parseResolvedSubmoduleUrls,
    decideSubmodules,
    scopedAuthHeaderConfigKey,
    buildSubmoduleUpdatePlan,
    isContainedRelativePath,
} from './submodule-fetch';

/**
 * #1939 Step 3 — which submodules the sandbox may fetch.
 *
 * `.gitmodules` ships inside the pull request, so every url here is authored by
 * whoever opened it. Two properties must hold no matter what they write:
 *   1. git is only ever sent to the host the review already fetched the PR from;
 *   2. the customer's git token is scoped to that host and reaches nothing else.
 *
 * Property 2 is not theoretical: with the GLOBAL `http.extraHeader` the clone
 * paths use, a feasibility run captured the token arriving verbatim at a
 * foreign host named in `.gitmodules`.
 */

const REPO = 'https://github.com/acme/app.git';
const AUTH = 'Authorization: Basic eC1hY2Nlc3MtdG9rZW46U0VDUkVU';

/** What `git config -f .gitmodules --get-regexp '^submodule\\.'` prints. */
const gitmodules = (...blocks: Array<[string, string]>) =>
    parseDeclaredSubmodules(
        blocks
            .map(
                ([p, url]) =>
                    `submodule.${p}.path ${p}\nsubmodule.${p}.url ${url}\n`,
            )
            .join(''),
    );

/**
 * Stands in for `git submodule init` + `git config --get-regexp`: the url GIT
 * resolved, per submodule name. Repeating the `.gitmodules` value models an
 * ABSOLUTE url, which git copies through unchanged.
 */
const resolvedAs = (...blocks: Array<[string, string]>) =>
    new Map(blocks.map(([name, url]) => [name, url]));

const decideOne = (
    declaredUrl: string,
    opts: { resolved?: string; repo?: string } = {},
) =>
    decideSubmodules(
        gitmodules(['pkg/sub', declaredUrl]),
        resolvedAs(['pkg/sub', opts.resolved ?? declaredUrl]),
        opts.repo ?? REPO,
    )[0];

describe('parseDeclaredSubmodules', () => {
    it('reads name, path and url out of what git printed', () => {
        const declared = parseDeclaredSubmodules(
            'submodule.packages/commons.path packages/commons\n' +
                'submodule.packages/commons.url https://github.com/acme/commons.git\n',
        );
        expect(declared.get('packages/commons')).toEqual({
            path: 'packages/commons',
            url: 'https://github.com/acme/commons.git',
        });
    });

    it('handles a submodule name containing dots', () => {
        const declared = parseDeclaredSubmodules(
            'submodule.pkg/a.b.path vendor/ab\n' +
                'submodule.pkg/a.b.url https://github.com/acme/ab.git\n',
        );
        expect(declared.get('pkg/a.b')).toEqual({
            path: 'vendor/ab',
            url: 'https://github.com/acme/ab.git',
        });
    });

    it('ignores keys other than path and url', () => {
        const declared = parseDeclaredSubmodules(
            'submodule.x.branch main\n' +
                'submodule.x.update checkout\n' +
                'submodule.x.path vendor/x\n',
        );
        expect(declared.get('x')).toEqual({ path: 'vendor/x' });
    });

    /**
     * Regression — a hand-written scanner let a crafted `.gitmodules` through.
     *
     * `.gitmodules` is authored by whoever opened the pull request. This file
     * declares TWO submodules; git's config parser accepts a variable on the
     * same line as the section header, so it reads:
     *
     *     [submodule "b"]
     *         path = vendor/good
     *         url  = https://github.com/acme/good.git
     *     [submodule "a"] url = https://evil.example/e.git
     *         path = vendor/evil
     *
     * as b{vendor/good, github} AND a{vendor/evil, evil.example}. A scanner
     * that only recognises a header occupying the whole line skipped `a`'s
     * header and attached `path = vendor/evil` to `b`, producing the single
     * entry {name: 'b', path: 'vendor/evil', url: github/good.git} — allowed.
     * `git submodule update -- vendor/evil` then fetched from evil.example
     * using a's registered url, and cleanup never saw `submodule.a`.
     *
     * The dump below is the real output of
     * `git config -f .gitmodules --get-regexp '^submodule\.'` on that file.
     */
    const CRAFTED_DUMP =
        'submodule.b.path vendor/good\n' +
        'submodule.b.url https://github.com/acme/good.git\n' +
        'submodule.a.url https://evil.example/e.git\n' +
        'submodule.a.path vendor/evil\n';

    /** Both urls are absolute, so `git submodule init` registers them as-is. */
    const CRAFTED_RESOLVED = parseResolvedSubmoduleUrls(
        'submodule.b.url https://github.com/acme/good.git\n' +
            'submodule.a.url https://evil.example/e.git\n',
    );

    it('sees BOTH submodules a crafted .gitmodules declares', () => {
        const declared = parseDeclaredSubmodules(CRAFTED_DUMP);
        expect([...declared.entries()]).toEqual([
            [
                'b',
                {
                    path: 'vendor/good',
                    url: 'https://github.com/acme/good.git',
                },
            ],
            ['a', { path: 'vendor/evil', url: 'https://evil.example/e.git' }],
        ]);
    });

    it('refuses the foreign-host path instead of attaching it to the allowed one', () => {
        const decisions = decideSubmodules(
            parseDeclaredSubmodules(CRAFTED_DUMP),
            CRAFTED_RESOLVED,
            REPO,
        );
        const evil = decisions.find((d) => d.path === 'vendor/evil');
        expect(evil).toMatchObject({ name: 'a', allowed: false });
        const good = decisions.find((d) => d.path === 'vendor/good');
        expect(good).toMatchObject({ name: 'b', allowed: true });
    });

    it('fetches only vendor/good and unregisters the refused section', () => {
        const plan = buildSubmoduleUpdatePlan({
            declared: parseDeclaredSubmodules(CRAFTED_DUMP),
            resolvedUrls: CRAFTED_RESOLVED,
            repoCloneUrl: REPO,
            authHeader: AUTH,
        });
        expect(plan.paths).toEqual(['vendor/good']);
        expect(plan.updateArgs).toEqual([
            ['submodule', 'update', '--depth=1', '--', 'vendor/good'],
        ]);
        expect(plan.cleanupArgs).toEqual([
            ['config', '--remove-section', 'submodule.a'],
        ]);
        // Nothing that RUNS mentions the foreign host; only the skip reason,
        // which is the log line telling the operator what was refused.
        expect(
            JSON.stringify([plan.updateArgs, plan.deepRetry, plan.env]),
        ).not.toContain('evil.example');
        expect(plan.skipped[0].reason).toContain('evil.example');
    });
});

describe('parseResolvedSubmoduleUrls', () => {
    it('reads what `git config --get-regexp` printed', () => {
        const map = parseResolvedSubmoduleUrls(
            'submodule.packages/commons.url https://github.com/acme/commons.git\n' +
                'submodule.packages/brain.url https://github.com/acme/brain.git\n',
        );
        expect(map.get('packages/commons')).toBe(
            'https://github.com/acme/commons.git',
        );
        expect(map.get('packages/brain')).toBe(
            'https://github.com/acme/brain.git',
        );
    });

    it('handles a submodule name containing dots', () => {
        const map = parseResolvedSubmoduleUrls(
            'submodule.pkg/a.b.c.url https://github.com/acme/abc.git\n',
        );
        expect(map.get('pkg/a.b.c')).toBe('https://github.com/acme/abc.git');
    });

    it('ignores unrelated config keys', () => {
        const map = parseResolvedSubmoduleUrls(
            'submodule.x.branch main\nremote.origin.url https://h/r.git\n',
        );
        expect(map.size).toBe(0);
    });
});

/**
 * The reason this module validates git's OUTPUT instead of resolving relative
 * urls itself. Every "git resolves to" value below was measured against git
 * with origin https://github.com/acme/app.git — they are NOT what WHATWG URL
 * resolution produces, and the third row is the one that matters: resolving it
 * here would have approved "same host github.com" while git went to a
 * different transport entirely.
 */
describe('decideSubmodules — relative urls are judged on what git resolved', () => {
    it('`../commons.git` → https://github.com/acme/commons.git (allowed)', () => {
        expect(
            decideOne('../commons.git', {
                resolved: 'https://github.com/acme/commons.git',
            }).allowed,
        ).toBe(true);
    });

    it('`../../commons.git` → https://github.com/commons.git (allowed, still same host)', () => {
        expect(
            decideOne('../../commons.git', {
                resolved: 'https://github.com/commons.git',
            }).allowed,
        ).toBe(true);
    });

    it('an over-deep `../` chain → git produces the scp-like `.:evil.example/x.git` (rejected)', () => {
        const d = decideOne('../../../../../../evil.example/x.git', {
            resolved: '.:evil.example/x.git',
        });
        expect(d.allowed).toBe(false);
        expect((d as any).reason).toMatch(/not an http\(s\) URL/);
    });

    it('rejects a url that is STILL relative — unresolved means unvalidated', () => {
        const d = decideOne('../commons.git', { resolved: '../commons.git' });
        expect(d.allowed).toBe(false);
    });

    it('rejects a submodule git never resolved at all', () => {
        const d = decideSubmodules(
            gitmodules(['pkg/sub', '../commons.git']),
            new Map(),
            REPO,
        )[0];
        expect(d.allowed).toBe(false);
        expect((d as any).reason).toMatch(/did not resolve/);
    });
});

describe('decideSubmodules — same host is the only thing allowed', () => {
    it('allows a submodule on the repository host', () => {
        expect(decideOne('https://github.com/acme/commons.git')).toMatchObject({
            path: 'pkg/sub',
            allowed: true,
        });
    });

    it('skips a different host', () => {
        const d = decideOne('https://evil.example/acme/commons.git');
        expect(d.allowed).toBe(false);
        expect((d as any).reason).toMatch(/external submodule host, skipped/);
    });

    it('skips a look-alike host that merely starts with the repo host', () => {
        expect(
            decideOne('https://github.com.evil.example/acme/x.git').allowed,
        ).toBe(false);
    });

    it('skips a different port on the same hostname', () => {
        expect(
            decideOne('https://git.internal:9999/acme/x.git', {
                repo: 'https://git.internal:8443/acme/app.git',
            }).allowed,
        ).toBe(false);
    });

    it('treats userinfo as noise, not as a different host', () => {
        expect(
            decideOne('https://attacker@github.com/acme/x.git').allowed,
        ).toBe(true);
    });
});

describe('decideSubmodules — transports that bypass the header and the proxy', () => {
    it.each([
        ['git://github.com/acme/x.git', 'git protocol'],
        ['ssh://git@github.com/acme/x.git', 'ssh url'],
        ['git@github.com:acme/x.git', 'scp-like syntax'],
        ['file:///etc/passwd', 'file url'],
        ['/srv/local/repo.git', 'bare local path'],
    ])('skips %s (%s)', (url) => {
        expect(decideOne(url).allowed).toBe(false);
    });

    it('skips http when the repository itself is https', () => {
        const d = decideOne('http://github.com/acme/x.git');
        expect(d.allowed).toBe(false);
        expect((d as any).reason).toMatch(/scheme/);
    });

    it('allows http when the repository itself is http (self-hosted plaintext)', () => {
        expect(
            decideOne('http://git.internal/acme/x.git', {
                repo: 'http://git.internal/acme/app.git',
            }).allowed,
        ).toBe(true);
    });
});

describe('decideSubmodules — a private git server is the NORMAL case self-hosted', () => {
    // Deliberate: rejecting private/link-local ranges would disable submodules
    // for every self-hosted customer, and under the same-host rule the only
    // reachable target is the git server the review already fetched from.
    it('allows a same-host submodule on a private address', () => {
        expect(
            decideOne('https://10.0.3.9/acme/x.git', {
                repo: 'https://10.0.3.9/acme/app.git',
            }).allowed,
        ).toBe(true);
    });

    it('still skips a DIFFERENT private address', () => {
        expect(
            decideOne('https://169.254.169.254/latest/meta-data', {
                repo: 'https://10.0.3.9/acme/app.git',
            }).allowed,
        ).toBe(false);
    });
});

describe('decideSubmodules — the NAME reaches `rm -rf .git/modules/<name>`', () => {
    /**
     * On the deep retry a submodule's name is joined to `.git/modules/` and
     * handed to `removeDir`: `rm -rf` on E2B, a recursive `rm` on the
     * self-hosted customer's own machine. `.gitmodules` ships inside the pull
     * request, so the name is attacker-authored.
     *
     * Measured against git 2.51: git refuses such a name itself
     * ("ignoring suspicious submodule name", the CVE-2018-11235 fix) and
     * registers nothing, so `resolvedUrls` comes back empty and the entry is
     * denied for a different reason. That is git's guarantee, not this
     * module's — these cases pin the guarantee here, where the delete is.
     */
    const decideNamed = (name: string, path = 'vendor/x') =>
        decideSubmodules(
            parseDeclaredSubmodules(
                `submodule.${name}.path ${path}\n` +
                    `submodule.${name}.url https://github.com/acme/x.git\n`,
            ),
            new Map([[name, 'https://github.com/acme/x.git']]),
            REPO,
        )[0];

    it.each([
        ['../../../../tmp/pwned'],
        ['a/../../../tmp/pwned'],
        ['./../../tmp/q'],
        ['x/./../../tmp/p'],
        ['/etc/cron.d'],
        ['a//b'],
        ['..\\..\\..\\..\\tmp\\pwned'],
        ['a\\..\\..\\x'],
        ['C:\\Windows\\Temp'],
    ])('refuses the name %s', (name) => {
        const d = decideNamed(name);
        expect(d.allowed).toBe(false);
        expect((d as any).reason).toMatch(/escapes/);
    });

    it('an ordinary name is still allowed', () => {
        expect(decideNamed('commons-mod').allowed).toBe(true);
    });

    it('a name that differs from the path is still allowed', () => {
        const d = decideNamed('commons-mod', 'packages/commons');
        expect(d.allowed).toBe(true);
        expect(d.path).toBe('packages/commons');
    });

    it('an interior `..` in the PATH is refused too, not just a leading one', () => {
        const d = decideNamed('ok', 'vendor/a/../../../tmp/pwned');
        expect(d.allowed).toBe(false);
        expect((d as any).reason).toMatch(/escapes the repository/);
    });

    it('no deep-retry entry is built for a refused name', () => {
        const name = '../../../../tmp/pwned';
        const plan = buildSubmoduleUpdatePlan({
            declared: parseDeclaredSubmodules(
                `submodule.${name}.path vendor/x\n` +
                    `submodule.${name}.url https://github.com/acme/x.git\n`,
            ),
            resolvedUrls: new Map([[name, 'https://github.com/acme/x.git']]),
            repoCloneUrl: REPO,
            authHeader: AUTH,
        });
        expect(plan.deepRetry).toEqual([]);
        expect(plan.updateArgs).toEqual([]);
        expect(JSON.stringify(plan.deepRetry)).not.toContain('..');
    });
});

describe('isContainedRelativePath', () => {
    it.each([
        ['packages/commons', true],
        ['a', true],
        ['a/b/c', true],
        ['..', false],
        ['../x', false],
        ['a/../b', false],
        ['a/./b', false],
        ['/abs', false],
        ['a//b', false],
        ['', false],
        // Windows separators: `path.join` resolves `..\\..` on a win32 host
        // exactly like `../..`, and the name is never normalized.
        ['..\\x', false],
        ['a\\..\\..\\x', false],
        ['..\\..\\..\\..\\tmp\\pwned', false],
        ['\\\\server\\share', false],
        ['C:\\Windows', false],
        ['c:x', false],
        ['/etc', false],
    ])('%s -> %s', (value, expected) => {
        expect(isContainedRelativePath(value as string)).toBe(expected);
    });
});

describe('decideSubmodules — path safety', () => {
    it('skips a path escaping the repository', () => {
        const d = decideSubmodules(
            parseDeclaredSubmodules(
                'submodule.x.path ../../etc\nsubmodule.x.url https://github.com/acme/x.git\n',
            ),
            resolvedAs(['x', 'https://github.com/acme/x.git']),
            REPO,
        )[0];
        expect(d.allowed).toBe(false);
        expect((d as any).reason).toMatch(/escapes/);
    });
});

/**
 * The rules are by host and scheme, never by a platform API — so every code
 * platform Kodus supports has to behave the same. These are the real clone-url
 * shapes each one hands the sandbox, including Azure DevOps' userinfo form
 * (`https://org@dev.azure.com/...`), which `URL.host` drops: git still sends a
 * host-scoped `extraHeader` to a url carrying userinfo (verified against git),
 * so dropping it is correct.
 */
describe('every code platform: same host allowed, foreign host skipped', () => {
    const PLATFORMS: Array<[string, string, string, string]> = [
        // [name, repo clone url, a same-host submodule, the expected scope key]
        [
            'GitHub',
            'https://github.com/acme/app.git',
            'https://github.com/acme/commons.git',
            'http.https://github.com/.extraHeader',
        ],
        [
            'GitHub Enterprise',
            'https://github.acme-corp.com/acme/app.git',
            'https://github.acme-corp.com/acme/commons.git',
            'http.https://github.acme-corp.com/.extraHeader',
        ],
        [
            'GitLab SaaS (nested groups)',
            'https://gitlab.com/group/subgroup/app.git',
            'https://gitlab.com/group/subgroup/commons.git',
            'http.https://gitlab.com/.extraHeader',
        ],
        [
            'GitLab self-hosted on a port',
            'https://gitlab.acme.internal:8443/group/app.git',
            'https://gitlab.acme.internal:8443/group/commons.git',
            'http.https://gitlab.acme.internal:8443/.extraHeader',
        ],
        [
            'Bitbucket Cloud',
            'https://bitbucket.org/workspace/app.git',
            'https://bitbucket.org/workspace/commons.git',
            'http.https://bitbucket.org/.extraHeader',
        ],
        [
            'Bitbucket Server',
            'https://bitbucket.acme.com/scm/proj/app.git',
            'https://bitbucket.acme.com/scm/proj/commons.git',
            'http.https://bitbucket.acme.com/.extraHeader',
        ],
        [
            'Azure DevOps',
            'https://dev.azure.com/acme/project/_git/app',
            'https://dev.azure.com/acme/project/_git/commons',
            'http.https://dev.azure.com/.extraHeader',
        ],
        [
            'Azure DevOps with userinfo',
            'https://acme@dev.azure.com/acme/project/_git/app',
            'https://dev.azure.com/acme/project/_git/commons',
            'http.https://dev.azure.com/.extraHeader',
        ],
        [
            'Azure DevOps legacy host',
            'https://acme.visualstudio.com/project/_git/app',
            'https://acme.visualstudio.com/project/_git/commons',
            'http.https://acme.visualstudio.com/.extraHeader',
        ],
        [
            'Forgejo / Gitea self-hosted',
            'https://git.acme.internal/acme/app.git',
            'https://git.acme.internal/acme/commons.git',
            'http.https://git.acme.internal/.extraHeader',
        ],
    ];

    it.each(PLATFORMS)(
        '%s: a submodule on the repo host is fetched',
        (_name, repo, sub) => {
            expect(decideOne(sub, { repo }).allowed).toBe(true);
        },
    );

    it.each(PLATFORMS)(
        '%s: a submodule on another host is skipped',
        (_name, repo) => {
            const d = decideOne('https://evil.example/acme/x.git', { repo });
            expect(d.allowed).toBe(false);
            expect((d as any).reason).toMatch(/external submodule host/);
        },
    );

    it.each(PLATFORMS)(
        '%s: the auth header is scoped to that host, never global',
        (_name, repo, _sub, key) => {
            expect(scopedAuthHeaderConfigKey(repo)).toBe(key);
            expect(scopedAuthHeaderConfigKey(repo)).not.toBe(
                'http.extraHeader',
            );
        },
    );

    it.each(PLATFORMS)(
        '%s: whatever Authorization the clone built is what gets scoped',
        (_name, repo, sub) => {
            // Each platform builds a different header (x-access-token for
            // GitHub, oauth2 for GitLab/Azure, the app-password or ATATT user
            // for Bitbucket). This module must carry it through untouched.
            const header = `Authorization: Basic ${Buffer.from(
                `whatever-${_name}:secret`,
            ).toString('base64')}`;
            const plan = buildSubmoduleUpdatePlan({
                declared: gitmodules(['pkg/sub', sub]),
                resolvedUrls: resolvedAs(['pkg/sub', sub]),
                repoCloneUrl: repo,
                authHeader: header,
            });
            expect(plan.env.GIT_CONFIG_VALUE_0).toBe(header);
            expect(plan.updateArgs).toHaveLength(1);
        },
    );
});

describe('buildSubmoduleInitArgs', () => {
    it('supplies remote.origin.url so git can resolve a relative url', () => {
        // Without it git warns "Assuming this repository is its own
        // authoritative upstream" and resolves `../commons.git` to a local
        // path — the local provider never adds an `origin` remote.
        expect(buildSubmoduleInitArgs(REPO)).toEqual([
            '-c',
            `remote.origin.url=${REPO}`,
            'submodule',
            'init',
        ]);
    });

    it('does not fetch anything — init only writes .git/config', () => {
        expect(buildSubmoduleInitArgs(REPO)).not.toContain('update');
    });

    it('can be narrowed to one path', () => {
        expect(buildSubmoduleInitArgs(REPO, ['pkg/a'])).toEqual([
            '-c',
            `remote.origin.url=${REPO}`,
            'submodule',
            'init',
            '--',
            'pkg/a',
        ]);
    });
});

describe('buildSubmoduleInitFallbackArgs', () => {
    // `git submodule init` is all-or-nothing: measured, one unresolvable url
    // makes it exit 128 with "cannot strip one component off url '.'" and NO
    // submodule gets registered. Without a per-path retry, a repository with
    // three good submodules and one broken entry fetched none of them.
    it('emits one init per declared path', () => {
        const args = buildSubmoduleInitFallbackArgs(
            REPO,
            gitmodules(
                ['packages/commons', 'https://github.com/acme/commons.git'],
                ['packages/broken', '../../../../../../evil.example/x.git'],
            ),
        );
        expect(args).toEqual([
            [
                '-c',
                `remote.origin.url=${REPO}`,
                'submodule',
                'init',
                '--',
                'packages/commons',
            ],
            [
                '-c',
                `remote.origin.url=${REPO}`,
                'submodule',
                'init',
                '--',
                'packages/broken',
            ],
        ]);
    });

    it('emits nothing for a repository with no submodules', () => {
        expect(buildSubmoduleInitFallbackArgs(REPO, new Map())).toEqual([]);
    });
});

describe('buildSubmoduleUpdatePlan — recovery from a failed shallow fetch', () => {
    const planFor2 = (blocks: Array<[string, string]>) =>
        buildSubmoduleUpdatePlan({
            declared: gitmodules(...blocks),
            resolvedUrls: resolvedAs(...blocks),
            repoCloneUrl: REPO,
            authHeader: AUTH,
        });

    it('clears the shallow gitdir before retrying full — retrying in place fails identically', () => {
        const plan = planFor2([
            ['packages/commons', 'https://github.com/acme/commons.git'],
        ]);
        expect(plan.deepRetry).toHaveLength(1);
        const r = plan.deepRetry[0];
        expect(r.deinitArgs).toEqual([
            'submodule',
            'deinit',
            '-f',
            '--',
            'packages/commons',
        ]);
        expect(r.gitdirPath).toBe('.git/modules/packages/commons');
        expect(r.updateArgs).toEqual([
            'submodule',
            'update',
            '--',
            'packages/commons',
        ]);
    });

    it('the retry is NOT shallow — that is the whole point', () => {
        const plan = planFor2([['pkg/sub', 'https://github.com/acme/x.git']]);
        expect(plan.deepRetry[0].updateArgs).not.toContain('--depth=1');
    });

    it('the retry re-registers with the origin, so a relative url still resolves', () => {
        const plan = planFor2([['pkg/sub', 'https://github.com/acme/x.git']]);
        expect(plan.deepRetry[0].initArgs).toContain(
            `remote.origin.url=${REPO}`,
        );
    });

    it('lines up index-for-index with updateArgs', () => {
        const plan = planFor2([
            ['packages/commons', 'https://github.com/acme/commons.git'],
            ['packages/brain', 'https://github.com/acme/brain.git'],
        ]);
        plan.updateArgs.forEach((args, i) => {
            expect(plan.deepRetry[i].path).toBe(args[args.length - 1]);
        });
    });

    it('a rejected submodule gets no recovery entry', () => {
        const plan = planFor2([
            ['packages/commons', 'https://github.com/acme/commons.git'],
            ['packages/evil', 'https://evil.example/x.git'],
        ]);
        expect(plan.deepRetry.map((r) => r.path)).toEqual(['packages/commons']);
    });
});

describe('scopedAuthHeaderConfigKey', () => {
    it('scopes to the repository origin, not globally', () => {
        expect(scopedAuthHeaderConfigKey(REPO)).toBe(
            'http.https://github.com/.extraHeader',
        );
    });

    it('keeps a non-default port in the scope', () => {
        expect(
            scopedAuthHeaderConfigKey('https://git.internal:8443/a/b.git'),
        ).toBe('http.https://git.internal:8443/.extraHeader');
    });

    it('is never the global key', () => {
        expect(scopedAuthHeaderConfigKey(REPO)).not.toBe('http.extraHeader');
    });
});

describe('buildSubmoduleUpdatePlan', () => {
    const planFor = (
        blocks: Array<[string, string]>,
        opts: { authHeader?: string } = { authHeader: AUTH },
    ) =>
        buildSubmoduleUpdatePlan({
            declared: gitmodules(...blocks),
            resolvedUrls: resolvedAs(...blocks),
            repoCloneUrl: REPO,
            authHeader: opts.authHeader,
        });

    it('fetches only the allowed paths and reports the rest', () => {
        const plan = planFor([
            ['packages/commons', 'https://github.com/acme/commons.git'],
            ['packages/evil', 'https://evil.example/x.git'],
            ['packages/ssh', 'git@github.com:acme/y.git'],
        ]);
        expect(plan.paths).toEqual(['packages/commons']);
        expect(plan.skipped.map((s) => s.path)).toEqual([
            'packages/evil',
            'packages/ssh',
        ]);
        expect(plan.updateArgs).toEqual([
            ['submodule', 'update', '--depth=1', '--', 'packages/commons'],
        ]);
    });

    it('removes every rejected url from the checkout config', () => {
        const plan = planFor([
            ['packages/commons', 'https://github.com/acme/commons.git'],
            ['packages/evil', 'https://evil.example/x.git'],
        ]);
        expect(plan.cleanupArgs).toEqual([
            ['config', '--remove-section', 'submodule.packages/evil'],
        ]);
    });

    it('leaves an allowed submodule registered', () => {
        const plan = planFor([
            ['packages/commons', 'https://github.com/acme/commons.git'],
        ]);
        expect(plan.cleanupArgs).toEqual([]);
    });

    it('never re-inits — that would restore the sections just removed', () => {
        const plan = planFor([['pkg/sub', 'https://github.com/acme/x.git']]);
        expect(plan.updateArgs[0]).not.toContain('--init');
    });

    it('never recurses — a nested .gitmodules has not been validated', () => {
        const plan = planFor([['pkg/sub', 'https://github.com/acme/x.git']]);
        expect(plan.updateArgs[0]).not.toContain('--recursive');
    });

    it('emits ONE command per submodule, never one listing them all', () => {
        // `git submodule update` aborts at the first submodule it cannot
        // clone and never reaches the rest, so batching lets an inaccessible
        // submodule take the accessible ones with it.
        const plan = planFor([
            ['packages/commons', 'https://github.com/acme/commons.git'],
            ['packages/brain', 'https://github.com/acme/brain.git'],
        ]);
        expect(plan.updateArgs).toEqual([
            ['submodule', 'update', '--depth=1', '--', 'packages/commons'],
            ['submodule', 'update', '--depth=1', '--', 'packages/brain'],
        ]);
    });

    it('runs NOTHING when every submodule was skipped', () => {
        const plan = planFor([['pkg/sub', 'https://evil.example/x.git']]);
        expect(plan.paths).toEqual([]);
        expect(plan.updateArgs).toEqual([]);
    });

    it('runs nothing for a repository with no .gitmodules', () => {
        expect(
            buildSubmoduleUpdatePlan({
                declared: new Map(),
                resolvedUrls: new Map(),
                repoCloneUrl: REPO,
                authHeader: AUTH,
            }).updateArgs,
        ).toEqual([]);
    });

    it('fails closed when the resolution step produced nothing', () => {
        const plan = buildSubmoduleUpdatePlan({
            declared: gitmodules(['pkg/sub', 'https://github.com/acme/x.git']),
            resolvedUrls: new Map(),
            repoCloneUrl: REPO,
            authHeader: AUTH,
        });
        expect(plan.paths).toEqual([]);
    });

    it('carries the token as a SCOPED config value, never as an argument', () => {
        const plan = planFor([['pkg/sub', 'https://github.com/acme/x.git']]);
        expect(plan.env).toEqual({
            GIT_CONFIG_COUNT: '1',
            GIT_CONFIG_KEY_0: 'http.https://github.com/.extraHeader',
            GIT_CONFIG_VALUE_0: AUTH,
        });
        expect(JSON.stringify(plan.updateArgs)).not.toContain(AUTH);
        expect(plan.env.GIT_CONFIG_KEY_0).not.toBe('http.extraHeader');
    });

    it('emits no auth config at all for an anonymous clone', () => {
        const plan = planFor([['pkg/sub', 'https://github.com/acme/x.git']], {
            authHeader: undefined,
        });
        expect(plan.env).toEqual({});
    });

    it('the token is absent from everything built for a foreign-host submodule', () => {
        const plan = planFor([['pkg/sub', 'https://evil.example/x.git']]);
        expect(plan.updateArgs).toEqual([]);
        expect(JSON.stringify(plan.skipped)).not.toContain(AUTH);
    });
});
