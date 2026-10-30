import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import chalk from 'chalk';
import { resolveKodusExtensionDir, runHunk } from '../../utils/hunk.js';
import { cliDebug, isCliVerboseMode } from '../../utils/logger.js';
import { convertReviewToHunkContext } from './hunk-context.js';
import { convertReviewToHunkFindings } from './hunk-findings.js';
import type { ReviewResult } from '../../types/review.js';

export interface HunkViewerScope {
    /** When true, opens hunk against the staged index instead of the working tree. */
    staged?: boolean;
    /**
     * Git range to review (`hunk diff <range>`), used for `--branch`.
     * Mutually exclusive with `commit`.
     */
    range?: string;
    /** Single commit to review (`hunk show <ref>`), used for `--commit`. */
    commit?: string;
    /** Pathspec limiting the review, forwarded after `--`. */
    paths?: string[];
}

export interface ReviewScopeOptions {
    files?: string[];
    commit?: string;
    branch?: string;
    staged?: boolean;
}

/**
 * Translate `kodus review` scoping options into the equivalent hunk invocation.
 *
 * hunk understands the same shapes git does — `hunk diff <range>`,
 * `hunk show <ref>`, `--staged`, and a trailing `-- <pathspec...>` — so every
 * review scope we support maps onto it. Returns `null` only for combinations
 * hunk genuinely can't express, in which case the caller falls back to the
 * legacy interactive list.
 */
export function buildHunkViewerScope(
    opts: ReviewScopeOptions,
): HunkViewerScope | null {
    const paths = opts.files && opts.files.length > 0 ? opts.files : undefined;

    // `--commit` and `--branch` describe two different anchors; git (and hunk)
    // have no single invocation that means both.
    if (opts.commit && opts.branch) {
        return null;
    }

    if (opts.commit) {
        return { commit: opts.commit, paths };
    }

    if (opts.branch) {
        // Mirrors the diff the API reviewed: `git diff <branch>...HEAD`.
        return { range: `${opts.branch}...HEAD`, paths };
    }

    return { staged: Boolean(opts.staged), paths };
}

export function canRenderScopeInHunk(opts: ReviewScopeOptions): boolean {
    return buildHunkViewerScope(opts) !== null;
}

/** Build the argv `hunk` should be spawned with for a given scope. */
export function buildHunkArgs(
    scope: HunkViewerScope,
    contextPath: string,
    extensionDir?: string | null,
): string[] {
    const args: string[] = [];

    if (scope.commit) {
        args.push('show', scope.commit);
    } else {
        args.push('diff');
        if (scope.range) {
            args.push(scope.range);
        } else if (scope.staged) {
            args.push('--staged');
        }
    }

    args.push('--agent-context', contextPath, '--agent-notes');

    // Opts into STML note bodies so a finding's explanation, its fix and any
    // suggested patch render as separate blocks instead of one reflowed
    // paragraph. Hunk falls back to the plain summary/rationale if the markup
    // is rejected, so this is safe on its own.
    args.push('--experimental');

    if (extensionDir) {
        // `--extension` is explicit user intent as far as hunk is concerned, so
        // it loads with no trust prompt. Safe here: the path is ours, inside
        // the installed @kodus/cli package, never anything from the repo under
        // review.
        args.push('--extension', extensionDir);
    }

    // Must stay last: everything after `--` is a pathspec.
    if (scope.paths && scope.paths.length > 0) {
        args.push('--', ...scope.paths);
    }

    return args;
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
    const runId = randomUUID();
    const contextPath = path.join(os.tmpdir(), `kodus-review-${runId}.json`);
    const findingsPath = path.join(os.tmpdir(), `kodus-findings-${runId}.json`);

    await fs.writeFile(contextPath, JSON.stringify(context, null, 2), 'utf-8');

    // Structured sidecar for the bundled sidebar extension. Written even when
    // the extension is missing — it's cheap, and it keeps the two paths from
    // drifting apart.
    const findings = convertReviewToHunkFindings(options.result);
    await fs.writeFile(
        findingsPath,
        JSON.stringify(findings, null, 2),
        'utf-8',
    );

    const extensionDir = resolveKodusExtensionDir();

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
        const args = buildHunkArgs(options.scope, contextPath, extensionDir);
        if (isCliVerboseMode()) {
            cliDebug(
                chalk.dim(
                    `[verbose] hunk: spawning \`hunk ${args.join(' ')}\``,
                ),
            );
            if (!extensionDir) {
                cliDebug(
                    chalk.dim(
                        '[verbose] hunk: Kodus sidebar extension not found on disk; skipping --extension',
                    ),
                );
            }
        }
        return await runHunk(args, {
            execa: { env: { KODUS_HUNK_FINDINGS: findingsPath } },
        });
    } finally {
        if (options.keepContextOnExit) {
            cliDebug(
                chalk.dim(
                    `[verbose] hunk: agent-context kept at ${contextPath}, findings at ${findingsPath}`,
                ),
            );
        } else {
            // best-effort cleanup; tempdir is reaped by the OS anyway.
            await Promise.all([
                fs.unlink(contextPath).catch(() => {}),
                fs.unlink(findingsPath).catch(() => {}),
            ]);
        }
    }
}
