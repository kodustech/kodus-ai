import chalk from 'chalk';
import type {
    ReviewIssue,
    ReviewResult,
    Severity,
} from '../types/review.js';

function getSeverityColor(severity: Severity): (text: string) => string {
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

function getSeverityIcon(severity: Severity): string {
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

function formatIssue(issue: ReviewIssue, index: number): string {
    const color = getSeverityColor(issue.severity);
    const icon = getSeverityIcon(issue.severity);

    const lines: string[] = [];

    // Main issue line
    const fixableBadge = issue.fixable ? chalk.green(' [fixable]') : '';
    lines.push(
        `${chalk.dim(`${index + 1}.`)} ${icon} ${chalk.bold(color(issue.severity.toUpperCase()))} ${chalk.dim('in')} ${chalk.cyan(issue.file)}${chalk.dim(`:${issue.line}`)}${fixableBadge}`,
    );

    // Category badge
    if (issue.category) {
        lines.push(chalk.dim(`   `) + chalk.magenta(`[${issue.category}]`));
    }

    // Message
    lines.push(`   ${issue.message}`);

    // Suggestion or Recommendation
    if (issue.suggestion) {
        lines.push(
            chalk.dim(`   💡 Suggestion: `) + chalk.green(issue.suggestion),
        );
    } else if (issue.recommendation) {
        lines.push(
            chalk.dim(`   💡 Recommendation: `) +
                chalk.cyan(issue.recommendation),
        );
    }

    // Fix preview
    if (issue.fixable && issue.fix) {
        lines.push(chalk.dim(`   ✓ Auto-fix available`));
        if (issue.fix.newCode && issue.fix.newCode.length < 100) {
            lines.push(
                chalk.dim(`   Fix: `) +
                    chalk.green(issue.fix.newCode.split('\n')[0]),
            );
        }
    }

    // Rule ID
    if (issue.ruleId) {
        lines.push(chalk.dim(`   Rule: ${issue.ruleId}`));
    }

    return lines.join('\n');
}

function formatSummary(result: ReviewResult): string {
    const criticalCount = result.issues.filter(
        (i) => i.severity === 'critical',
    ).length;
    const errorCount = result.issues.filter(
        (i) => i.severity === 'error',
    ).length;
    const warningCount = result.issues.filter(
        (i) => i.severity === 'warning',
    ).length;
    const infoCount = result.issues.filter((i) => i.severity === 'info').length;
    const fixableCount = result.issues.filter((i) => i.fixable).length;

    const parts: string[] = [];

    if (criticalCount > 0) {
        parts.push(chalk.red.bold(`${criticalCount} critical`));
    }
    if (errorCount > 0) {
        parts.push(
            chalk.red(`${errorCount} error${errorCount > 1 ? 's' : ''}`),
        );
    }
    if (warningCount > 0) {
        parts.push(
            chalk.yellow(
                `${warningCount} warning${warningCount > 1 ? 's' : ''}`,
            ),
        );
    }
    if (infoCount > 0) {
        parts.push(chalk.cyan(`${infoCount} info`));
    }

    if (parts.length === 0) {
        return chalk.green('✓ No issues found!');
    }

    const summary = parts.join(chalk.dim(' | '));

    if (fixableCount > 0) {
        return `${summary} ${chalk.dim('|')} ${chalk.green(`${fixableCount} fixable`)}`;
    }

    return summary;
}

class TerminalFormatter {
    format(result: ReviewResult): string {
        const lines: string[] = [];

        lines.push('');
        lines.push(
            chalk.bold.cyan(
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            ),
        );
        lines.push(chalk.bold.cyan('  Kodus Code Review Results'));
        lines.push(
            chalk.bold.cyan(
                '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
            ),
        );
        lines.push('');

        lines.push(`${chalk.dim('Summary:')} ${result.summary}`);
        lines.push(`${chalk.dim('Files analyzed:')} ${result.filesAnalyzed}`);
        lines.push(`${chalk.dim('Duration:')} ${result.duration}ms`);
        lines.push('');

        lines.push(formatSummary(result));
        lines.push('');

        if (result.issues.length > 0) {
            lines.push(chalk.bold('Issues'));
            lines.push(chalk.dim('─'.repeat(60)));
            lines.push('');

            result.issues.forEach((issue, index) => {
                lines.push(formatIssue(issue, index));
                lines.push('');
            });

            // Footer tip
            const fixableCount = result.issues.filter((i) => i.fixable).length;
            if (fixableCount > 0) {
                lines.push(chalk.dim('─'.repeat(60)));
                lines.push('');
                lines.push(
                    chalk.dim('💡 Tip: ') +
                        chalk.cyan(
                            'Run with --interactive to apply fixes interactively',
                        ),
                );
                lines.push(
                    chalk.dim('    or --fix to apply all fixes automatically'),
                );
                lines.push('');
            }
        }

        return lines.join('\n');
    }
}

export const terminalFormatter = new TerminalFormatter();
