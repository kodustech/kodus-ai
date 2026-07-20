import type { DiffFile } from "./types";

/**
 * "Cohorts" group a PR's changed files by the ROLE each file plays in the
 * change, and order the groups by natural reading order — the API surface and
 * data shapes others depend on first, the code that consumes them next, tests
 * after that, and config/docs last. It's the "read this change in layers"
 * idea: foundational files before the code that builds on them.
 *
 * This v1 is a DETERMINISTIC classifier over the path/extension we already
 * have on the client — no extra request, no model call. The cohort shape is
 * deliberately the seam where a Kody-decided grouping can later drop in: if a
 * file arrives carrying its own `cohort` hint from the backend, prefer that
 * over the heuristic (see resolveCohort) and the rest of this file — ordering,
 * rendering — keeps working unchanged.
 */

export type CohortKey =
    | "contracts"
    | "migrations"
    | "implementation"
    | "styles"
    | "tests"
    | "config"
    | "docs"
    | "other";

export interface CohortMeta {
    key: CohortKey;
    /** Human label shown as the group header. */
    label: string;
    /** One-line reason the group exists — shown as a subtitle/tooltip. */
    hint: string;
}

/**
 * Display order = reading order. Foundational layers first (the things other
 * code depends on), consumers next, verification and prose last. Only groups
 * with files render, so a docs-only PR still reads top-to-bottom sensibly.
 */
export const COHORT_ORDER: readonly CohortMeta[] = [
    {
        key: "contracts",
        label: "Contracts & types",
        hint: "APIs, types, schemas and entities other code depends on — read these first",
    },
    {
        key: "migrations",
        label: "Data & migrations",
        hint: "Schema and data migrations",
    },
    {
        key: "implementation",
        label: "Implementation",
        hint: "Application code that consumes the contracts above",
    },
    {
        key: "styles",
        label: "Styles",
        hint: "Stylesheets and design tokens",
    },
    {
        key: "tests",
        label: "Tests",
        hint: "Specs and end-to-end coverage for the changes above",
    },
    {
        key: "config",
        label: "Config & CI",
        hint: "Build, dependency, CI and infrastructure config",
    },
    {
        key: "docs",
        label: "Docs",
        hint: "Documentation and prose",
    },
    {
        key: "other",
        label: "Other",
        hint: "Files that didn't match a known role",
    },
] as const;

const COHORT_META: Record<CohortKey, CohortMeta> = Object.fromEntries(
    COHORT_ORDER.map((c) => [c.key, c]),
) as Record<CohortKey, CohortMeta>;

const TEST_RE =
    /(^|\/)(__tests__|__mocks__|e2e|cypress)(\/)|\.(spec|test|stories|e2e)\.[cm]?[jt]sx?$/i;
const MIGRATION_RE = /(^|\/)migrations?(\/)|\.sql$/i;
const STYLE_RE = /\.(css|scss|sass|less|styl)$/i;
const DOC_RE =
    /(^|\/)docs?(\/)|\.(md|mdx|rst|adoc)$|(^|\/)(readme|license|changelog|contributing)(\.[^/]*)?$/i;
// Config files are matched by well-known basenames as well as extensions,
// because many carry no telltale directory (a root tsconfig.json, a Dockerfile).
const CONFIG_BASENAME_RE =
    /(^|\/)(dockerfile|docker-compose\.ya?ml|\.dockerignore|\.gitignore|\.gitattributes|package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.ya?ml|pnpm-workspace\.ya?ml|cargo\.(toml|lock)|go\.(mod|sum)|requirements\.txt|pyproject\.toml|poetry\.lock|gemfile(\.lock)?|makefile|tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[^/]*|prettier\.config\.[^/]*|vitest\.config\.[^/]*|jest\.config\.[^/]*|next\.config\.[^/]*|tailwind\.config\.[^/]*|postcss\.config\.[^/]*|vite\.config\.[^/]*|\.npmrc|\.nvmrc|\.env(\.[^/]*)?)$/i;
const CONFIG_PATH_RE =
    /(^|\/)(\.github|\.circleci|\.husky|\.vscode|k8s|helm|terraform|charts)(\/)/i;
const CONFIG_EXT_RE = /\.(ya?ml|toml|ini|cfg|conf)$/i;
const CONTRACT_PATH_RE =
    /(^|\/)(contracts?|dtos?|interfaces?|schemas?|types?|entities|proto|graphql)(\/)/i;
const CONTRACT_NAME_RE =
    /\.(dto|contract|interface|schema|entity|model|type|types)\.[cm]?[jt]sx?$|\.(proto|graphql|gql)$|\.d\.ts$|(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$/i;
const CODE_EXT_RE =
    /\.([cm]?[jt]sx?|py|go|rb|rs|java|kt|kts|swift|scala|php|c|cc|cpp|h|hpp|cs|vue|svelte|ex|exs|clj|dart|lua|sh|bash)$/i;

/**
 * Classify one file into a cohort. Order matters: the most role-specific
 * signals win. A `foo.spec.ts` under `contracts/` is a TEST, not a contract,
 * so the test check runs before the contract check; config basenames win over
 * their generic extension (a `tsconfig.json` is config, not "implementation").
 */
export function classifyCohort(path: string): CohortKey {
    const p = path.trim();
    if (!p) return "other";
    if (TEST_RE.test(p)) return "tests";
    if (MIGRATION_RE.test(p)) return "migrations";
    if (DOC_RE.test(p)) return "docs";
    if (CONFIG_BASENAME_RE.test(p) || CONFIG_PATH_RE.test(p)) return "config";
    if (STYLE_RE.test(p)) return "styles";
    if (CONTRACT_NAME_RE.test(p) || CONTRACT_PATH_RE.test(p))
        return "contracts";
    if (CODE_EXT_RE.test(p)) return "implementation";
    // A bare .yml/.toml that isn't CI/infra still reads as config.
    if (CONFIG_EXT_RE.test(p)) return "config";
    return "other";
}

export interface Cohort {
    meta: CohortMeta;
    files: DiffFile[];
    additions: number;
    deletions: number;
}

/**
 * Group files into cohorts, ordered by COHORT_ORDER, dropping empty groups.
 * Files inside a cohort keep a stable path-alpha order so the list is
 * predictable across renders. A future backend `cohort` hint on the file
 * overrides the heuristic without touching callers.
 */
export function buildCohorts(files: DiffFile[]): Cohort[] {
    const buckets = new Map<CohortKey, DiffFile[]>();
    for (const file of files) {
        const key = resolveCohort(file);
        const list = buckets.get(key);
        if (list) list.push(file);
        else buckets.set(key, [file]);
    }

    const out: Cohort[] = [];
    for (const meta of COHORT_ORDER) {
        const bucket = buckets.get(meta.key);
        if (!bucket || bucket.length === 0) continue;
        const sorted = [...bucket].sort((a, b) => a.path.localeCompare(b.path));
        out.push({
            meta,
            files: sorted,
            additions: sorted.reduce((n, f) => n + (f.additions ?? 0), 0),
            deletions: sorted.reduce((n, f) => n + (f.deletions ?? 0), 0),
        });
    }
    return out;
}

/**
 * Prefer a backend-supplied cohort hint when present (the Kody-decided path),
 * else fall back to the deterministic classifier. Kept isolated so wiring the
 * LLM grouping later is a one-field change here, not a rewrite.
 */
function resolveCohort(file: DiffFile): CohortKey {
    const hint = (file as DiffFile & { cohort?: string }).cohort;
    if (hint && hint in COHORT_META) return hint as CohortKey;
    return classifyCohort(file.path);
}
