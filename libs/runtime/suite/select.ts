import picomatch from 'picomatch';

// Selection and the safety net (docs/runtime/e2e-suites.md section 6.1). Pure:
// given the files a PR changed, the stored coverage map and the import graph,
// which specs the change can reach, or the whole suite with the reason. The
// unknown is never skipped: a changed file nothing explains runs everything.

/** D12: a map older than this many main commits, or this long, is stale. */
export const MAP_MAX_COMMITS_BEHIND = 20;
export const MAP_MAX_AGE_MS = 3 * 86_400_000;
/** D15: a file this share of the specs cover would select all of them; changing it is a full run. */
export const NOISE_SHARE = 0.5;
/** How far the importer walk goes, and how many files it visits (bounded like IMPORT_GRAPH_LIMITS). */
export const IMPORTER_WALK = { depth: 6, nodes: 500 } as const;

/** `runtime_suite_coverage_maps` for the newest complete map of the environment. */
export interface CoverageMapInput {
    suiteDigest: string;
    /** Main commits since the map's sha. */
    commitsBehindMain: number;
    ageMs: number;
    /** spec -> the source files it exercises. */
    specs: Readonly<Record<string, readonly string[]>>;
}

export const FULL_REASONS = [
    'manifest',
    'lockfile',
    'config',
    'shared_routing',
    'uncovered_file',
    'map_missing',
    /** The change set could not be read (the diff was cut or the product did not send it): nothing is skipped on a guess. */
    'changes_unknown',
    'map_stale',
    'map_digest',
    'noise_file',
    'ready_for_review',
    'baseline',
    /** A shadow run (D14) is the whole suite on purpose: it is what selection is compared with. */
    'shadow',
    /** A selection miss turned the environment to the whole suite for the next pull requests (D14). */
    'selection_miss',
    /** Two misses in ten shadows turned selection off until a person re-enables it (D14). */
    'selection_off',
] as const;
export type FullReason = (typeof FULL_REASONS)[number];

export interface SelectInput {
    /** The spec files at the PR sha. */
    allSpecs: readonly string[];
    /** `diff(mergeBase, prSha)`, renames as both paths. */
    changed: readonly string[];
    map?: CoverageMapInput;
    /** The digest of the suite block and the spec list the run would use. */
    suiteDigest: string;
    /** `suite.ignore`: globs of files proven not to reach the app. Never overrides the safety net. */
    ignore?: readonly string[];
    /** Files that import `file` (the planner's reverse edges). */
    importersOf?: (file: string) => readonly string[];
    /** Specs of every app that depends on the workspace `file` is in (manifests only, reverse closure). */
    workspaceSpecsOf?: (file: string) => readonly string[];
    forceFull?: Extract<FullReason, 'ready_for_review' | 'baseline' | 'shadow' | 'selection_miss' | 'selection_off'>;
}

export type Selection =
    | {
          mode: 'selected';
          /** In the order of `allSpecs`. */
          specs: string[];
          /** Per selected spec, how many changed files reach it: the risk-first order reads it. */
          diffCoverage: Record<string, number>;
          /** Per changed file, the specs it reaches (what the run's page shows as "why these specs"); bounded by `REACHED_BY_LIMITS`. */
          reachedBy: Record<string, string[]>;
          text: string;
      }
    | { mode: 'full'; specs: string[]; reason: FullReason; text: string };

const MANIFESTS = /(^|\/)(package\.json|go\.mod|pnpm-workspace\.yaml|requirements[\w.-]*\.txt|Pipfile|pyproject\.toml|Gemfile|composer\.json|Cargo\.toml|pom\.xml|build\.gradle(\.kts)?|bun\.toml)$/;
const LOCKFILES = /(^|\/)(pnpm-lock\.yaml|yarn\.lock|package-lock\.json|npm-shrinkwrap\.json|bun\.lockb?|go\.sum|Pipfile\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|Cargo\.lock)$/;
const CONFIGS = [
    /(^|\/)cypress\.config\.[cm]?[jt]s$/,
    /(^|\/)playwright\.config\.[cm]?[jt]s$/,
    /(^|\/)Dockerfile(\.[\w.-]+)?$/,
    /(^|\/)(docker-)?compose(\.[\w.-]+)?\.ya?ml$/,
    /^\.kodus\//,
    /(^|\/)\.env\.schema$/,
];
const SHARED_ROUTING = [
    /(^|\/)router(\/index)?\.[cm]?[jt]sx?$/,
    /(^|\/)router\/index\.(vue|[cm]?[jt]sx?)$/,
    /(^|\/)cypress\/support\//,
    /(^|\/)global-(setup|teardown)\.[cm]?[jt]sx?$/,
];

const matches = (globs: readonly string[] | undefined) => {
    const m = globs?.length ? picomatch([...globs], { dot: true }) : () => false;
    return (f: string) => m(f);
};

/** What a stored "reached by" keeps: the page shows a reason, not the whole map. */
export const REACHED_BY_LIMITS = { files: 40, specsPerFile: 25 } as const;

const files = (n: number) => `${n} changed file${n === 1 ? '' : 's'}`;

const full = (specs: readonly string[], reason: FullReason, text: string): Selection => ({ mode: 'full', specs: [...specs], reason, text: `full suite: ${text}` });

export function select(i: SelectInput): Selection {
    const all = [...i.allSpecs];
    if (i.forceFull === 'ready_for_review') return full(all, 'ready_for_review', 'the pull request is ready for review');
    if (i.forceFull === 'baseline') return full(all, 'baseline', 'baseline run');
    if (i.forceFull === 'shadow') return full(all, 'shadow', 'shadow run, the whole suite to compare the selection with');
    if (i.forceFull === 'selection_miss') return full(all, 'selection_miss', 'selection missed a regression recently, so the whole suite runs for a while');
    if (i.forceFull === 'selection_off') return full(all, 'selection_off', 'selection is off for this environment until a person turns it on');

    // 1 to 3 of the net: the file alone says it, whatever the map holds.
    for (const f of i.changed) {
        if (MANIFESTS.test(f)) return full(all, 'manifest', `${f} changed`);
        if (LOCKFILES.test(f)) return full(all, 'lockfile', `${f} changed`);
        if (CONFIGS.some((r) => r.test(f))) return full(all, 'config', `${f} changed`);
        if (SHARED_ROUTING.some((r) => r.test(f))) return full(all, 'shared_routing', `${f} changed`);
    }

    const ignored = matches(i.ignore);
    const relevant = i.changed.filter((f) => !ignored(f));
    if (i.changed.length > 0 && relevant.length === 0) return { mode: 'selected', specs: [], diffCoverage: {}, reachedBy: {}, text: 'no spec selected: every changed file is ignored (suite.ignore)' };
    if (relevant.length === 0) return { mode: 'selected', specs: [], diffCoverage: {}, reachedBy: {}, text: 'no spec selected: nothing changed' };

    // 5: the map.
    const map = i.map;
    if (!map) return full(all, 'map_missing', 'no coverage map for this environment yet');
    if (map.suiteDigest !== i.suiteDigest) return full(all, 'map_digest', 'the suite changed since the coverage map was recorded');
    if (map.commitsBehindMain > MAP_MAX_COMMITS_BEHIND || map.ageMs > MAP_MAX_AGE_MS) {
        return full(all, 'map_stale', `the coverage map is stale (${map.commitsBehindMain} main commits, ${Math.floor(map.ageMs / 86_400_000)} days old)`);
    }

    const present = new Set(all);
    const mapSpecs = Object.keys(map.specs);
    const coveredBy = new Map<string, Set<string>>();
    for (const [spec, fs] of Object.entries(map.specs)) {
        for (const f of fs) {
            const set = coveredBy.get(f) ?? new Set();
            set.add(spec);
            coveredBy.set(f, set);
        }
    }
    const coveringSpecs = (f: string): string[] => [...(coveredBy.get(f) ?? [])].filter((s) => present.has(s));

    const selected = new Set<string>();
    const diffCoverage: Record<string, number> = {};
    const reachedBy: Record<string, string[]> = {};
    const hit = (spec: string) => {
        selected.add(spec);
        diffCoverage[spec] = (diffCoverage[spec] ?? 0) + 1;
    };

    for (const f of relevant) {
        // D15: a file covered by most specs selects them all; it is a full run, said so.
        if ((coveredBy.get(f)?.size ?? 0) > mapSpecs.length * NOISE_SHARE) return full(all, 'noise_file', `${f} is covered by most specs`);

        const reached = new Set<string>(coveringSpecs(f));
        if (present.has(f)) reached.add(f);
        if (reached.size === 0) for (const s of importerSpecs(f, i.importersOf, coveringSpecs)) reached.add(s);
        if (reached.size === 0) for (const s of i.workspaceSpecsOf?.(f) ?? []) if (present.has(s)) reached.add(s);
        if (reached.size === 0 && Object.hasOwn(map.specs, f) && !present.has(f)) continue; // a spec that was deleted: nothing of it to run
        if (reached.size === 0) return full(all, 'uncovered_file', `no spec covers ${f}`);
        for (const s of reached) hit(s);
        if (Object.keys(reachedBy).length < REACHED_BY_LIMITS.files) reachedBy[f] = all.filter((x) => reached.has(x)).slice(0, REACHED_BY_LIMITS.specsPerFile);
    }

    const specs = all.filter((s) => selected.has(s));
    return { mode: 'selected', specs, diffCoverage, reachedBy, text: `selected ${specs.length} of ${all.length} specs: covers the ${files(relevant.length)}` };
}

/** The specs that cover the nearest importers of `file`, walking importers breadth first, bounded. */
function importerSpecs(file: string, importersOf: SelectInput['importersOf'], coveringSpecs: (f: string) => string[]): string[] {
    if (!importersOf) return [];
    const seen = new Set([file]);
    let frontier = [file];
    for (let depth = 1; depth <= IMPORTER_WALK.depth && frontier.length && seen.size < IMPORTER_WALK.nodes; depth++) {
        const next: string[] = [];
        const found = new Set<string>();
        for (const f of frontier) {
            for (const importer of importersOf(f)) {
                if (seen.has(importer) || seen.size >= IMPORTER_WALK.nodes) continue;
                seen.add(importer);
                for (const s of coveringSpecs(importer)) found.add(s);
                next.push(importer);
            }
        }
        if (found.size) return [...found];
        frontier = next;
    }
    return [];
}
