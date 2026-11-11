import chalk from 'chalk';
import { Command } from 'commander';
import {
    FIX_PROMPT_MAX_ISSUES,
    issuesService,
} from '../services/issues.service.js';
import type { IssueListItem, IssueStatus } from '../types/issues.js';
import { exitWithCode } from '../utils/cli-exit.js';
import {
    CommandError,
    normalizeCommandError,
} from '../utils/command-errors.js';
import { cliError, cliInfo, cliWarn } from '../utils/logger.js';

export type IssuesListOptions = {
    status?: IssueStatus | 'all';
    security?: boolean;
    repo?: string;
    json?: boolean;
    promptOnly?: boolean;
};

export type IssuesShowOptions = {
    json?: boolean;
    promptOnly?: boolean;
};

const SEVERITY_COLOR: Record<string, (s: string) => string> = {
    critical: chalk.red,
    high: chalk.yellow,
    medium: chalk.blue,
    low: chalk.gray,
};

function printIssue(issue: IssueListItem): void {
    const severity = (SEVERITY_COLOR[issue.severity] ?? chalk.white)(
        issue.severity.toUpperCase().padEnd(8),
    );
    cliInfo(`${severity} ${issue.title}`);
    cliInfo(
        chalk.dim(
            `         ${issue.repository?.name ?? ''} · ${issue.filePath}${issue.cwe ? ` · ${issue.cwe}` : ''} · ${issue.uuid}`,
        ),
    );
}

/** The fix prompt on stdout, so an agent can pipe or read it whole. */
async function printFixPrompt(
    ids: string[],
    options: { json?: boolean; promptOnly?: boolean },
): Promise<void> {
    const result = await issuesService.fixPrompt(ids);
    if (options.json) {
        cliInfo(JSON.stringify(result, null, 2));
        return;
    }
    if (!result.prompt) {
        throw new CommandError(
            'INVALID_INPUT',
            'None of these issues can be read with your account (unknown id, or a repository you have no access to).',
        );
    }
    process.stdout.write(`${result.prompt}\n`);
    if (!options.promptOnly) {
        if (result.skipped.length) {
            cliWarn(
                `Left out (unknown or not readable): ${result.skipped.join(', ')}`,
            );
        }
        cliInfo(
            chalk.dim(
                '\nHand this to your coding agent, or run it with --prompt-only to pipe it.',
            ),
        );
    }
}

export async function issuesListAction(
    options: IssuesListOptions,
): Promise<void> {
    try {
        const issues = await issuesService.list({
            status: options.status,
            security: options.security,
            repo: options.repo,
        });

        if (options.promptOnly) {
            if (issues.length === 0) {
                cliInfo('No issues match.');
                return;
            }
            if (issues.length > FIX_PROMPT_MAX_ISSUES) {
                cliWarn(
                    `${issues.length} issues match; the prompt carries the ${FIX_PROMPT_MAX_ISSUES} most severe. Narrow with --repo or --security, or fix these and run it again.`,
                );
            }
            await printFixPrompt(
                issues.slice(0, FIX_PROMPT_MAX_ISSUES).map((i) => i.uuid),
                { promptOnly: true },
            );
            return;
        }

        if (options.json) {
            cliInfo(JSON.stringify(issues, null, 2));
            return;
        }

        if (issues.length === 0) {
            cliInfo(chalk.green('No issues match.'));
            return;
        }
        issues.forEach(printIssue);
        cliInfo(
            chalk.dim(
                `\n${issues.length} issue${issues.length === 1 ? '' : 's'}. kodus issues show <id> prints a fix prompt for your coding agent.`,
            ),
        );
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function issuesShowAction(
    ids: string[],
    options: IssuesShowOptions,
): Promise<void> {
    try {
        await printFixPrompt(ids, options);
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export const issuesCommand = new Command('issues')
    .description(
        'List Kody issues and deep-scan findings, and hand them to your coding agent to fix (requires kodus auth login)',
    )
    .showHelpAfterError();

issuesCommand
    .command('list')
    .description('List the issues you can read, most severe first')
    .option('--status <status>', 'open, resolved, dismissed or all', 'open')
    .option('--security', 'Only deep-scan security findings')
    .option('--repo <repo>', 'Only this repository (name or id)')
    .option('--json', 'Output the issues as JSON')
    .option(
        '--prompt-only',
        `Print one fix prompt for the listed issues (the ${FIX_PROMPT_MAX_ISSUES} most severe) for your coding agent`,
    )
    .action(issuesListAction);

issuesCommand
    .command('show')
    .description(
        'Print a fix prompt for one or more issues: location, explanation, suggested fix, attack path and reproduction test',
    )
    .argument('<ids...>', 'Issue ids (from kodus issues list)')
    .option('--json', 'Output the prompt and which issues it carries as JSON')
    .option('--prompt-only', 'Print only the prompt, for piping to an agent')
    .action(issuesShowAction);
