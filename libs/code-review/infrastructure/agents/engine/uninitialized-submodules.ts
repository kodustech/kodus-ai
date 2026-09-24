import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

/**
 * Tell the agent apart "this code is not in the repository" from "this code was
 * never fetched into the sandbox".
 *
 * The sandbox checkout is a shallow `git fetch` with no `git submodule update`
 * (see `e2b-sandbox.service.ts#cloneRepository` / `local-sandbox.service.ts`),
 * so every path a repository declares in `.gitmodules` exists as an EMPTY
 * directory. `listDir` then returns '', `grep` returns "No matches found." and
 * `findFile` returns "No files matching" — none of which carries any hint that
 * the content was never there to be searched. The finder read that absence as
 * proof and published "X is undefined everywhere in the repo" (critical); the
 * verifier re-ran the same empty search and kept the finding. Measured on one
 * org over a month: 66 of 317 developer-refuted findings touch the submodule
 * packages, including 13 of the 13 "references an API that does not exist"
 * refutations (#1939).
 *
 * The same trace shows the second half of the same mistake: after the empty
 * submodule search the model fell back to `node_modules/@<vendor>/<pkg>` and
 * got `No such file or directory`. The sandbox has no package-manager install
 * step (`installDependencies` installs git and ripgrep, nothing else), so
 * `node_modules` is absent in EVERY review, by construction — and the tool
 * layer's IGNORE_DIRS filter strips `node_modules` lines from listings anyway.
 * A dependency that is not on disk is not a dependency that does not exist.
 *
 * This module does not fetch or install anything. It only makes the empty
 * answer say why it is empty, so absence stops being evidence.
 */

/** Exact phrases the agent sees; also what the tests assert on. */
export const UNINITIALIZED_SUBMODULE_MARKER =
    '[uninitialized submodule — contents not fetched]';
export const MISSING_DEPENDENCIES_MARKER =
    '[dependencies not installed — node_modules was never created]';

/**
 * Paths declared as submodules in a `.gitmodules` file.
 *
 * A line scanner, unlike the fetch side, which reads the same file through
 * `git config -f`. That asymmetry is deliberate: reading it through git here
 * would mean running `git` inside the sandbox, and the local provider's
 * `exec` is a strict allowlist of read-only programs precisely because it
 * runs on the host with no container isolation (`local-sandbox.service.ts`).
 * Widening that allowlist to make two parsers match is a worse trade than
 * keeping this one.
 *
 * It is safe HERE because of what it is used for: a set of repo-relative
 * paths, compared as strings, to decide whether an EMPTY answer gets a note.
 * It reads no url and reaches no network, and it errs by matching `path =`
 * too eagerly — which adds a note, never removes one. On the fetch side the
 * same mistake picked the wrong url, which is why that side must use git.
 */
export function parseGitmodulesPaths(content: string): string[] {
    const paths: string[] = [];
    for (const rawLine of String(content || '').split('\n')) {
        const line = rawLine.trim();
        // `path = packages/foo` — the key is case-insensitive in git config.
        const match = /^path\s*=\s*(.+)$/i.exec(line);
        if (!match) continue;
        const value = normalize(match[1].trim());
        if (value && value !== '.' && !paths.includes(value)) {
            paths.push(value);
        }
    }
    return paths;
}

/** Repo-relative, no leading `./` or `/`, no trailing slash, forward slashes. */
function normalize(value: string): string {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/^\/+/, '')
        .replace(/^\.\//, '')
        .replace(/\/+/g, '/')
        .replace(/\/+$/, '');
}

/** True when `candidate` is `ancestor` itself or sits under it. */
function isAtOrUnder(candidate: string, ancestor: string): boolean {
    if (ancestor === '' || ancestor === '.') return true;
    return candidate === ancestor || candidate.startsWith(`${ancestor}/`);
}

export interface SubmoduleProbe {
    /**
     * Given the path a tool just searched and came back empty from, return the
     * explanation to show the agent, or null when the emptiness is genuine.
     *
     * Called ONLY on an empty result, so a repository with no `.gitmodules`
     * (the overwhelming majority) pays one failed `read` per review and nothing
     * else.
     */
    explainEmptyResult(searchedPath: string): Promise<string | null>;
}

/**
 * Build a probe bound to one sandbox. `.gitmodules` is read at most once, and
 * each submodule directory is emptiness-checked at most once, for the whole
 * lifetime of the tool set.
 */
export function createSubmoduleProbe(
    remoteCommands: Pick<RemoteCommands, 'read' | 'listDir'>,
): SubmoduleProbe {
    let declaredPaths: Promise<string[]> | null = null;
    const emptiness = new Map<string, Promise<boolean>>();

    /**
     * The `node_modules` directory a searched path sits under, or null.
     * Handles the monorepo shape too (`apps/web/node_modules/react`), where the
     * nearest install root is not at the repo root.
     */
    const enclosingNodeModules = (searched: string): string | null => {
        const segments = searched.split('/');
        const index = segments.indexOf('node_modules');
        return index === -1 ? null : segments.slice(0, index + 1).join('/');
    };

    const getDeclaredPaths = (): Promise<string[]> => {
        if (!declaredPaths) {
            declaredPaths = remoteCommands
                .read('.gitmodules', 0, 0)
                .then((content) => parseGitmodulesPaths(content))
                // No `.gitmodules` is the normal case and both providers signal
                // it by throwing (E2B rethrows cat's stderr, local rethrows
                // ENOENT from resolveSafePath). Absence of the file is the
                // answer, not an error worth surfacing.
                .catch(() => [] as string[]);
        }
        return declaredPaths;
    };

    const isEmpty = (submodulePath: string): Promise<boolean> => {
        let cached = emptiness.get(submodulePath);
        if (!cached) {
            // maxDepth 2 rather than 1: a populated submodule whose files all
            // live under `src/` has nothing at depth 1, and reporting it as
            // uninitialized would be the same lie in the other direction.
            cached = remoteCommands
                .listDir(submodulePath, 2)
                .then((listing) => !String(listing || '').trim())
                // A listing that FAILED is not a listing that came back empty —
                // never claim "uninitialized submodule" on the strength of a
                // broken lookup.
                .catch(() => false);
            emptiness.set(submodulePath, cached);
        }
        return cached;
    };

    return {
        async explainEmptyResult(searchedPath: string): Promise<string | null> {
            const searched = normalize(searchedPath) || '.';

            // Dependencies first: a path under `node_modules` is never about a
            // submodule, and it is the cheaper question to answer.
            const nodeModules = enclosingNodeModules(searched);
            if (nodeModules) {
                // Verified, not assumed — a sandbox that DID get an install
                // must not be told its dependencies are missing.
                if (!(await isEmpty(nodeModules))) return null;
                return (
                    `${MISSING_DEPENDENCIES_MARKER}\n` +
                    `The review sandbox checks the repository out but never runs a ` +
                    `package-manager install, so \`${nodeModules}\` does not exist here. ` +
                    `This empty result is NOT evidence that the package, export or type ` +
                    `is missing — it was never installed. Read the dependency's usage in ` +
                    `the repository, or its package.json entry, instead of concluding ` +
                    `from this search that it does not exist.`
                );
            }

            const declared = await getDeclaredPaths();
            if (declared.length === 0) return null;

            // Two ways an empty answer can be a submodule artefact:
            //  - the tool searched the submodule itself, or a path inside it
            //    (`packages/commons`, `packages/commons/utils/date`);
            //  - the tool searched an ANCESTOR whose only content under that
            //    subtree is uninitialized submodules (`packages`, or `.`) —
            //    this is the shape the reported traces actually used.
            const relevant = declared.filter(
                (submodule) =>
                    isAtOrUnder(searched, submodule) ||
                    isAtOrUnder(submodule, searched),
            );
            if (relevant.length === 0) return null;

            const uninitialized: string[] = [];
            for (const submodule of relevant) {
                if (await isEmpty(submodule)) uninitialized.push(submodule);
            }
            if (uninitialized.length === 0) return null;

            return (
                `${UNINITIALIZED_SUBMODULE_MARKER}\n` +
                `This repository declares ${uninitialized.length === 1 ? 'a submodule' : 'submodules'} in .gitmodules that the ` +
                `sandbox checkout did not fetch: ${uninitialized.join(', ')}. ` +
                `${uninitialized.length === 1 ? 'That directory is' : 'Those directories are'} empty here, so this empty result is ` +
                `NOT evidence that the code is missing from the repository — the code ` +
                `was never fetched. Do not report a symbol, module or export as ` +
                `undefined, missing or non-existent on the strength of a search that ` +
                `covered ${uninitialized.length === 1 ? 'this path' : 'these paths'}.`
            );
        },
    };
}
