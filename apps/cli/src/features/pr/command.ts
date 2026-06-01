import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import fs from 'fs/promises';
import { reviewService } from '../../services/review.service.js';
import { gitService } from '../../services/git.service.js';
import type { GlobalOptions } from '../../types/cli.js';
import type {
    IssueCategory,
    ReviewResult,
    Severity,
} from '../../types/review.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliDebug, cliError, cliInfo } from '../../utils/logger.js';
import { createCommandContext } from '../../utils/command-context.js';
import {
    buildAgentErrorEnvelope,
    buildAgentSuccessEnvelope,
    emitAgentEnvelope,
} from '../../utils/command-output.js';
import {
    CommandError,
    normalizeCommandError,
} from '../../utils/command-errors.js';
import {
    assertStructuredOutputForFields,
    parseCsvEnumList,
    parseFieldList,
    parseOptionalNumber,
    validateHttpUrl,
} from '../../utils/input-validation.js';
import { applyFieldMask } from '../../utils/field-mask.js';
import { formatReviewOutput } from '../../utils/review-output.js';

type PrSuggestionsOptions = {
    prUrl?: string;
    prNumber?: string;
    repoId?: string;
    severity?: string;
    category?: string;
    fields?: string;
};

type BusinessValidationOptions = {
    taskUrl?: string;
    taskId?: string;
    staged?: boolean;
    commit?: string;
    branch?: string;
    dryRun?: boolean;
};

export function createPrCommand(): Command {
    const prCommand = new Command('pr').description('Pull request commands');

    prCommand
        .command('suggestions')
        .description('Fetch suggestions for a pull request')
        .option('--pr-url <url>', 'Pull request URL')
        .option('--pr-number <number>', 'Pull request number')
        .option('--repo-id <id>', 'Repository ID for the pull request')
        .option('--severity <list>', 'Comma-separated severities to include')
        .option('--category <list>', 'Comma-separated categories to include')
        .option(
            '--fields <csv>',
            'Select response fields (JSON/agent mode only), e.g. summary,issues.file',
        )
        .action(prSuggestionsAction);

    prCommand
        .command('business-validation')
        .description('Run business rules validation for local diff only')
        .argument('[files...]', 'Specific files to include in local diff mode')
        .option(
            '--task-url <url>',
            'Task URL to append to the validation command',
        )
        .option(
            '--task-id <id>',
            'Task ID or issue key (e.g. KC-1441) to append',
        )
        .option(
            '-s, --staged',
            'Use only staged changes when running in local diff mode',
        )
        .option(
            '-c, --commit <sha>',
            'Use diff from a specific commit when running in local diff mode',
        )
        .option(
            '-b, --branch <name>',
            'Compare current branch against a base branch in local diff mode',
        )
        .option(
            '--dry-run',
            'Print payload without executing the API call',
            false,
        )
        .action(businessValidationAction);

    return prCommand;
}

async function prSuggestionsAction(
    options: PrSuggestionsOptions,
    cmd: Command,
): Promise<void> {
    const globalOpts = cmd.optsWithGlobals() as GlobalOptions;
    const ctx = createCommandContext('pr suggestions', globalOpts);
    const spinner = ora();

    try {
        assertStructuredOutputForFields({
            fields: options.fields,
            format: globalOpts.format,
            isAgent: ctx.isAgent,
        });

        const prNumber = parseOptionalNumber(options.prNumber, '--pr-number');
        const normalizedPrUrl = options.prUrl
            ? validateHttpUrl(options.prUrl, '--pr-url')
            : undefined;

        const allowedSeverities: readonly (Severity | 'high' | 'medium' | 'low')[] =
            ['info', 'warning', 'error', 'critical', 'high', 'medium', 'low'];
        const allowedCategories: readonly (IssueCategory | 'documentation')[] =
            [
                'security_vulnerability',
                'performance',
                'code_quality',
                'best_practices',
                'style',
                'bug',
                'complexity',
                'maintainability',
                'documentation',
            ];

        const severityFilter = parseCsvEnumList(
            options.severity,
            '--severity',
            allowedSeverities,
        );
        const categoryFilter = parseCsvEnumList(
            options.category,
            '--category',
            allowedCategories,
        );
        const fields = parseFieldList(options.fields);

        if (!normalizedPrUrl && !(prNumber && options.repoId)) {
            throw new CommandError(
                'INVALID_INPUT',
                'Provide --pr-url or both --pr-number and --repo-id.',
            );
        }

        const shouldRequestMarkdown =
            !ctx.isAgent &&
            (globalOpts.format === 'prompt' ||
                globalOpts.format === 'markdown');

        if (!globalOpts.quiet && !ctx.isAgent) {
            spinner.start(chalk.cyan('Fetching pull request suggestions...'));
        }

        const { result, markdown } =
            await reviewService.getPullRequestSuggestions({
                prUrl: normalizedPrUrl,
                prNumber,
                repositoryId: options.repoId,
                format: shouldRequestMarkdown ? 'markdown' : undefined,
                severity: severityFilter?.join(','),
                category: categoryFilter?.join(','),
            });

        if (!globalOpts.quiet && !ctx.isAgent) {
            spinner.succeed(chalk.green('Suggestions fetched'));
        }

        const selectedResult = fields ? applyFieldMask(result, fields) : result;

        if (ctx.isAgent) {
            await emitAgentEnvelope(
                buildAgentSuccessEnvelope(
                    ctx.command,
                    selectedResult,
                    ctx.startedAt,
                ),
                ctx.outputFile,
            );
            return;
        }

        const output =
            markdown && shouldRequestMarkdown
                ? markdown
                : formatReviewOutput(
                      selectedResult as ReviewResult,
                      globalOpts.format,
                  );

        if (globalOpts.output) {
            await fs.writeFile(globalOpts.output, output, 'utf-8');
            cliInfo(chalk.green(`\nOutput saved to ${globalOpts.output}`));
        } else {
            cliInfo(output);
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

        if (!globalOpts.quiet) {
            spinner.fail(chalk.red('Failed to fetch pull request suggestions'));
        }

        if (error instanceof Error) {
            cliError(chalk.red(error.message));
        }

        exitWithCode(normalized.exitCode);
    }
}

async function businessValidationAction(
    files: string[],
    options: BusinessValidationOptions,
    cmd: Command,
): Promise<void> {
    const spinner = ora();
    const globalOpts = cmd.optsWithGlobals() as GlobalOptions;

    try {
        if (options.taskUrl && options.taskId) {
            throw new Error('Provide only one of --task-url or --task-id.');
        }

        const diff = await getLocalDiffForBusinessValidation(
            files ?? [],
            options,
            globalOpts.verbose,
        );

        if (!diff.trim()) {
            throw new Error('No local changes found for the selected scope.');
        }

        let repository: string | undefined;
        const orgRepo = await gitService.extractOrgRepo();
        if (orgRepo) {
            repository = `${orgRepo.org}/${orgRepo.repo}`;
        }

        const payload = {
            repository,
            taskUrl: options.taskUrl,
            taskId: options.taskId,
            diff,
        };

        if (options.dryRun) {
            cliInfo(
                chalk.cyan(
                    'Dry run mode. Payload that would be sent to /cli/business-validation:',
                ),
            );
            cliInfo(JSON.stringify(payload, null, 2));
            return;
        }

        if (!globalOpts.quiet) {
            spinner.start(chalk.cyan('Running business validation...'));
        }

        const response = await reviewService.triggerBusinessValidation(payload);

        if (!globalOpts.quiet) {
            spinner.succeed(chalk.green('Business validation completed.'));
        }
        cliInfo(chalk.dim('Mode: local diff'));

        if (response.repositoryName) {
            cliInfo(chalk.dim(`Repository: ${response.repositoryName}`));
        }
        if (response.taskReference) {
            cliInfo(chalk.dim(`Task: ${response.taskReference}`));
        }
        cliInfo(chalk.dim(`Command: ${response.command}`));
        cliInfo('');
        cliInfo(response.result);
    } catch (error) {
        if (!globalOpts.quiet) {
            spinner.fail(chalk.red('Failed to trigger business validation'));
        }

        if (error instanceof Error) {
            cliError(chalk.red(error.message));
        }

        exitWithCode(1);
    }
}

async function getLocalDiffForBusinessValidation(
    files: string[],
    options: Pick<BusinessValidationOptions, 'staged' | 'commit' | 'branch'>,
    verbose?: boolean,
): Promise<string> {
    gitService.setVerbose(!!verbose);

    const hasFiles = files.length > 0;
    const hasBranch = !!options.branch;
    const hasCommit = !!options.commit;
    const hasStaged = !!options.staged;
    const selectedScopes = [hasFiles, hasBranch, hasCommit, hasStaged].filter(
        Boolean,
    ).length;

    if (selectedScopes > 1) {
        throw new Error(
            'Use only one local diff scope: [files], --staged, --branch, or --commit.',
        );
    }

    if (hasFiles) {
        if (verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Getting local diff for specific files: ${files.join(', ')}`,
                ),
            );
        }
        return gitService.getDiffForFiles(files);
    }

    if (options.branch !== undefined) {
        if (verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Getting local diff for branch: ${options.branch}`,
                ),
            );
        }
        return gitService.getDiffForBranch(options.branch);
    }

    if (options.commit !== undefined) {
        if (verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Getting local diff for commit: ${options.commit}`,
                ),
            );
        }
        return gitService.getDiffForCommit(options.commit);
    }

    if (hasStaged) {
        if (verbose) {
            cliDebug(chalk.dim('[verbose] Getting local staged diff'));
        }
        return gitService.getStagedDiff();
    }

    if (verbose) {
        cliDebug(chalk.dim('[verbose] Getting local working tree diff'));
    }
    return gitService.getWorkingTreeDiff();
}

export const prCommand = createPrCommand();
