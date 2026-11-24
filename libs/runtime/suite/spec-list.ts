import picomatch from 'picomatch';

import type { SuiteSpecFile } from './balance';

// The spec files one suite run executes (docs/runtime/e2e-suites.md section 3): the listing of main's checkout on a
// template host, widened by the specs the PR adds and narrowed by the ones it removes, because the template is main's
// build and a PR's new spec is not in it. Pure: the listing is an input.

export interface SpecListInput {
    /** The recipe's `suite.specs` glob, relative to `cwd`. */
    glob: string;
    /** The suite directory, relative to the repository root. */
    cwd?: string;
    /** The files the glob names on main, relative to `cwd`, with their sizes. */
    listed: readonly SuiteSpecFile[];
    /** The PR's changed and removed files, relative to the repository root. */
    changedFiles?: readonly string[];
    removedFiles?: readonly string[];
    /** A retry: exactly these specs, which ran in the run being retried (sizes from the listing when main has them). */
    only?: readonly string[];
}

const inside = (cwd: string | undefined, file: string): string | undefined => {
    if (!cwd) return file;
    const prefix = cwd.endsWith('/') ? cwd : `${cwd}/`;
    return file.startsWith(prefix) ? file.slice(prefix.length) : undefined;
};

export function specListOf(i: SpecListInput): SuiteSpecFile[] {
    const matches = picomatch(i.glob, { dot: true });
    const byPath = new Map<string, SuiteSpecFile>();
    for (const s of i.listed) if (matches(s.path)) byPath.set(s.path, s);
    for (const f of i.changedFiles ?? []) {
        const rel = inside(i.cwd, f);
        if (rel !== undefined && matches(rel) && !byPath.has(rel)) byPath.set(rel, { path: rel, sizeBytes: 0 });
    }
    for (const f of i.removedFiles ?? []) {
        const rel = inside(i.cwd, f);
        if (rel !== undefined) byPath.delete(rel);
    }
    const out = i.only ? [...new Set(i.only)].map((path) => byPath.get(path) ?? i.listed.find((s) => s.path === path) ?? { path, sizeBytes: 0 }) : [...byPath.values()];
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
