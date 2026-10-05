/** A changed file as the code hosts return it. */
export interface ChangedFile {
    filename: string;
    status?: string;
    patch?: string;
}

/** The PR's patches in one text, the way the judge reads them. Files without a patch are left out. */
export function formatPullRequestDiff(
    files: ChangedFile[] | undefined,
): string {
    return (files ?? [])
        .filter((file) => typeof file.patch === 'string' && file.patch.trim())
        .map(
            (file) =>
                `=== FILE: ${file.filename} ===\nStatus: ${file.status ?? 'modified'}\n\n${file.patch}`,
        )
        .join('\n\n');
}
