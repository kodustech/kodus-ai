import type { FailureBundle } from '@libs/runtime/protocol';

import { classifyBlocker, matchedBlockerLine, notReadyWaited } from '../catalog';

const bundle = (over: Partial<FailureBundle> = {}): FailureBundle => ({
    services: [],
    ports: [],
    disk: [],
    deniedEgress: [],
    redactions: 0,
    truncated: false,
    collectedAt: '2026-11-03T12:00:00.000Z',
    ...over,
});
const logs = (name: string, ...logTail: string[]) => bundle({ services: [{ name, state: 'exited', logTail }] });
const composeUp = (b: FailureBundle) => ({
    kind: 'toolchain',
    signature: 'compose_up',
    message: 'compose up: exit 1',
    bundle: b,
});

describe('classifyBlocker', () => {
    it('reads a missing env var from the logs and offers a test value through the recipe', () => {
        const c = classifyBlocker(composeUp(logs('api', 'booting', 'Error: Missing required environment variable: STRIPE_SECRET_KEY')));
        expect(c).toMatchObject({
            kind: 'missing_env',
            signature: 'missing_env:STRIPE_SECRET_KEY',
            evidence: { service: 'api' },
        });
        expect(c.fixes[0]).toMatchObject({
            action: 'set_env',
            who: 'dev',
            recipeChange: {
                path: ['env', 'STRIPE_SECRET_KEY'],
                value: 'kodus-test-value',
            },
        });
        expect(c.evidence.lines[0]).toContain('STRIPE_SECRET_KEY');
    });

    it('gives a URL var a fake URL, never something that looks like a secret', () => {
        const c = classifyBlocker(composeUp(logs('api', 'DATABASE_URL is not set')));
        expect(c.fixes[0].recipeChange?.value).toBe('http://kodus-fake.invalid');
    });

    it('turns a blocked outbound host into a one-click approval, before reading the logs', () => {
        const c = classifyBlocker(
            composeUp(
                bundle({
                    deniedEgress: [
                        {
                            host: 'API.Segment.io.',
                            port: 443,
                            at: '2026-11-03T12:00:00.000Z',
                        },
                    ],
                    services: [
                        {
                            name: 'api',
                            state: 'exited',
                            logTail: ['FOO is not set'],
                        },
                    ],
                }),
            ),
        );
        expect(c).toMatchObject({
            kind: 'external_service',
            signature: 'external_service:egress:api.segment.io',
        });
        expect(c.fixes[0]).toMatchObject({
            action: 'approve_host',
            who: 'one_click',
            host: 'api.segment.io',
        });
    });

    it('ignores a denied host that is not a host name', () => {
        const c = classifyBlocker(
            composeUp(
                bundle({
                    deniedEgress: [
                        {
                            host: 'evil"<b>',
                            port: 443,
                            at: '2026-11-03T12:00:00.000Z',
                        },
                    ],
                }),
            ),
        );
        expect(c.fixes.some((f) => f.action === 'approve_host')).toBe(false);
    });

    it.each([
        ['error app@1.0.0: The engine "node" is incompatible with this module. Expected version ">=22". Got "18.19.0"', 'toolchain:node', 'pin_version'],
        ['go: go.mod requires go >= 1.23 (running go 1.21)', 'toolchain:go', 'pin_version'],
        ['src/x.c:1:10: fatal error: libpq-fe.h: No such file or directory', 'native_dep:libpq-fe.h', 'add_packages'],
        ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', 'resources:memory:api', 'bump_machine'],
        ['QueryFailedError: relation "users" does not exist', 'seed_data:schema', 'add_seed_step'],
        ['Error: connect ECONNREFUSED 127.0.0.1:5432', 'external_service:localhost:5432', 'use_mock'],
        ['Error: getaddrinfo ENOTFOUND billing.internal', 'external_service:billing.internal', 'use_mock'],
        ['dial tcp: lookup billing.internal on 10.213.68.128:53: no such host', 'external_service:billing.internal', 'use_mock'],
        ['curl: (6) Could not resolve host: billing.internal', 'external_service:billing.internal', 'use_mock'],
        [
            'github.com/Masterminds/semver/v3@v3.4.0: verifying module: github.com/Masterminds/semver/v3@v3.4.0: Get "https://sum.golang.org/lookup/github.com/!masterminds/semver/v3@v3.4.0": dial tcp: lookup sum.golang.org on 10.213.68.128:53: no such host',
            'platform:go_checksum_db',
            'retry_setup',
        ],
    ])('reads %s', (line, signature, action) => {
        const c = classifyBlocker(composeUp(logs('api', line)));
        expect(c.signature).toBe(signature);
        expect(c.fixes[0].action).toBe(action);
    });

    it('takes the newest matching line', () => {
        const c = classifyBlocker(composeUp(logs('api', 'OLD_VAR is not set', 'later', 'NEW_VAR is not set')));
        expect(c.signature).toBe('missing_env:NEW_VAR');
    });

    it("offers only a retry for a failure on Kodus's side", () => {
        const c = classifyBlocker({
            kind: 'platform',
            signature: 'repo_fetch',
            message: 'download: 502',
        });
        expect(c.title).toBe('Kodus failed while downloading the repository');
        expect(c.fixes.map((f) => f.action)).toEqual(['retry_setup']);
    });

    it('points a ready check that never answered at a port that does not listen', () => {
        const c = classifyBlocker({
            kind: 'not_ready',
            signature: 'setup:not_ready:web:3000/health',
            message: 'GET /health on web:3000 failed (unreachable)',
            bundle: bundle({
                ports: [{ service: 'web', port: 3000, listening: false }],
            }),
        });
        expect(c).toMatchObject({
            kind: 'platform',
            signature: 'platform:not_listening:web:3000',
        });
        expect(c.fixes[0].action).toBe('fix_listen_address');
    });

    it('offers more time for a ready check that timed out on a listening port', () => {
        const c = classifyBlocker({
            kind: 'not_ready',
            signature: 'setup:not_ready:web:3000/health',
            message: 'GET /health on web:3000 answered 503',
        });
        expect(c.fixes[0]).toMatchObject({
            action: 'raise_health_timeout',
            recipeChange: { path: ['health_timeout'], value: '180s' },
        });
    });

    it('proposes a longer wait than the one the setup already waited, and none past the most', () => {
        const at = (message: string) => classifyBlocker({ kind: 'not_ready', signature: 'setup:not_ready:grafana:3000/api/health', message });
        // Kodus waited 300 s: the fix never lowers it.
        expect(at('GET /api/health on grafana:3000 failed (vm_unhealthy) after 300 s').fixes[0]).toMatchObject({
            action: 'raise_health_timeout',
            recipeChange: { path: ['health_timeout'], value: '600s' },
        });
        expect(at('GET /api/health on grafana:3000 failed (vm_unhealthy) after 900 s').fixes.map((f) => f.action)).toEqual(['retry_setup']);
    });

    it("proposes no longer wait when the setup claim's ceiling, not health_timeout, ended it", () => {
        const c = classifyBlocker({ kind: 'not_ready', signature: 'setup:not_ready:grafana:3000/api/health', message: `GET /api/health on grafana:3000 failed (vm_unhealthy)${notReadyWaited(180, true)}` });
        expect(c.fixes.map((f) => f.action)).toEqual(['retry_setup']);
        expect(c.title).toContain('machine time ran out');
    });

    it('keeps the cell kind and the last service line when no rule reads the logs', () => {
        const c = classifyBlocker(composeUp(logs('api', 'something odd happened')));
        expect(c).toMatchObject({
            kind: 'toolchain',
            signature: 'compose_up',
            title: 'The project failed to build or start',
            evidence: { service: 'api', lines: ['something odd happened'] },
        });
    });

    it('offers nothing to apply for a security violation', () => {
        expect(
            classifyBlocker({
                kind: 'security_violation',
                signature: 'credential_exfiltration',
                message: 'x',
            }).fixes,
        ).toEqual([]);
    });

    it('no recipe and nothing to infer one from is a recipe card for the dev, never "run the setup again"', () => {
        const c = classifyBlocker({ kind: 'no_recipe', signature: 'setup:no_recipe', message: 'There is no compose file and no Dockerfile at the repository root.' });
        expect(c).toMatchObject({ kind: 'recipe_outdated', signature: 'setup:no_recipe', title: 'Kodus found nothing to boot this repository from' });
        expect(c.fixes.map((f) => [f.id, f.who])).toEqual([['fix_recipe', 'dev']]);
    });

    it('a recipe the cell refused for services.needs is a recipe card for the dev, never a retry', () => {
        const c = classifyBlocker({ kind: 'other_repo', signature: 'recipe_needs', message: 'recipe_needs: services.needs (other repositories) is not supported by this cell yet' });
        expect(c).toMatchObject({ kind: 'other_repo', signature: 'recipe_needs', title: 'The recipe needs other repositories, which a cell does not boot yet' });
        expect(c.fixes.map((f) => [f.id, f.who])).toEqual([['fix_recipe', 'dev']]);
    });

    it.each([
        ['toolchain', 'recipe_setup', 'toolchain', 'setup'],
        ['seed_data', 'recipe_migrate', 'seed_data', 'data.migrate'],
        ['seed_data', 'recipe_seed', 'seed_data', 'data.seed'],
    ])('a failed recipe step (%s %s) names the key and leads with fixing it', (kind, signature, view, key) => {
        const c = classifyBlocker({ kind, signature, message: `${key}: "npm run x" exited 1: boom` });
        expect(c).toMatchObject({ kind: view, signature, title: `The recipe's ${key} failed` });
        expect(c.fixes.map((f) => f.id)).toEqual(['fix_recipe', 'retry_setup']);
    });
});

describe('a denied package registry', () => {
    const at = '2026-11-04T17:00:00Z';
    it('offers to allow it, never a fake: a build installs from it', () => {
        const r = classifyBlocker(composeUp(bundle({ deniedEgress: [{ host: 'proxy.golang.org', port: 53, at }] })));
        expect(r.signature).toBe('external_service:egress:proxy.golang.org');
        expect(r.fixes.map((f) => f.action)).toEqual(['approve_host']);
    });
    it('keeps the fake for an API the app calls', () => {
        const r = classifyBlocker(composeUp(bundle({ deniedEgress: [{ host: 'api.stripe.com', port: 443, at }] })));
        expect(r.fixes.map((f) => f.action)).toEqual(['approve_host', 'use_mock']);
    });
});

describe('a host on the platform deny list', () => {
    it('says no approval opens it and points at the mirror, never "allow"', () => {
        const r = classifyBlocker(composeUp(bundle({ deniedEgress: [{ host: 'storage.googleapis.com', port: 53, at: '2026-11-04T17:00:00Z', platform: true }] })));
        expect(r.signature).toBe('external_service:platform_denied:storage.googleapis.com');
        expect(r.fixes.map((f) => f.action)).toEqual(['fix_recipe']);
        expect(r.fixes[0].detail).toContain('GOPROXY');
    });
});

describe('an entry the cell refuses to unpack', () => {
    it("names the entry and why, as the repository's to change", () => {
        const r = classifyBlocker({
            kind: 'toolchain',
            signature: 'repo_refused',
            message: 'repo_refused: tarball: extractor: exit status 1: tarball: refused "o-r-abc/config/link": symlink to a path outside the root',
        });
        expect(r.title).toBe('Kodus refuses to unpack config/link from the repository');
        expect(r.evidence.lines[0]).toBe('config/link: symlink to a path outside the root');
        expect(r.fixes.map((f) => f.action)).toEqual(['fix_recipe']);
    });

    it('a boot past the ceiling asks for a lighter recipe, never "run it again"; a lost cell is Kodus\'s to retry', () => {
        const slow = classifyBlocker({ kind: 'resources', signature: 'boot_timeout', message: 'the boot did not finish in 40 min, the most a setup waits' });
        expect(slow.title).toBe('The boot takes longer than a setup waits');
        expect(slow.fixes.map((f) => f.action)).toEqual(['fix_recipe']);
        expect(slow.fixes[0].detail).toContain('development build');
        const lost = classifyBlocker({ kind: 'platform', signature: 'cell_lost', message: 'the cell disconnected while the claim was booting' });
        expect(lost.title).toBe('Kodus failed while keeping the cell connected during the boot');
        expect(lost.fixes.map((f) => f.action)).toEqual(['retry_setup']);
    });

    it("a build killed at its memory limit names the limit and points to the environment's machine size, a lighter build, then a new setup", () => {
        const oom = classifyBlocker({
            kind: 'resources',
            signature: 'out_of_memory',
            message: 'driver: the workload ran out of memory: build grafana passed 12g (docker run: exit status 137: )',
        });
        expect(oom.title).toBe('The build ran out of memory (12 GB)');
        expect(oom.fixes.map((f) => f.action)).toEqual(['bump_machine', 'fix_recipe', 'retry_setup']);
        expect(oom.fixes[0]).toMatchObject({ who: 'settings', label: 'Give the environment a larger machine' });
        expect(oom.fixes[0].detail).toContain('Machine size');
        expect(oom.fixes[0].detail).toContain('Large 16 GB');
        // A self-hosted cell's own bounds stay on the card.
        expect(oom.fixes[0].detail).toContain('-gvisor-mem-limit');
        expect(oom.fixes[0].detail).toContain('-gvisor-mem-max');
        expect(oom.fixes[1].detail).toContain('--mount=type=cache');
        expect(oom.fixes[2].detail).toContain('larger machine size');
        // A claim's own size reaches the title as the cell wrote it (12288m), in GB.
        const sized = classifyBlocker({ kind: 'resources', signature: 'out_of_memory', message: 'driver: the workload ran out of memory: build api passed 12288m (exit status 137)' });
        expect(sized.title).toBe('The build ran out of memory (12 GB)');
        expect(classifyBlocker({ kind: 'resources', signature: 'out_of_memory', message: 'build api passed 1536m' }).title).toBe('The build ran out of memory (1536m)');
    });

    it("a cell too old for Kody's build files says so, with nothing in the repository to change", () => {
        const old = classifyBlocker({
            kind: 'platform',
            signature: 'authored_files_unsupported',
            message: "this cell's build is older than the build files Kody writes with its recipe (its hello names no authoredFiles); the claim was not started",
        });
        expect(old).toMatchObject({ kind: 'platform', signature: 'authored_files_unsupported', title: 'This cell is too old for the build files Kody wrote' });
        expect(old.fixes.map((f) => [f.action, f.label])).toEqual([['retry_setup', 'Update the cell, then run it again']]);
        expect(old.fixes[0].detail).toContain('your repository is not the cause');
    });

    it("a checkout that already has a path of Kody's build files, or a .kodus link, names it and never offers to replace it", () => {
        const planted = classifyBlocker({
            kind: 'toolchain',
            signature: 'authored_files',
            message: 'authored_files: authored file .kodus/Dockerfile.kody: is already in the checkout with other content; Kody never replaces a repository file',
        });
        expect(planted).toMatchObject({ kind: 'toolchain', signature: 'authored_files', title: "Kody's build files could not be written: it already has .kodus/Dockerfile.kody" });
        expect(planted.fixes[0]).toMatchObject({ action: 'fix_recipe', who: 'dev' });
        expect(planted.fixes[0].detail).toContain('Remove or rename .kodus/Dockerfile.kody');
        const link = classifyBlocker({ kind: 'toolchain', signature: 'authored_files', message: 'authored_files: authored file .kodus: is a symbolic link in the checkout' });
        expect(link.title).toBe("Kody's build files could not be written: its .kodus is not a plain directory");
        // A path that is not one Kody writes never reaches the title (S-23).
        const odd = classifyBlocker({ kind: 'toolchain', signature: 'authored_files', message: 'authored_files: authored file ../../etc/passwd<script>: x' });
        expect(odd.title).toBe("Kody's build files could not be written: it already has a path Kody writes");
    });

    it('a machine size above what the cell grants says asked and max, and asks for a size the cell grants', () => {
        const big = classifyBlocker({
            kind: 'resources',
            signature: 'size_unavailable',
            message: 'size_unavailable: driver: the machine size is above what this cell grants: asked 16384 MB / 8 CPUs, this cell grants at most 8192 MB / 4 CPUs',
        });
        expect(big).toMatchObject({ kind: 'resources', signature: 'size_unavailable', title: 'No cell grants this machine size' });
        expect(big.evidence?.lines?.join(' ')).toContain('asked 16384 MB / 8 CPUs, this cell grants at most 8192 MB / 4 CPUs');
        expect(big.fixes.map((f) => [f.action, f.label])).toEqual([
            ['bump_machine', 'Choose a machine size a cell grants'],
            ['use_own_cell', 'Run it on a cell of your own'],
        ]);
        expect(big.fixes[0].detail).toContain('Machine size');
        expect(big.fixes[0].detail).toContain('-gvisor-mem-max');
        expect(big.fixes[0].detail).toContain('older than machine sizes');
    });

    it('a size no connected cell grants (the routing refused it) gets the same card, its evidence naming the largest grant', () => {
        const routed = classifyBlocker({
            kind: 'resources',
            signature: 'size_unavailable',
            message: 'asked 16384 MB / 8 CPUs, and no connected cell that may serve this organization grants it: the largest any of them grants is 8192 MB / 4 CPUs; the claim was not started',
        });
        expect(routed).toMatchObject({ kind: 'resources', signature: 'size_unavailable', title: 'No cell grants this machine size' });
        expect(routed.evidence?.lines?.join(' ')).toContain('the largest any of them grants is 8192 MB / 4 CPUs');
        expect(routed.fixes.map((f) => f.action)).toEqual(['bump_machine', 'use_own_cell']);
    });

    it('a boot no cell took is a platform card: nothing booted, check the cell, run it again', () => {
        const none = classifyBlocker({ kind: 'cell_unavailable', signature: 'cell_unavailable', message: 'no cell is connected for this organization' });
        expect(none).toMatchObject({ kind: 'platform', title: 'No cell was connected to boot this environment' });
        expect(none.fixes.map((f) => f.action)).toEqual(['retry_setup']);
        expect(none.fixes[0].detail).toContain('Nothing booted');
    });

    it("an org at its cap on shared cells names the cap, and says to wait or use its own cell", () => {
        const capped = classifyBlocker({
            kind: 'resources',
            signature: 'org_capacity',
            message: 'this organization already holds 8 machines on shared Kodus cells, the most it may hold at once (cap 8); the claim was not started',
        });
        expect(capped).toMatchObject({ kind: 'resources', signature: 'org_capacity', title: 'Your organization is using all 8 machines it may hold on shared Kodus cells' });
        expect(capped.fixes.map((f) => [f.action, f.who])).toEqual([
            ['retry_setup', 'one_click'],
            ['use_own_cell', 'settings'],
        ]);
        expect(capped.fixes[0].label).toBe('Wait, then run it again');
        expect(capped.fixes[1].detail).toContain('cell of your organization');
        expect(classifyBlocker({ kind: 'resources', signature: 'org_capacity', message: 'capped' }).title).toBe(
            'Your organization is using all the machines it may hold on shared Kodus cells',
        );
    });

    it('every eligible cell full is its own card, not a full cell nor a Kodus step that failed', () => {
        const full = classifyBlocker({ kind: 'resources', signature: 'no_capacity', message: 'every cell that may serve this organization is full; the claim was not started' });
        expect(full).toMatchObject({ kind: 'resources', signature: 'no_capacity', title: 'Every cell that can run this environment is full' });
        expect(full.fixes.map((f) => f.action)).toEqual(['retry_setup', 'use_own_cell']);
        expect(full.fixes[0].detail).toContain('Nothing booted');
    });
});

describe('fixes made in Kodus settings', () => {
    it("are `settings`, not the repository's `dev`: the machine size and an own cell, on every card that offers them", () => {
        const cards = [
            { kind: 'resources', signature: 'out_of_memory', message: 'driver: the workload ran out of memory: build app passed 4g (docker run: exit status 137: )' },
            { kind: 'resources', signature: 'org_capacity', message: 'capped' },
            { kind: 'resources', signature: 'no_capacity', message: 'full' },
            { kind: 'resources', signature: 'size_unavailable', message: 'asked 16 GB' },
        ].map((b) => classifyBlocker(b));
        const fixes = cards.flatMap((c) => c.fixes);
        const inSettings = fixes.filter((f) => f.action === 'bump_machine' || f.action === 'use_own_cell');
        expect(new Set(inSettings.map((f) => f.action))).toEqual(new Set(['bump_machine', 'use_own_cell']));
        expect(inSettings.every((f) => f.who === 'settings')).toBe(true);
        expect(fixes.filter((f) => f.who === 'settings')).toEqual(inSettings);
    });
});

describe('repository fixes the build log names', () => {
    it('reads a lockfile out of date', () => {
        const r = classifyBlocker(composeUp(logs('boot output', '47.79 ➤ YN0028: │ The lockfile would have been modified by this install, which is explicitly forbidden.')));
        expect(r.signature).toBe('toolchain:lockfile_outdated:yarn');
        expect(r.fixes[0].detail).toContain('commit the updated lockfile');
    });
    it('reads a Go module the mirror does not serve', () => {
        const r = classifyBlocker(composeUp(logs('boot output', 'go: example.com/new@v1.2.0: reading http://mirror.cell.internal:8080/go/example.com/new/@v/v1.2.0.info: 410 Gone', '\texample.com/new@v1.2.0 is not pinned by this claim\'s go.sum')));
        expect(r.signature).toBe('toolchain:go_module_not_pinned:example.com/new');
    });
});

describe('matchedBlockerLine', () => {
    it('is the line of a multi-line reason that holds the match classifyBlocker read, in its rule order', () => {
        const message = ['compose up: exit 1', 'lookup billing.internal: no such host', 'OLD_VAR is not set', 'NEW_VAR is not set', '#9 ERROR: exit code: 1'].join('\n');
        expect(matchedBlockerLine({ message })).toBe('OLD_VAR is not set');
        expect(classifyBlocker({ kind: 'unknown', signature: 'compose_up', message }).signature).toBe('missing_env:OLD_VAR');
    });

    it('reads the bundle newest first when the reason holds no cause, as classifyBlocker does', () => {
        const input = composeUp(logs('api', 'OLD_VAR is not set', 'later', 'NEW_VAR is not set'));
        expect(matchedBlockerLine(input)).toBe('NEW_VAR is not set');
        expect(classifyBlocker(input).signature).toBe('missing_env:NEW_VAR');
    });

    it('is undefined when no rule reads any line', () => {
        expect(matchedBlockerLine({ message: 'compose up: exit 1\n#9 ERROR: exit code: 1' })).toBeUndefined();
    });
});
