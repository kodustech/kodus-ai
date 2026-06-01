import chalk from 'chalk';
import type { ReviewIssue } from '../types/review.js';
import {
    formatCategoryBadge,
    getFileStats,
} from './interactive-helpers.js';

export function getSeverityColor(
    severity: string,
): (text: string) => string {
    switch (severity) {
        case 'critical':
            return chalk.red.bold;
        case 'error':
            return chalk.red;
        case 'warning':
            return chalk.yellow;
        case 'info':
            return chalk.cyan;
        default:
            return chalk.white;
    }
}

export function getSeverityIcon(severity: string): string {
    switch (severity) {
        case 'critical':
            return '🔴';
        case 'error':
            return '❌';
        case 'warning':
            return '⚠️ ';
        case 'info':
            return 'ℹ️ ';
        default:
            return '•';
    }
}

export function formatIssueTitle(issue: ReviewIssue): string {
    const icon = getSeverityIcon(issue.severity);
    const color = getSeverityColor(issue.severity);
    const location = chalk.cyan(`${issue.file}:${issue.line}`);
    const fixable = issue.fixable ? chalk.green(' [fixable]') : '';

    return `${icon} ${color(issue.severity.toUpperCase())} - ${location}${fixable} - ${issue.message}`;
}

export function formatFileChoice(
    file: string,
    issues: ReviewIssue[],
): string {
    const stats = getFileStats(issues);
    const badges: string[] = [];

    if (stats.critical > 0) {
        badges.push(chalk.red.bold(`${stats.critical} critical`));
    }
    if (stats.error > 0) {
        badges.push(chalk.red(`${stats.error} error`));
    }
    if (stats.warning > 0) {
        badges.push(chalk.yellow(`${stats.warning} warning`));
    }
    if (stats.info > 0) {
        badges.push(chalk.cyan(`${stats.info} info`));
    }

    const categories = [...new Set(issues.map((i) => i.category).filter(Boolean))];
    const categoryBadge =
        categories.length > 0
            ? chalk.magenta(
                  ` [${categories.map((c) => formatCategoryBadge(c!)).join(', ')}]`,
              )
            : '';

    const fixable = issues.filter((i) => i.fixable).length;
    const fixableBadge =
        fixable > 0 ? chalk.green(` [${fixable} fixable]`) : '';

    return `${chalk.cyan(file)} ${chalk.dim('─')} ${badges.join(', ')}${categoryBadge}${fixableBadge}`;
}
