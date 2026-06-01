import { Command } from 'commander';
import ora, { type Ora } from 'ora';
import chalk from 'chalk';
import fs from 'fs/promises';
import { gitService } from '../../services/git.service.js';
import { reviewService } from '../../services/review.service.js';
import { authService } from '../../services/auth.service.js';
import { contextService } from '../../services/context.service.js';
import { interactiveUI } from '../../ui/interactive.js';
import {
    showTrialLimitPrompt,
    checkTrialStatus,
} from '../../utils/rate-limit.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliDebug, cliError, cliInfo } from '../../utils/logger.js';
import { createCommandContext } from '../../utils/command-context.js';
import {
    buildAgentErrorEnvelope,
    buildAgentSuccessEnvelope,
    emitAgentEnvelope,
} from '../../utils/command-output.js';
import { normalizeCommandError } from '../../utils/command-errors.js';
import {
    assertStructuredOutputForFields,
    parseFieldList,
} from '../../utils/input-validation.js';
import { applyFieldMask } from '../../utils/field-mask.js';
import { formatReviewOutput } from '../../utils/review-output.js';
import { resolveReviewDiff } from './diff.js';
import { buildReviewErrorHints } from './errors.js';
import { buildNoChangesMessages } from './no-changes.js';
import { validateReviewOptions } from './options.js';
import {
    formatFailOnExitMessage,
    formatTrialCompletionMessage,
    isHunkPlatformSupported,
    shouldFailReview,
    shouldUseHunkViewer,
    shouldUseInteractiveReview,
} from './result.js';
import { canRenderScopeInHunk, openReviewInHunk } from './hunk-viewer.js';
import {
    convertReviewToHunkContext,
    countHunkAnnotations,
} from './hunk-context.js';
import { ApiError } from '../../types/errors.js';
import type { GlobalOptions } from '../../types/cli.js';
import type { ReviewResult, TrialReviewResult } from '../../types/review.js';

type ReviewCommandOptions = {
    staged?: boolean;
    commit?: string;
    branch?: string;
    rulesOnly?: boolean;
    fast?: boolean;
    interactive?: boolean;
    fix?: boolean;
    promptOnly?: boolean;
    context?: string;
    failOn?: string;
    fields?: string;
    githubPat?: string;
    hunk?: boolean;
};

/**
 * Resolve the GitHub PAT for trial mode: explicit --github-pat flag takes
 * precedence, then KODUS_GITHUB_PAT, then GITHUB_TOKEN/GH_TOKEN as a
 * developer convenience. Returns undefined when none are set so the
 * sandbox falls back to anonymous clone (works for public repos).
 */
function resolveTrialGithubPat(
    options: ReviewCommandOptions,
): string | undefined {
    return (
        options.githubPat?.trim() ||
        process.env.KODUS_GITHUB_PAT?.trim() ||
        process.env.GITHUB_TOKEN?.trim() ||
        process.env.GH_TOKEN?.trim() ||
        undefined
    );
}

export function createReviewCommand(): Command {
    return new Command('review')
        .description(
            `Analyze modified files for code review

Examples:
  kodus review
  kodus review --staged
  kodus review --branch main
  kodus review src/auth.ts src/config.ts
  kodus review --fail-on error`,
        )
        .argument('[files...]', 'Specific files to analyze')
        .option('-s, --staged', 'Analyze only staged files')
        .option('-c, --commit <sha>', 'Analyze diff from a specific commit')
        .option(
            '-b, --branch <name>',
            'Compare current branch against specified branch (e.g., main)',
        )
        .option(
            '--rules-only',
            'Review using only configured rules (no general suggestions)',
        )
        .option('--fast', 'Fast mode: quicker analysis with lighter checks')
        .option(
            '-i, --interactive',
            'Interactive mode: navigate and apply fixes',
        )
        .option('--fix', 'Automatically apply all fixable issues')
        .option(
            '--prompt-only',
            'Output optimized for AI agents (minimal, structured)',
        )
        .option(
            '--fail-on <severity>',
            'Exit with code 1 if issues meet or exceed severity (info, warning, error, critical)',
        )
        .option('--context <file>', 'Custom context file to include in review')
        .option(
            '--fields <csv>',
            'Select response fields (JSON/agent mode only), e.g. summary,issues.file',
        )
        .option(
            '--github-pat <token>',
            'GitHub Personal Access Token (read:repo). Trial users only — needed to clone private repos. Can also be set via KODUS_GITHUB_PAT env var. Held in memory only, never persisted.',
        )
        .option(
            '--no-hunk',
            'Skip the hunk TUI viewer and use the legacy interactive list (interactive sessions only)',
        )
        .action(reviewAction);
}

async function reviewAction(
    files: string[],
    options: ReviewCommandOptions,
    cmd: Command,
): Promise<void> {
    const globalOpts = cmd.optsWithGlobals() as GlobalOptions & {
        staged?: boolean;
        commit?: string;
    };
    const ctx = createCommandContext('review', globalOpts);
    const spinner = ora();
    const fields = parseFieldList(options.fields);

    try {
        validateReviewOptions(options);

        assertStructuredOutputForFields({
            fields: options.fields,
            format: globalOpts.format,
            isAgent: ctx.isAgent,
        });

        if (options.promptOnly && !ctx.isAgent) {
            globalOpts.format = 'prompt';
        }

        if (!globalOpts.quiet && !ctx.isAgent) {
            spinner.start(chalk.cyan('Checking authentication...'));
        }

        const isAuthenticated = await authService.isAuthenticated();

        let result: ReviewResult | TrialReviewResult;

        if (isAuthenticated) {
            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Getting file changes...');
            }

            let diff = await getDiff(files, options, globalOpts.verbose);

            if (!diff) {
                await handleNoChanges(
                    ctx,
                    spinner,
                    files,
                    options,
                    globalOpts.verbose,
                    globalOpts.quiet,
                );
                return;
            }

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Reading project context...');
            }

            if (globalOpts.verbose) {
                cliDebug(
                    chalk.dim('[verbose] Reading project context files...'),
                );
            }

            diff = await contextService.enrichDiffWithContext(
                diff,
                options.context,
                globalOpts.verbose,
            );

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Analyzing code...');
            }

            if (globalOpts.verbose) {
                reviewService.setVerbose(true);
            }

            try {
                result = await reviewService.analyze(
                    diff,
                    options.rulesOnly,
                    options.fast,
                    {
                        files: files.length > 0 ? files : undefined,
                        staged: options.staged,
                        commit: options.commit,
                        branch: options.branch,
                        quiet: globalOpts.quiet,
                        onProgress: (status) => {
                            if (globalOpts.quiet || ctx.isAgent) {return;}
                            if (status === 'PENDING') {
                                spinner.text = chalk.cyan(
                                    'Queued for review...',
                                );
                            } else if (status === 'PROCESSING') {
                                spinner.text = chalk.cyan('Analyzing code...');
                            }
                        },
                    },
                );
                const modeLabel = options.fast ? ' (fast mode)' : '';
                if (!globalOpts.quiet && !ctx.isAgent) {
                    spinner.succeed(
                        chalk.green(`Review complete!${modeLabel}`),
                    );
                }
            } catch (error) {
                // If the configured credentials are invalid (revoked team key,
                // expired session) fall back to trial mode so a single broken
                // setup doesn't block a one-off review. We only fall back on
                // 401 — other errors (rate limit, server error, network)
                // bubble up unchanged.
                if (!(error instanceof ApiError) || error.statusCode !== 401) {
                    throw error;
                }

                if (!globalOpts.quiet && !ctx.isAgent) {
                    spinner.warn(
                        chalk.yellow(
                            'Authenticated review failed (invalid or revoked credentials). Falling back to trial mode...',
                        ),
                    );
                }

                const fallbackResult = await runTrialFallback({
                    diff,
                    spinner,
                    ctx,
                    globalOpts,
                    githubPat: resolveTrialGithubPat(options),
                });

                if (!fallbackResult) {
                    return;
                }

                result = fallbackResult;
            }
        } else {
            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Running in trial mode...');
            }

            const trialStatus = await checkTrialStatus();

            if (trialStatus.isLimited) {
                spinner.stop();
                showTrialLimitPrompt(trialStatus);
                return;
            }

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Getting file changes...');
            }

            let diff = await getDiff(files, options, globalOpts.verbose);

            if (!diff) {
                await handleNoChanges(
                    ctx,
                    spinner,
                    files,
                    options,
                    globalOpts.verbose,
                    globalOpts.quiet,
                );
                return;
            }

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Reading project context...');
            }

            if (globalOpts.verbose) {
                cliDebug(
                    chalk.dim('[verbose] Reading project context files...'),
                );
            }

            diff = await contextService.enrichDiffWithContext(
                diff,
                options.context,
                globalOpts.verbose,
            );

            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.text = chalk.cyan('Analyzing code (trial mode)...');
            }

            if (globalOpts.verbose) {
                reviewService.setVerbose(true);
            }

            const trialResult = await reviewService.trialAnalyze(diff, {
                githubPat: resolveTrialGithubPat(options),
            });
            result = trialResult;
            if (!globalOpts.quiet && !ctx.isAgent) {
                spinner.succeed(
                    chalk.green(formatTrialCompletionMessage(trialResult)),
                );
            }
        }

        if (options.fix) {
            await interactiveUI.runQuickFix(result);

            if (ctx.isAgent) {
                await emitAgentEnvelope(
                    buildAgentSuccessEnvelope(
                        ctx.command,
                        { fixedIssues: true },
                        ctx.startedAt,
                    ),
                    ctx.outputFile,
                );
            }
            return;
        }

        const selectedResult = fields ? applyFieldMask(result, fields) : result;
        const ttyOut = Boolean(process.stdout.isTTY);
        const platformSupported = isHunkPlatformSupported();
        const scopeSupported = canRenderScopeInHunk({
            files,
            commit: options.commit,
            branch: options.branch,
        });
        // The user is in an "interactive human" context where we'd otherwise
        // route to hunk; we use this to decide whether to surface a one-line
        // hint explaining why hunk was skipped.
        const interactiveHumanContext =
            !ctx.isAgent &&
            options.hunk !== false &&
            options.interactive !== true &&
            !globalOpts.output &&
            (!globalOpts.format || globalOpts.format === 'terminal') &&
            ttyOut;

        if (interactiveHumanContext && !platformSupported) {
            cliInfo(
                chalk.dim(
                    'ℹ Hunk viewer skipped: not yet supported on this platform (Windows). Showing the interactive list instead. Pass --no-hunk to silence this hint.',
                ),
            );
        } else if (interactiveHumanContext && !scopeSupported) {
            cliInfo(
                chalk.dim(
                    'ℹ Hunk viewer skipped: --branch / --commit / explicit files have no direct hunk scope yet. Showing the interactive list instead. Pass --no-hunk to silence this hint.',
                ),
            );
        }

        const useHunkViewer = shouldUseHunkViewer({
            isAgent: ctx.isAgent,
            interactive: options.interactive,
            noHunk: options.hunk === false,
            output: globalOpts.output,
            format: globalOpts.format,
            ttyOut,
            scopeSupported,
            platformSupported,
        });

        if (globalOpts.verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] hunk routing: useHunkViewer=${useHunkViewer} ttyOut=${ttyOut} platformSupported=${platformSupported} scopeSupported=${scopeSupported} format=${globalOpts.format} output=${globalOpts.output ?? '∅'} agent=${ctx.isAgent} interactive=${options.interactive ?? false} hunkOpt=${options.hunk}`,
                ),
            );
        }

        if (useHunkViewer) {
            const reviewResult = result as ReviewResult;
            const issues = reviewResult.issues ?? [];

            if (globalOpts.verbose) {
                cliDebug(
                    chalk.dim(
                        `[verbose] hunk: feeding ${issues.length} issue(s) to converter`,
                    ),
                );
                for (const [idx, issue] of issues.entries()) {
                    const preview = issue.message
                        ? issue.message.slice(0, 80).replace(/\s+/g, ' ')
                        : '∅';
                    cliDebug(
                        chalk.dim(
                            `[verbose]   #${idx + 1} file=${JSON.stringify(issue.file)} line=${issue.line} endLine=${issue.endLine ?? '∅'} severity=${issue.severity} msg=${JSON.stringify(preview)}`,
                        ),
                    );
                }
            }

            const hunkContext = convertReviewToHunkContext(reviewResult);
            const annotationCount = countHunkAnnotations(hunkContext);

            // PR-level findings have no file/line anchor and can't be inlined
            // into a hunk panel. If every finding is unanchored, hunk would
            // open empty. Bail out so the legacy interactive list (which does
            // surface those findings) takes over.
            const allUnanchored = annotationCount === 0 && issues.length > 0;

            if (allUnanchored) {
                cliInfo(
                    chalk.dim(
                        'ℹ Hunk viewer skipped: findings have no file/line anchor (likely PR-level). Showing the interactive list instead. Pass --no-hunk to silence this hint.',
                    ),
                );
                // Fall through to the legacy interactive UI / formatter below.
            } else {
                const { exitCode } = await openReviewInHunk({
                    result: reviewResult,
                    scope: { staged: Boolean(options.staged) },
                    keepContextOnExit: Boolean(globalOpts.verbose),
                });

                if (shouldFailReview(result, options.failOn)) {
                    const failMessage = formatFailOnExitMessage(
                        result,
                        options.failOn,
                    );
                    if (failMessage) {
                        cliInfo(chalk.yellow(failMessage));
                    }
                    exitWithCode(1);
                }

                if (exitCode !== 0) {
                    exitWithCode(exitCode);
                }
                return;
            }
        }

        const shouldUseInteractive = shouldUseInteractiveReview({
            isAgent: ctx.isAgent,
            interactive: options.interactive,
            output: globalOpts.output,
            format: globalOpts.format,
        });

        if (shouldUseInteractive) {
            await interactiveUI.run(result);
            return;
        }

        if (ctx.isAgent) {
            await emitAgentEnvelope(
                buildAgentSuccessEnvelope(
                    ctx.command,
                    selectedResult,
                    ctx.startedAt,
                ),
                ctx.outputFile,
            );
        } else {
            const output = formatReviewOutput(
                selectedResult as ReviewResult,
                globalOpts.format,
            );

            if (globalOpts.output) {
                await fs.writeFile(globalOpts.output, output, 'utf-8');
                cliInfo(chalk.green(`\nOutput saved to ${globalOpts.output}`));
            } else {
                cliInfo(output);
            }
        }

        if (shouldFailReview(result, options.failOn)) {
            const failMessage = formatFailOnExitMessage(result, options.failOn);
            if (failMessage && !ctx.isAgent) {
                cliInfo(chalk.yellow(failMessage));
            }
            exitWithCode(1);
        }
    } catch (error) {
        const normalized = normalizeCommandError(error);

        if (ctx.isAgent) {
            await emitAgentEnvelope(
                buildAgentErrorEnvelope(
                    ctx.command,
                    {
                        code: normalized.code,
                        message: normalized.message,
                        details: normalized.details,
                    },
                    ctx.startedAt,
                ),
                ctx.outputFile,
            );

            if (normalized.exitCode > 0) {
                exitWithCode(normalized.exitCode);
            }
            return;
        }

        if (!globalOpts.quiet && spinner.isSpinning) {
            spinner.fail(chalk.red('Review failed'));
        }

        if (error instanceof Error) {
            cliError(chalk.red(error.message));
            for (const hint of buildReviewErrorHints(normalized)) {
                cliInfo(chalk.dim(hint));
            }
            if (globalOpts.verbose) {
                cliError(error.stack);
            }
        } else {
            cliError(chalk.red('An unexpected error occurred'));
            if (globalOpts.verbose) {
                cliError(error);
            }
        }
        exitWithCode(normalized.exitCode);
    }
}

async function runTrialFallback({
    diff,
    spinner,
    ctx,
    globalOpts,
    githubPat,
}: {
    diff: string;
    spinner: Ora;
    ctx: ReturnType<typeof createCommandContext>;
    globalOpts: GlobalOptions;
    githubPat?: string;
}): Promise<TrialReviewResult | null> {
    if (!globalOpts.quiet && !ctx.isAgent) {
        spinner.start(chalk.cyan('Checking trial limit...'));
    }

    const trialStatus = await checkTrialStatus();
    if (trialStatus.isLimited) {
        spinner.stop();
        showTrialLimitPrompt(trialStatus);
        return null;
    }

    if (!globalOpts.quiet && !ctx.isAgent) {
        spinner.text = chalk.cyan('Analyzing code (trial mode)...');
    }

    if (globalOpts.verbose) {
        reviewService.setVerbose(true);
    }

    const trialResult = await reviewService.trialAnalyze(diff, { githubPat });

    if (!globalOpts.quiet && !ctx.isAgent) {
        spinner.succeed(chalk.green(formatTrialCompletionMessage(trialResult)));
    }

    return trialResult;
}

async function handleNoChanges(
    ctx: ReturnType<typeof createCommandContext>,
    spinner: Ora,
    files: string[],
    options: Pick<ReviewCommandOptions, 'branch' | 'commit' | 'staged'>,
    verbose = false,
    quiet = false,
): Promise<void> {
    if (ctx.isAgent) {
        await emitAgentEnvelope(
            buildAgentErrorEnvelope(
                ctx.command,
                {
                    code: 'NO_CHANGES',
                    message: 'No changes to review',
                },
                ctx.startedAt,
            ),
            ctx.outputFile,
        );
        return;
    }

    if (!quiet) {
        spinner.fail(chalk.yellow('No changes to review'));
        for (const message of buildNoChangesMessages(files, options)) {
            cliInfo(chalk.dim(message));
        }
    }

    if (verbose) {
        cliDebug(chalk.dim('[verbose] Checked scopes:'));
        cliDebug(
            chalk.dim(
                `  - Specific files: ${files.length > 0 ? files.join(', ') : 'none'}`,
            ),
        );
        cliDebug(
            chalk.dim(`  - Branch comparison: ${options.branch || 'none'}`),
        );
        cliDebug(chalk.dim(`  - Commit: ${options.commit || 'none'}`));
        cliDebug(
            chalk.dim(`  - Staged only: ${options.staged ? 'yes' : 'no'}`),
        );
        cliDebug(
            chalk.dim(
                `  - Default: ${!files.length && !options.branch && !options.commit && !options.staged ? 'working tree (staged + unstaged)' : 'no'}`,
            ),
        );
    }
}

async function getDiff(
    files: string[],
    options: Pick<ReviewCommandOptions, 'staged' | 'commit' | 'branch'>,
    verbose?: boolean,
): Promise<string> {
    const result = await resolveReviewDiff({
        files,
        options,
        verbose,
        git: gitService,
    });

    result.verboseMessages.forEach((message) => {
        cliDebug(chalk.dim(message));
    });

    return result.diff;
}

export const reviewCommand = createReviewCommand();
