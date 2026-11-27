import { estimateTotalMs, shardCount } from './balance';
import { type CoverageMapInput, DEFAULT_FULL_RUN_FILES, diffBaseFor, isUnskippable, select, type SelectInput } from './select';

// Four specs over a small invented app. login and cart share nothing; session.ts is read by two specs.
const SPECS = ['e2e/login.cy.ts', 'e2e/cart.cy.ts', 'e2e/search.cy.ts', 'e2e/profile.cy.ts'];
const MAP: CoverageMapInput = {
    suiteDigest: 'd1',
    commitsBehindMain: 2,
    ageMs: 60_000,
    specs: {
        'e2e/login.cy.ts': ['src/auth/login.ts', 'src/api/session.ts'],
        'e2e/cart.cy.ts': ['src/cart/cart.ts', 'src/api/cart.ts', 'src/api/session.ts'],
        'e2e/search.cy.ts': ['src/search/search.ts', 'src/api/search.ts'],
        'e2e/profile.cy.ts': ['src/profile/profile.ts', 'src/api/profile.ts', 'src/shared/layout.ts'],
    },
};
const input = (changed: string[], over: Partial<SelectInput> = {}): SelectInput => ({ allSpecs: SPECS, changed, map: MAP, suiteDigest: 'd1', ...over });

describe('select: what a change can reach', () => {
    it('a changed covered file selects exactly the specs that cover it', () => {
        const s = select(input(['src/cart/cart.ts']));
        expect(s).toMatchObject({ mode: 'selected', specs: ['e2e/cart.cy.ts'] });
    });
    it('a file covered by two specs selects both, in the order of the suite', () => {
        expect(select(input(['src/api/session.ts']))).toMatchObject({ mode: 'selected', specs: ['e2e/login.cy.ts', 'e2e/cart.cy.ts'] });
    });
    it('several changed files select the union', () => {
        expect(select(input(['src/search/search.ts', 'src/auth/login.ts']))).toMatchObject({ mode: 'selected', specs: ['e2e/login.cy.ts', 'e2e/search.cy.ts'] });
    });
    it('a changed spec file selects itself', () => {
        expect(select(input(['e2e/profile.cy.ts']))).toMatchObject({ mode: 'selected', specs: ['e2e/profile.cy.ts'] });
    });
    it('a deleted spec file selects nothing and is not unknown', () => {
        expect(select(input(['e2e/gone.cy.ts'], { map: { ...MAP, specs: { ...MAP.specs, 'e2e/gone.cy.ts': ['src/old.ts'] } } }))).toMatchObject({ mode: 'selected', specs: [] });
    });
    it('a file no spec covers selects through the import graph: an importer a spec covers', () => {
        const importers: Record<string, string[]> = { 'src/util/money.ts': ['src/cart/cart.ts'] };
        expect(select(input(['src/util/money.ts'], { importersOf: (f) => importers[f] ?? [] }))).toMatchObject({ mode: 'selected', specs: ['e2e/cart.cy.ts'] });
    });
    it('follows importers more than one hop', () => {
        const importers: Record<string, string[]> = { 'src/util/a.ts': ['src/util/b.ts'], 'src/util/b.ts': ['src/search/search.ts'] };
        expect(select(input(['src/util/a.ts'], { importersOf: (f) => importers[f] ?? [] }))).toMatchObject({ mode: 'selected', specs: ['e2e/search.cy.ts'] });
    });
    it('survives an import cycle', () => {
        const importers: Record<string, string[]> = { 'src/x.ts': ['src/y.ts'], 'src/y.ts': ['src/x.ts'] };
        expect(select(input(['src/x.ts'], { importersOf: (f) => importers[f] ?? [] }))).toMatchObject({ mode: 'full', reason: 'uncovered_file' });
    });
    it('a file in a workspace selects the specs of the apps that depend on it', () => {
        const dependents: Record<string, string[]> = { 'packages/ui/button.ts': ['e2e/login.cy.ts', 'e2e/profile.cy.ts'] };
        expect(select(input(['packages/ui/button.ts'], { workspaceSpecsOf: (f) => dependents[f] ?? [] }))).toMatchObject({ mode: 'selected', specs: ['e2e/login.cy.ts', 'e2e/profile.cy.ts'] });
    });
    it('counts, per selected spec, how many changed files it covers', () => {
        const s = select(input(['src/api/session.ts', 'src/cart/cart.ts']));
        expect(s.mode === 'selected' && s.diffCoverage).toEqual({ 'e2e/login.cy.ts': 1, 'e2e/cart.cy.ts': 2 });
    });
    it('says what it selected and why', () => {
        expect(select(input(['src/cart/cart.ts', 'src/api/cart.ts'])).text).toBe('selected 1 of 4 specs: covers the 2 changed files');
    });
});

describe('select: the safety net returns the whole suite, with its reason', () => {
    it.each([
        ['package.json', 'manifest'],
        ['apps/dashboard/package.json', 'manifest'],
        ['go.mod', 'manifest'],
        ['pnpm-workspace.yaml', 'manifest'],
        ['pnpm-lock.yaml', 'lockfile'],
        ['yarn.lock', 'lockfile'],
        ['package-lock.json', 'lockfile'],
        ['go.sum', 'lockfile'],
        ['cypress.config.ts', 'config'],
        ['apps/dashboard/playwright.config.js', 'config'],
        ['Dockerfile', 'config'],
        ['apps/api/Dockerfile.e2e', 'config'],
        ['docker-compose.yml', 'config'],
        ['compose.e2e.yaml', 'config'],
        ['.kodus/workspace.yaml', 'config'],
        ['.env.schema', 'config'],
        ['src/router/index.ts', 'shared_routing'],
        ['cypress/support/e2e.ts', 'shared_routing'],
        ['playwright/global-setup.ts', 'shared_routing'],
    ])('%s changed: full, reason %s', (file, reason) => {
        expect(select(input(['src/cart/cart.ts', file]))).toMatchObject({ mode: 'full', reason, specs: SPECS });
    });

    it('names the file in the text', () => {
        expect(select(input(['package.json'])).text).toBe('full suite: package.json changed');
    });
    it('an uncovered file with no covering importer: full, never an empty selection', () => {
        expect(select(input(['src/brand-new/thing.ts']))).toMatchObject({ mode: 'full', reason: 'uncovered_file', specs: SPECS });
        expect(select(input(['src/brand-new/thing.ts'])).text).toBe('full suite: no spec covers src/brand-new/thing.ts');
    });
    it('the map missing: full', () => {
        expect(select(input(['src/cart/cart.ts'], { map: undefined }))).toMatchObject({ mode: 'full', reason: 'map_missing' });
    });
    it('the map older than 20 main commits: full', () => {
        expect(select(input(['src/cart/cart.ts'], { map: { ...MAP, commitsBehindMain: 21 } }))).toMatchObject({ mode: 'full', reason: 'map_stale' });
        expect(select(input(['src/cart/cart.ts'], { map: { ...MAP, commitsBehindMain: 20 } })).mode).toBe('selected');
    });
    it('the map older than 3 days: full', () => {
        expect(select(input(['src/cart/cart.ts'], { map: { ...MAP, ageMs: 3 * 86_400_000 + 1 } }))).toMatchObject({ mode: 'full', reason: 'map_stale' });
    });
    it('the map of another suite digest: full', () => {
        expect(select(input(['src/cart/cart.ts'], { suiteDigest: 'd2' }))).toMatchObject({ mode: 'full', reason: 'map_digest' });
    });
    it('a file most specs cover is noise: full, since it would select everything', () => {
        const map = { ...MAP, specs: { ...MAP.specs, 'e2e/login.cy.ts': [...MAP.specs['e2e/login.cy.ts'], 'src/login-helper.ts'], 'e2e/cart.cy.ts': [...MAP.specs['e2e/cart.cy.ts'], 'src/login-helper.ts'], 'e2e/search.cy.ts': [...MAP.specs['e2e/search.cy.ts'], 'src/login-helper.ts'] } };
        expect(select(input(['src/login-helper.ts'], { map }))).toMatchObject({ mode: 'full', reason: 'noise_file' });
    });
    it('a file half the specs cover is not noise', () => {
        expect(select(input(['src/api/session.ts'])).mode).toBe('selected');
    });
    it('a forced full run says why', () => {
        expect(select(input(['src/cart/cart.ts'], { forceFull: 'ready_for_review' }))).toMatchObject({ mode: 'full', reason: 'ready_for_review' });
    });
    it('one safety-net file makes the whole run full even beside covered ones', () => {
        expect(select(input(['src/cart/cart.ts', 'src/auth/login.ts', 'yarn.lock'])).mode).toBe('full');
    });
});

describe('select: ignored files', () => {
    const ignore = ['docs/**', '**/*.md'];
    it('an ignored doc file selects nothing', () => {
        expect(select(input(['docs/guide.md'], { ignore }))).toMatchObject({ mode: 'selected', specs: [] });
        expect(select(input(['README.md'], { ignore })).text).toBe('no spec selected: every changed file is ignored (suite.ignore)');
    });
    it('an ignored file beside a covered one adds nothing and is not counted as covered', () => {
        expect(select(input(['docs/guide.md', 'src/cart/cart.ts'], { ignore }))).toMatchObject({ mode: 'selected', specs: ['e2e/cart.cy.ts'], text: 'selected 1 of 4 specs: covers the 1 changed file' });
    });
    it('ignore never overrides the safety net', () => {
        expect(select(input(['package.json'], { ignore: ['**/*.json'] }))).toMatchObject({ mode: 'full', reason: 'manifest' });
    });
    it('without an ignore list a doc file is unknown, so full', () => {
        expect(select(input(['docs/guide.md'])).mode).toBe('full');
    });
    it('no changed file at all selects nothing', () => {
        expect(select(input([]))).toMatchObject({ mode: 'selected', specs: [] });
    });
});

describe('select says which changed file reached which specs', () => {
    it('names, per changed file, the specs it reaches, so a page can show why each spec ran', () => {
        const s = select(input(['src/api/session.ts', 'src/search/search.ts']));
        expect(s).toMatchObject({ mode: 'selected', reachedBy: { 'src/api/session.ts': ['e2e/login.cy.ts', 'e2e/cart.cy.ts'], 'src/search/search.ts': ['e2e/search.cy.ts'] } });
    });
    it('a changed spec file is reached by itself', () => {
        expect(select(input(['e2e/profile.cy.ts']))).toMatchObject({ reachedBy: { 'e2e/profile.cy.ts': ['e2e/profile.cy.ts'] } });
    });
    it('a file reached through its importer names the specs of that importer', () => {
        const importers: Record<string, string[]> = { 'src/util/money.ts': ['src/cart/cart.ts'] };
        expect(select(input(['src/util/money.ts'], { importersOf: (f) => importers[f] ?? [] }))).toMatchObject({ reachedBy: { 'src/util/money.ts': ['e2e/cart.cy.ts'] } });
    });
    it('keeps a bounded list: at most 40 files and 25 specs each', () => {
        const specs = Array.from({ length: 30 }, (_, i) => `e2e/s${i}.cy.ts`);
        const files = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`);
        const others = Array.from({ length: 200 }, (_, i) => `e2e/o${i}.cy.ts`);
        const map: CoverageMapInput = { ...MAP, specs: { ...Object.fromEntries(specs.map((s) => [s, files])), ...Object.fromEntries(others.map((s, i) => [s, [`src/other${i}.ts`]])) } };
        const s = select({ allSpecs: [...specs, ...others], changed: files, map, suiteDigest: 'd1' });
        if (s.mode !== 'selected') throw new Error('expected a selection');
        expect(Object.keys(s.reachedBy)).toHaveLength(40);
        expect(Object.values(s.reachedBy).every((x) => x.length <= 25)).toBe(true);
        expect(s.specs).toHaveLength(30);
    });
});

describe('select: the guards that keep a spec from being skipped on a guess', () => {
    const passedAll = SPECS;

    // Behavior: a spec with no recorded pass on main runs even when the change does not reach it, since nothing shows a skip is safe.
    it('never skips a spec with no recorded pass on main', () => {
        const s = select(input(['src/cart/cart.ts'], { passedOnMain: ['e2e/login.cy.ts', 'e2e/cart.cy.ts', 'e2e/search.cy.ts'] }));
        expect(s).toMatchObject({ mode: 'selected', specs: ['e2e/cart.cy.ts', 'e2e/profile.cy.ts'] });
        expect(s.text).toContain('plus 1 spec that always run (1 spec with no recorded pass on main)');
    });

    // Behavior: when every spec has passed on main the guard adds nothing and the text is the one it always was.
    it('adds nothing when every spec has passed on main', () => {
        const s = select(input(['src/cart/cart.ts'], { passedOnMain: new Set(passedAll) }));
        expect(s).toMatchObject({ mode: 'selected', specs: ['e2e/cart.cy.ts'], text: 'selected 1 of 4 specs: covers the 1 changed file' });
    });

    // Behavior: with no spec passing on main, nothing is proven skippable, so the whole suite runs with its own reason.
    it('runs the whole suite when no spec has a recorded pass on main', () => {
        expect(select(input(['src/cart/cart.ts'], { passedOnMain: [] }))).toMatchObject({ mode: 'full', reason: 'no_main_pass', specs: SPECS });
    });

    // Behavior: an unproven spec also runs when the change touched only ignored files, so "nothing selected" never hides one.
    it('runs the unproven specs when every changed file is ignored', () => {
        const s = select(input(['README.md'], { ignore: ['*.md'], passedOnMain: ['e2e/login.cy.ts', 'e2e/cart.cy.ts', 'e2e/search.cy.ts'] }));
        expect(s).toMatchObject({ mode: 'selected', specs: ['e2e/profile.cy.ts'] });
    });

    // Behavior: a spec the recipe lists as unskippable runs whatever the diff reaches, by glob or by @tag.
    it.each([
        ['a glob', ['e2e/search.*'], 'e2e/search.cy.ts'],
        ['a tag in the file name', ['@smoke'], 'e2e/search.smoke.cy.ts'],
        ['a tag as a directory', ['@smoke'], 'e2e/smoke/search.cy.ts'],
    ])('always runs an unskippable spec named by %s', (_n, unskippable, spec) => {
        const specs = ['e2e/login.cy.ts', 'e2e/cart.cy.ts', spec];
        const s = select({ allSpecs: specs, changed: ['src/cart/cart.ts'], map: { ...MAP, specs: { 'e2e/login.cy.ts': ['src/auth/login.ts'], 'e2e/cart.cy.ts': ['src/cart/cart.ts'], [spec]: ['src/search/search.ts'] } }, suiteDigest: 'd1', unskippable });
        expect(s).toMatchObject({ mode: 'selected', specs: ['e2e/cart.cy.ts', spec] });
        expect(s.text).toContain('1 spec unskippable');
    });

    // Behavior: a tag matches whole path parts only, so @smoke does not pin a spec named smokestack.
    it('reads a tag as a whole part of the path', () => {
        expect(isUnskippable('e2e/smokestack.cy.ts', ['@smoke'])).toBe(false);
        expect(isUnskippable('e2e/a.smoke.cy.ts', ['@smoke'])).toBe(true);
        expect(isUnskippable('e2e/a.cy.ts', undefined)).toBe(false);
    });

    // Behavior: a diff wider than the configured count is the whole suite, however well the map covers each file.
    it('runs the whole suite when the diff is huge', () => {
        const changed = Array.from({ length: 4 }, (_, i) => `src/cart/f${i}.ts`);
        expect(select(input(changed, { fullRunFiles: 3 }))).toMatchObject({ mode: 'full', reason: 'huge_diff' });
        expect(select(input(['src/cart/cart.ts'], { fullRunFiles: 3 }))).toMatchObject({ mode: 'selected' });
    });

    // Behavior: files in suite.ignore do not count toward a huge diff, and the default limit applies when the recipe sets none.
    it('counts only the files that are not ignored, against a default of 300', () => {
        const docs = Array.from({ length: DEFAULT_FULL_RUN_FILES + 1 }, (_, i) => `docs/p${i}.md`);
        expect(select(input([...docs, 'src/cart/cart.ts'], { ignore: ['docs/**'] }))).toMatchObject({ mode: 'selected', specs: ['e2e/cart.cy.ts'] });
        const src = Array.from({ length: DEFAULT_FULL_RUN_FILES + 1 }, (_, i) => `src/x/f${i}.ts`);
        expect(select(input(src))).toMatchObject({ mode: 'full', reason: 'huge_diff' });
    });

    // Behavior: the safety net's own reasons still win over the guards (a lockfile is a lockfile before it is a wide diff).
    it('keeps the file reasons first', () => {
        expect(select(input(['pnpm-lock.yaml'], { passedOnMain: [], fullRunFiles: 0 }))).toMatchObject({ mode: 'full', reason: 'lockfile' });
    });
});

describe('diffBaseFor: where the diff of a pull request starts', () => {
    // Behavior: when the map belongs to an older main commit than the merge base, the diff starts at the map's commit, so main's own changes in between count.
    it('starts at the last green main commit when the merge base has no map', () => {
        expect(diffBaseFor('mb', 'green')).toBe('green');
    });
    // Behavior: when the map is the merge base's, or none is known, the diff starts at the merge base as before.
    it('starts at the merge base when it has the map, or when there is none', () => {
        expect(diffBaseFor('mb', 'mb')).toBe('mb');
        expect(diffBaseFor('mb', undefined)).toBe('mb');
    });
});

describe('select feeds the shard count', () => {
    it('6 short selected specs are one host, one boot, one PR build', () => {
        const specs = Array.from({ length: 6 }, (_, i) => `e2e/s${i}.cy.ts`);
        const map: CoverageMapInput = { ...MAP, specs: Object.fromEntries(specs.map((s, i) => [s, [`src/f${i}.ts`]])) };
        const sel = select({ allSpecs: [...specs, ...Array.from({ length: 60 }, (_, i) => `e2e/other${i}.cy.ts`)], changed: specs.map((_, i) => `src/f${i}.ts`), map, suiteDigest: 'd1' });
        expect(sel.mode).toBe('selected');
        const stats = Object.fromEntries(sel.specs.map((s) => [s, { p50Ms: 30_000 }]));
        const files = sel.specs.map((path) => ({ path, sizeBytes: 100 }));
        expect(shardCount({ totalMs: estimateTotalMs(files, stats), maxShards: 3, headroom: 10, specCount: files.length })).toBe(1);
    });
});
