import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { runHunk } from '../../utils/hunk.js';
import { cliDebug, isCliVerboseMode } from '../../utils/logger.js';
import { convertReviewToHunkContext } from './hunk-context.js';
import type { ReviewResult } from '../../types/review.js';

export interface HunkViewerScope {
    /** When true, opens hunk against the staged index instead of the working tree. */
    staged?: boolean;
}

/**
 * Subset of `kodus review` options the hunk viewer can faithfully render.
 * Anything beyond this (specific files, --commit, --branch) currently has no
 * direct hunk equivalent so the caller should fall back to the terminal output.
 */
export function canRenderScopeInHunk(opts: {
    files?: string[];
    commit?: string;
    branch?: string;
}): boolean {
    if (opts.files && opts.files.length > 0) {
        return false;
    }
    if (opts.commit) {
        return false;
    }
    if (opts.branch) {
        return false;
    }
    return true;
}

export interface OpenReviewInHunkOptions {
    result: ReviewResult;
    scope: HunkViewerScope;
    /** When true, keep the agent-context tempfile after hunk exits (debugging). */
    keepContextOnExit?: boolean;
}

export async function openReviewInHunk(
    options: OpenReviewInHunkOptions,
): Promise<{ exitCode: number }> {
    const context = convertReviewToHunkContext(options.result);
    const contextPath = path.join(
        os.tmpdir(),
        `kodus-review-${randomUUID()}.json`,
    );

    await fs.writeFile(contextPath, JSON.stringify(context, null, 2), 'utf-8');

    if (isCliVerboseMode()) {
        const totalAnnotations = context.files.reduce(
            (sum, file) => sum + file.annotations.length,
            0,
        );
        cliDebug(
            chalk.dim(
                `[verbose] hunk: agent-context written to ${contextPath}`,
            ),
        );
        cliDebug(
            chalk.dim(
                `[verbose] hunk: ${context.files.length} file(s), ${totalAnnotations} annotation(s) after conversion`,
            ),
        );
        for (const file of context.files) {
            cliDebug(
                chalk.dim(
                    `[verbose]   - ${file.path}: ${file.annotations
                        .map((a) => `${a.newRange[0]}-${a.newRange[1]}`)
                        .join(', ')}`,
                ),
            );
        }
    }

    try {
        const args = ['diff'];
        if (options.scope.staged) {
            args.push('--staged');
        }
        args.push('--agent-context', contextPath, '--agent-notes');
        return await runHunk(args);
    } finally {
        if (options.keepContextOnExit) {
            cliDebug(
                chalk.dim(
                    `[verbose] hunk: agent-context kept at ${contextPath} (inspect with: cat ${contextPath})`,
                ),
            );
        } else {
            await fs.unlink(contextPath).catch(() => {
                // best-effort cleanup; tempdir is reaped by the OS anyway.
            });
        }
    }
}
