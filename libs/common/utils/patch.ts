/**
 * Minimizes a patch by removing hunks that only contain deletions.
 * @param patch The patch to minimize.
 * @param fileName The name of the file being processed.
 * @param editType The type of edit being processed.
 * @returns The minimized patch, or `null` if the patch was empty.
 */
export function handlePatchDeletions(
    patch: string,
    fileName: string,
    editType: string,
): string | null {
    if (!patch && editType !== 'modified' && editType !== 'added') {
        return null;
    } else {
        const patchLines = patch?.split('\n');
        const patchNew = omitDeletionHunks(patchLines);
        if (patch !== patchNew) {
            return patchNew;
        }
    }
    return patch;
}

/**
 * Omit hunks that only contain deletions from a patch.
 * @param patchLines The lines of the patch to process.
 * @returns The patch with only hunks that contain additions.
 */
function omitDeletionHunks(patchLines: string[]): string {
    const tempHunk: string[] = [];
    const addedPatched: string[] = [];
    let addHunk = false;
    let insideHunk = false;
    const RE_HUNK_HEADER =
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)/;

    for (const line of patchLines) {
        if (line.startsWith('@@')) {
            const match = line.match(RE_HUNK_HEADER);
            if (match) {
                if (insideHunk && addHunk) {
                    addedPatched.push(...tempHunk);
                    tempHunk.length = 0;
                    addHunk = false;
                }
                tempHunk.push(line);
                insideHunk = true;
            }
        } else {
            tempHunk.push(line);
            const editType = line.charAt(0);
            if (editType === '+') {
                addHunk = true;
            }
        }
    }

    if (insideHunk && addHunk) {
        addedPatched.push(...tempHunk);
    }

    return addedPatched.join('\n');
}

/**
 * Convert a patch to hunks with line numbers.
 * Uses __new hunk__ / __old hunk__ format with line numbers on new hunk only.
 * @param patch The patch to convert.
 * @param file The file being processed.
 * @returns The converted patch.
 */
// Maximum number of lines to process to prevent DoS attacks
const MAX_PATCH_LINES = 50000;

export function convertToHunksWithLinesNumbers(
    patch: string,
    file: { filename?: string },
): string {
    let patchWithLinesStr = `\n\n## file: '${file.filename.trim()}'\n`;
    const patchLines = patch.split('\n').slice(0, MAX_PATCH_LINES);
    const RE_HUNK_HEADER =
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)/;

    let newContentLines: string[] = [];
    let oldContentLines: string[] = [];
    let match: RegExpMatchArray | null = null;
    let start1 = -1,
        size1 = -1,
        start2 = -1,
        size2 = -1;
    let prevHeaderLine = '';
    let headerLine = '';

    for (const line of patchLines) {
        if (line.toLowerCase().includes('no newline at end of file')) {
            continue;
        }

        if (line.startsWith('@@')) {
            headerLine = line;
            match = line.match(RE_HUNK_HEADER);

            if (
                match &&
                (newContentLines.length > 0 || oldContentLines.length > 0)
            ) {
                // Found a new hunk, split the previous lines
                if (prevHeaderLine) {
                    patchWithLinesStr += `\n${prevHeaderLine}\n`;
                }
                if (newContentLines.length > 0) {
                    const isPlusLines = newContentLines.some((line) =>
                        line.startsWith('+'),
                    );
                    if (isPlusLines) {
                        patchWithLinesStr =
                            patchWithLinesStr.trimEnd() + '\n__new hunk__\n';
                        for (let i = 0; i < newContentLines.length; i++) {
                            patchWithLinesStr += `${start2 + i} ${newContentLines[i]}\n`;
                        }
                    }
                }
                if (oldContentLines.length > 0) {
                    const isMinusLines = oldContentLines.some((line) =>
                        line.startsWith('-'),
                    );
                    if (isMinusLines) {
                        patchWithLinesStr =
                            patchWithLinesStr.trimEnd() + '\n__old hunk__\n';
                        for (const lineOld of oldContentLines) {
                            patchWithLinesStr += `${lineOld}\n`;
                        }
                    }
                }
                newContentLines = [];
                oldContentLines = [];
            }

            if (match) {
                prevHeaderLine = headerLine;

                const res = match
                    .slice(1, 5)
                    .map((val) => parseInt(val || '0', 10));
                [start1, size1, start2, size2] = res;
            }
        } else if (line.startsWith('+')) {
            newContentLines.push(line);
        } else if (line.startsWith('-')) {
            oldContentLines.push(line);
        } else {
            newContentLines.push(line);
            oldContentLines.push(line);
        }
    }

    // Finishing last hunk
    if (match && newContentLines.length > 0) {
        patchWithLinesStr += `\n${headerLine}\n`;
        if (newContentLines.length > 0) {
            const isPlusLines = newContentLines.some((line) =>
                line.startsWith('+'),
            );
            if (isPlusLines) {
                patchWithLinesStr =
                    patchWithLinesStr.trimEnd() + '\n__new hunk__\n';
                for (let i = 0; i < newContentLines.length; i++) {
                    patchWithLinesStr += `${start2 + i} ${newContentLines[i]}\n`;
                }
            }
        }
        if (oldContentLines.length > 0) {
            const isMinusLines = oldContentLines.some((line) =>
                line.startsWith('-'),
            );
            if (isMinusLines) {
                patchWithLinesStr =
                    patchWithLinesStr.trimEnd() + '\n__old hunk__\n';
                for (const lineOld of oldContentLines) {
                    patchWithLinesStr += `${lineOld}\n`;
                }
            }
        }
    }

    return patchWithLinesStr.trim();
}

/**
 * Convert a patch to standard unified diff with new-file line numbers.
 * Keeps the unified diff interleaving intact — no __new hunk__ / __old hunk__ separation.
 *
 * Output format:
 *   ## file: 'src/service.ts'
 *   @@ -10,5 +10,7 @@
 *        10  context line
 *        11 +added line
 *        12  context line
 *            -removed line
 *        13  another context
 *
 * Rules:
 * - Context lines (' ') and added lines ('+'): get new-file line number
 * - Removed lines ('-'): no number (padding with spaces) — they don't exist in the new file
 * - Hunk headers ('@@') kept as-is
 */
export function convertToUnifiedDiffWithLineNumbers(
    patch: string,
    file: { filename?: string },
): string {
    if (!patch) return '';

    const lines = patch.split('\n').slice(0, MAX_PATCH_LINES);
    const RE_HUNK_HEADER =
        /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@[ ]?(.*)/;
    const result: string[] = [`## file: '${file.filename?.trim()}'`];

    let newLine = 0;

    for (const line of lines) {
        if (line.toLowerCase().includes('no newline at end of file')) {
            continue;
        }

        const match = line.match(RE_HUNK_HEADER);
        if (match) {
            newLine = parseInt(match[3], 10);
            result.push(line);
            continue;
        }

        if (line.startsWith('+')) {
            result.push(`${String(newLine).padStart(6)} ${line}`);
            newLine++;
        } else if (line.startsWith('-')) {
            result.push(`${''.padStart(6)} ${line}`);
        } else {
            result.push(`${String(newLine).padStart(6)} ${line}`);
            newLine++;
        }
    }

    return result.join('\n');
}

interface ModifiedRange {
    start: number;
    end: number;
}

/**
 * Extracts the modification ranges from a diff.
 * Each range represents a continuous block of code that was modified.
 * Supports the __new hunk__ / __old hunk__ format.
 *
 * @param diffHunk The diff to be analyzed
 * @returns Array of ranges (start and end) of the modifications
 */
export function extractLinesFromDiffHunk(diffHunk: string): ModifiedRange[] {
    const lines = diffHunk?.split('\n');
    const modifiedRanges: ModifiedRange[] = [];

    let currentHunkStart = 0;
    let currentRange: ModifiedRange | null = null;

    for (const line of lines) {
        // If the hunk header is found (e.g., @@ -27,7 +27,7 @@)
        if (line?.startsWith('@@')) {
            const match = line?.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
            if (match) {
                currentHunkStart = parseInt(match[1], 10);

                // If there was an open range, close it
                if (currentRange) {
                    modifiedRanges.push(currentRange);
                    currentRange = null;
                }
            }
            continue;
        }

        // Ignore hunk marker lines
        if (line?.includes('__new hunk__') || line?.includes('__old hunk__')) {
            continue;
        }

        // Look for lines that were modified (added or removed)
        const lineMatch = line?.match(/^(\d+) ([+-])/);
        if (lineMatch) {
            const lineNumber = parseInt(lineMatch[1], 10);
            const changeType = lineMatch[2];

            // Only consider added lines (+)
            if (changeType === '+') {
                if (!currentRange) {
                    currentRange = {
                        start: lineNumber,
                        end: lineNumber,
                    };
                } else if (lineNumber === currentRange.end + 1) {
                    // If it's a consecutive line, update the range's end
                    currentRange.end = lineNumber;
                } else {
                    // If it's not consecutive, close the current range and start a new one
                    modifiedRanges.push(currentRange);
                    currentRange = {
                        start: lineNumber,
                        end: lineNumber,
                    };
                }
            }
        } else {
            // If a non-modified line is found, close the current range
            if (currentRange) {
                modifiedRanges.push(currentRange);
                currentRange = null;
            }
        }
    }

    // If there's an open range left at the end, close it
    if (currentRange) {
        modifiedRanges.push(currentRange);
    }

    return modifiedRanges;
}

/**
 * Extracts the modification ranges from a unified diff with padded line numbers.
 * Companion to convertToUnifiedDiffWithLineNumbers.
 *
 * Supports format:
 *     10 +added line       → line 10 is added
 *        -removed line     → no number (ignored for ranges)
 *     11  context line     → line 11 is context
 *
 * @param diffHunk The diff to be analyzed
 * @returns Array of ranges (start and end) of the modifications
 */
export function extractLinesFromUnifiedDiff(diffHunk: string): ModifiedRange[] {
    const lines = diffHunk?.split('\n');
    const modifiedRanges: ModifiedRange[] = [];

    let currentRange: ModifiedRange | null = null;

    const RE_ADDED_LINE = /^\s*(\d+)\s\+/;

    for (const line of lines) {
        if (!line || line.startsWith('@@') || line.startsWith('## file:')) {
            if (currentRange) {
                modifiedRanges.push(currentRange);
                currentRange = null;
            }
            continue;
        }

        const addedMatch = line.match(RE_ADDED_LINE);
        if (addedMatch) {
            const lineNumber = parseInt(addedMatch[1], 10);

            if (!currentRange) {
                currentRange = { start: lineNumber, end: lineNumber };
            } else if (lineNumber === currentRange.end + 1) {
                currentRange.end = lineNumber;
            } else {
                modifiedRanges.push(currentRange);
                currentRange = { start: lineNumber, end: lineNumber };
            }
        } else {
            if (currentRange) {
                modifiedRanges.push(currentRange);
                currentRange = null;
            }
        }
    }

    if (currentRange) {
        modifiedRanges.push(currentRange);
    }

    return modifiedRanges;
}
