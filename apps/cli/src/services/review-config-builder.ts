import type { FileContent, ReviewConfig } from '../types/review.js';

export async function buildReviewConfig({
    rulesOnly,
    fast,
    options,
    getFullFileContents,
    filterFiles,
}: {
    rulesOnly?: boolean;
    fast?: boolean;
    options?: {
        files?: string[];
        staged?: boolean;
        commit?: string;
        branch?: string;
        quiet?: boolean;
    };
    getFullFileContents: (
        files?: string[],
        options?: {
            staged?: boolean;
            commit?: string;
            branch?: string;
        },
    ) => Promise<FileContent[]>;
    filterFiles: (files: FileContent[], quiet?: boolean) => FileContent[];
}): Promise<ReviewConfig> {
    const reviewConfig: ReviewConfig = {
        rulesOnly,
        fast,
    };

    // Skip inlining file contents when:
    //   - fast mode: the server runs with a capped step budget; the full
    //     file bodies are extra payload with diminishing returns.
    //   - branch / commit mode: the diff is computed against committed
    //     history, so the backend can clone the same commit into its
    //     sandbox and read files from there (via readFile/grep). Sending
    //     20+ MB of inlined content per request on large refactors blew
    //     past the backend's body parser limit for no benefit.
    //
    // Working-tree reviews (default and --staged) still inline files, since
    // local WIP changes don't exist on any remote the backend could clone.
    const skipInlining = fast || !!options?.branch || !!options?.commit;
    if (skipInlining) {
        return reviewConfig;
    }

    const allFiles = await getFullFileContents(options?.files, {
        staged: options?.staged,
        commit: options?.commit,
        branch: options?.branch,
    });

    reviewConfig.files = filterFiles(allFiles, options?.quiet ?? false);

    return reviewConfig;
}
