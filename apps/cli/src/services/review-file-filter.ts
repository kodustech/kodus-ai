import chalk from 'chalk';
import { cliWarn } from '../utils/logger.js';
import type { FileContent } from '../types/review.js';

const MAX_FILES = 500;
// Must match the API DTO limits (apps/api/src/dtos/cli-review.dto.ts):
// per-file diff 500KB and per-file content 2MB. Sending larger payloads
// makes the server reject the whole review with a 400.
const MAX_DIFF_SIZE = 500_000; // 500KB
const MAX_CONTENT_SIZE = 2_000_000; // 2MB

export function filterReviewFiles(
    files: FileContent[],
    quiet = false,
): FileContent[] {
    const skipped: string[] = [];
    const filtered = files.filter((file) => {
        const diffBytes = Buffer.byteLength(file.diff, 'utf8');
        const contentBytes = Buffer.byteLength(file.content, 'utf8');

        if (diffBytes > MAX_DIFF_SIZE) {
            const sizeKB = Math.round(diffBytes / 1024);
            skipped.push(
                `  - ${file.path} (diff: ${sizeKB}KB, max: 500KB)`);
            return false;
        }

        if (contentBytes > MAX_CONTENT_SIZE) {
            const sizeMB = (contentBytes / (1024 * 1024)).toFixed(1);
            skipped.push(
                `  - ${file.path} (content: ${sizeMB}MB, max: 2MB)`
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
