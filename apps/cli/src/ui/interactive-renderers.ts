import chalk from 'chalk';
import type { ReviewIssue, ReviewResult } from '../types/review.js';
import { getSeverityColor } from './interactive-formatters.js';

export function renderIssueDetailsLines(issue: ReviewIssue): string[] {
    const lines = [
        '',
        chalk.bold(
            '┌─ Issue Details ─────────────────────────────────────────',
        ),
        chalk.dim('│'),
        chalk.dim('│ ') + chalk.bold('File: ') + chalk.cyan(issue.file),
        chalk.dim('│ ') +
            chalk.bold('Line: ') +
            chalk.yellow(issue.line.toString()),
        chalk.dim('│ ') +
            chalk.bold('Severity: ') +
            getSeverityColor(issue.severity)(issue.severity),
    ];

    if (issue.category) {
        lines.push(
            chalk.dim('│ ') +
                chalk.bold('Category: ') +
                chalk.magenta(issue.category),
        );
    }

    if (issue.ruleId) {
        lines.push(
            chalk.dim('│ ') + chalk.bold('Rule: ') + chalk.dim(issue.ruleId),
        );
    }

    lines.push(
        chalk.dim('│'),
        chalk.dim('│ ') + chalk.bold('Message:'),
        chalk.dim('│   ') + issue.message,
    );

    if (issue.suggestion) {
        lines.push(
            chalk.dim('│'),
            chalk.dim('│ ') + chalk.bold('Suggestion:'),
            chalk.dim('│   ') + chalk.green(issue.suggestion),
        );
    }

    if (issue.recommendation) {
        lines.push(
            chalk.dim('│'),
            chalk.dim('│ ') + chalk.bold('Recommendation:'),
            chalk.dim('│   ') + chalk.cyan(issue.recommendation),
        );
    }

    if (issue.fixable && issue.fix) {
        lines.push(
            chalk.dim('│'),
            chalk.dim('│ ') + chalk.bold.green('✓ Auto-fix available'),
        );
    }

    lines.push(
        chalk.bold(
            '└─────────────────────────────────────────────────────────',
        ),
        '',
    );

    return lines;
}

export function renderFixPreviewLines(issue: ReviewIssue): string[] {
    if (!issue.fixable || !issue.fix) {
        return [chalk.yellow('No fix available for this issue')];
    }

    const lines = [
        '',
        chalk.bold(
            '┌─ Fix Preview ───────────────────────────────────────────',
        ),
        chalk.dim('│'),
    ];

    if (issue.fix.oldCode) {
        lines.push(chalk.dim('│ ') + chalk.red('- Old code:'));
        issue.fix.oldCode.split('\n').forEach((line) => {
            lines.push(chalk.dim('│   ') + chalk.red(line));
        });
        lines.push(chalk.dim('│'));
    }

    lines.push(chalk.dim('│ ') + chalk.green('+ New code:'));
    issue.fix.newCode.split('\n').forEach((line) => {
        lines.push(chalk.dim('│   ') + chalk.green(line));
    });

    lines.push(
        chalk.bold(
            '└─────────────────────────────────────────────────────────',
        ),
        '',
    );

    return lines;
}

export function renderFileHeaderLines(
    file: string,
    issueCount: number,
): string[] {
    return [
        '\n',
        chalk.bold.cyan(
            `┌─ ${file} ────────────────────────────────────────────────`,
        ),
        chalk.dim(`│ ${issueCount} issue${issueCount > 1 ? 's' : ''} in this file`),
        chalk.bold.cyan(
            '└────────────────────────────────────────────────────────────',
        ),
    ];
}

export function renderReviewSummaryLines(
    result: ReviewResult,
    fixedCount: number,
): string[] {
    return [
        '',
        chalk.bold.cyan(
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ),
        chalk.bold('Review Summary'),
        chalk.bold.cyan(
            '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
        ),
        '',
        chalk.dim('Total issues: ') + chalk.white(result.issues.length.toString()),
        chalk.dim('Fixed: ') + chalk.green(fixedCount.toString()),
        chalk.dim('Remaining: ') +
            chalk.yellow((result.issues.length - fixedCount).toString()),
        '',
    ];
}
