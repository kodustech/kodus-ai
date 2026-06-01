import chalk from 'chalk';
import { cliWarn } from '../utils/logger.js';
import type { FileContent } from '../types/review.js';

const MAX_FILES = 500;
const MAX_DIFF_SIZE = 1024 * 1024; // 1MB
const MAX_CONTENT_SIZE = 5 * 1024 * 1024; // 5MB

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
                `  - ${file.path} (diff: ${sizeKB}KB, max: ${MAX_DIFF_SIZE / 1024}KB)`,
            );
            return false;
        }

        if (contentBytes > MAX_CONTENT_SIZE) {
            const sizeMB = (contentBytes / (1024 * 1024)).toFixed(1);
            skipped.push(
                `  - ${file.path} (content: ${sizeMB}MB, max: ${MAX_CONTENT_SIZE / (1024 * 1024)}MB)`,
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
