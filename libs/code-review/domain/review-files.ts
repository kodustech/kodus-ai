/** Exact, unfiltered provider count when available; never pipeline analysis stats. */
export function hasCompletePrFileList<T extends { filename?: string }>(
    files: readonly T[] | null | undefined,
    providerCount?: number,
): files is readonly T[] {
    return (
        !!files?.length &&
        files.every(
            (file) =>
                typeof file.filename === 'string' && file.filename.length > 0,
        ) &&
        (providerCount === undefined ||
            (Number.isSafeInteger(providerCount) &&
                providerCount >= 0 &&
                files.length === providerCount))
    );
}
