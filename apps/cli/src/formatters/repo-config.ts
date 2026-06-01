import chalk from 'chalk';
import type {
    RepositorySettingSource,
    RepositorySettings,
} from '../types/repo-config.js';
import type { RepositorySettingsResult } from '../services/repo-settings.service.js';

function formatPatternList(patterns: string[]): string {
    return patterns.length > 0 ? patterns.join(', ') : chalk.dim('(none)');
}

function formatEnabledLabel(enabled: boolean): string {
    return enabled ? chalk.greenBright.bold('enabled') : chalk.redBright.bold('disabled');
}

function formatLabel(label: string): string {
    return chalk.whiteBright(label);
}

function formatSection(title: string): string {
    return chalk.blueBright.bold(title);
}

function formatSeverity(
    severity: RepositorySettings['requestChangesMinSeverity'],
): string {
    switch (severity) {
        case 'critical':
            return chalk.redBright.bold(severity);
        case 'high':
            return chalk.hex('#ff8a00').bold(severity);
        case 'medium':
            return chalk.yellowBright.bold(severity);
        case 'low':
        default:
            return chalk.cyanBright.bold(severity);
    }
}

function formatValueDiff(current: string, next: string): string {
    if (current === next) {
        return next;
    }

    return `${current} ${chalk.dim('->')} ${chalk.cyan(next)}`;
}

function formatPreviewRow(
    label: string,
    current: string,
    next: string,
): string {
    const changed = current !== next;
    const prefix = changed ? chalk.greenBright('+') : chalk.dim('·');
    const formattedLabel = changed ? formatLabel(label) : chalk.dim(label);
    const formattedValue = changed
        ? formatValueDiff(current, next)
        : chalk.dim(next);

    return `${prefix} ${formattedLabel} ${formattedValue}`;
}

function formatSourceLabel(source?: RepositorySettingSource): string {
    if (!source) {
        return '';
    }

    const level = source.level.replace(/_/g, ' ');
    if (source.overriddenLevel) {
        const overridden = source.overriddenLevel.replace(/_/g, ' ');
        return ` ${chalk.dim(`[${level} overrides ${overridden}]`)}`;
    }

    return ` ${chalk.dim(`[${level}]`)}`;
}

export function formatRepositorySettings(
    result: RepositorySettingsResult,
): string[] {
    return [
        chalk.bold(`Repository settings: ${result.repositoryFullName}`),
        '',
        formatSection('Status'),
        `${formatLabel('Automated review:')} ${formatEnabledLabel(result.settings.reviewEnabled)}${formatSourceLabel(result.settings.sources?.reviewEnabled)}`,
        `${formatLabel('Auto approve:')} ${formatEnabledLabel(result.settings.autoApproveEnabled)}${formatSourceLabel(result.settings.sources?.autoApproveEnabled)}`,
        `${formatLabel('Minimum severity level:')} ${formatSeverity(result.settings.requestChangesMinSeverity)}${formatSourceLabel(result.settings.sources?.requestChangesMinSeverity)}`,
        '',
        formatSection('Patterns'),
        `${formatLabel('Ignored file patterns:')} ${formatPatternList(result.settings.ignoredFilePatterns)}${formatSourceLabel(result.settings.sources?.ignoredFilePatterns)}`,
        `${formatLabel('Base branch patterns:')} ${formatPatternList(result.settings.baseBranchPatterns)}${formatSourceLabel(result.settings.sources?.baseBranchPatterns)}`,
        `${formatLabel('Ignored title patterns:')} ${formatPatternList(result.settings.ignoredTitlePatterns)}${formatSourceLabel(result.settings.sources?.ignoredTitlePatterns)}`,
    ];
}

export function formatRepositorySetupPreview(
    repositoryFullName: string,
    current: RepositorySettings,
    next: RepositorySettings,
): string[] {
    return [
        chalk.bold(`Review repository settings: ${repositoryFullName}`),
        chalk.dim('Changed values are highlighted before you apply.'),
        '',
        formatSection('Status'),
        formatPreviewRow(
            'Automated review:',
            formatEnabledLabel(current.reviewEnabled),
            formatEnabledLabel(next.reviewEnabled),
        ),
        formatPreviewRow(
            'Auto approve:',
            formatEnabledLabel(current.autoApproveEnabled),
            formatEnabledLabel(next.autoApproveEnabled),
        ),
        formatPreviewRow(
            'Minimum severity level:',
            formatSeverity(current.requestChangesMinSeverity),
            formatSeverity(next.requestChangesMinSeverity),
        ),
        '',
        formatSection('Patterns'),
        formatPreviewRow(
            'Ignored file patterns:',
            formatPatternList(current.ignoredFilePatterns),
            formatPatternList(next.ignoredFilePatterns),
        ),
        formatPreviewRow(
            'Base branch patterns:',
            formatPatternList(current.baseBranchPatterns),
            formatPatternList(next.baseBranchPatterns),
        ),
        formatPreviewRow(
            'Ignored title patterns:',
            formatPatternList(current.ignoredTitlePatterns),
            formatPatternList(next.ignoredTitlePatterns),
        ),
    ];
}

export function formatRepositorySettingsOpenInfo(
    repositoryFullName: string,
    appUrl: string,
    sectionLabel: string,
): string[] {
    return [
        chalk.blue('Opening Kodus dashboard...'),
        chalk.dim(`URL: ${appUrl}`),
        `${chalk.dim('Navigate to:')} ${repositoryFullName} > ${sectionLabel}`,
        chalk.dim('Advanced repository settings stay in the web app.'),
    ];
}

export function formatRepositorySetupSection(
    title: string,
    description?: string,
): string[] {
    const lines = ['', chalk.bold(title)];
    if (description) {
        lines.push(chalk.dim(description));
    }
    return lines;
}
