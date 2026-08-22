import chalk from 'chalk';
import { cliWarn } from '../utils/logger.js';
import type { FileContent } from '../types/review.js';

const MAX_FILES = 500;
// Must match the API DTO limits (apps/api/src/dtos/cli-review.dto.ts):
// per-file diff 500K and per-file content 2M — counted in characters
// (@MaxLength uses string length, not UTF-8 byte size). Using byte counts
// here would silently drop non-ASCII files that the API accepts.
const MAX_DIFF_CHARS = 500_000; // 500K characters
const MAX_CONTENT_CHARS = 2_000_000; // 2M characters

export function filterReviewFiles(
    files: FileContent[],
    quiet = false,
): FileContent[] {
    const skipped: string[] = [];
    const filtered = files.filter((file) => {
        const diffChars = file.diff.length;
        const contentChars = file.content.length;

        if (diffChars > MAX_DIFF_CHARS) {
            skipped.push(
                `  - ${file.path} (diff: ${diffChars.toLocaleString()} chars, max: 500,000)`,
            );
            return false;
        }

        if (contentChars > MAX_CONTENT_CHARS) {
            skipped.push(
                `  - ${file.path} (content: ${contentChars.toLocaleString()} chars, max: 2,000,000)`,
            );
            return false;
        }

        return true;
    });

    if (!quiet && skipped.length > 0) {
        cliWarn(
            chalk.yellow(
                `⚠ Skipped ${skipped.length} file(s) exceeding size limits:`,
            ),
        );
        skipped.forEach((message) => cliWarn(chalk.yellow(message)));
    }

    if (filtered.length > MAX_FILES) {
        if (!quiet) {
            cliWarn(
                chalk.yellow(
                    `⚠ Too many files (${filtered.length}), sending first ${MAX_FILES}`,
                ),
            );
        }
        return filtered.slice(0, MAX_FILES);
    }

    return filtered;
}
