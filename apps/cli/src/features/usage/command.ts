import chalk from 'chalk';
import { Command } from 'commander';
import {
    USAGE_DIMENSIONS,
    usageService,
    type UsageTokensOptions,
    type UsageTokensResult,
} from '../../services/usage.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { normalizeCommandError } from '../../utils/command-errors.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export type UsageTokensCommandOptions = UsageTokensOptions & { json?: boolean };

function formatTokens(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '-';
    }
    return value.toLocaleString('en-US');
}

function formatCost(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '-';
    }
    return `$${value.toFixed(2)}`;
}

function formatDelta(current: number, previous: number): string {
    if (!previous) {
        return '';
    }
    const change = ((current - previous) / previous) * 100;
    const sign = change > 0 ? '+' : '';
    return chalk.dim(` (${sign}${change.toFixed(1)}% vs previous period)`);
}

function rowLabel(
    row: Record<string, unknown>,
    by: UsageTokensResult['by'],
): string {
    if (by === 'pr') {
        return `PR #${row.prNumber ?? '?'}`;
    }
    if (by === 'developer') {
        return String(row.developer ?? 'unknown');
    }
    if (by === 'review') {
        const pr = row.prNumber != null ? `#${row.prNumber} · ` : '';
        return `${pr}${String(row.review ?? '')}`;
    }
    if (by === 'model') {
        return String(row.model ?? 'unknown');
    }
    return String(row.date ?? '');
}

function printResult(result: UsageTokensResult): void {
    const totals = result.summary?.totals;
    const cost = result.summary?.totalCost;
    cliInfo(
        chalk.bold(
            `Token usage · ${result.team.name} · ${result.range.startDate} → ${result.range.endDate}`,
        ),
    );
    cliInfo(
        `Tokens: ${formatTokens(totals?.total)} (input ${formatTokens(totals?.input)}, output ${formatTokens(totals?.output)})${result.previousPeriod ? formatDelta(totals?.total ?? 0, result.previousPeriod.tokens) : ''}`,
    );
    cliInfo(
        `Cost: ${formatCost(cost?.total)}${result.previousPeriod ? formatDelta(cost?.total ?? 0, result.previousPeriod.cost) : ''}`,
    );
    cliInfo(
        `Active days: ${result.activeDays} · Pull requests: ${result.pullRequests}`,
    );

    if (result.rows.length === 0) {
        cliInfo(chalk.yellow('No usage recorded for these filters.'));
        return;
    }

    cliInfo(`By ${result.by}:`);
    for (const row of result.rows) {
        const rowCost =
            row.cost && typeof row.cost === 'object'
                ? ` · ${formatCost((row.cost as { total?: number }).total)}`
                : '';
        const model =
            result.by !== 'model' && row.model
                ? chalk.dim(` [${row.model}]`)
                : '';
        cliInfo(
            `  ${rowLabel(row, result.by)}: ${formatTokens(row.total)} tokens${rowCost}${model}`,
        );
    }
}

export async function usageTokensAction(
    options: UsageTokensCommandOptions,
): Promise<void> {
    try {
        const result = await usageService.getTokens(options);
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printResult(result);
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export function createUsageCommand(): Command {
    const command = new Command('usage')
        .description(
            'Read usage data shown in the web app. Requires kodus auth login.',
        )
        .showHelpAfterError();

    command
        .command('tokens')
        .description(
            'Token usage and cost, as on the Token Usage page: totals, cost, previous-period deltas, and a breakdown by day, PR, developer, review run or model.',
        )
        .option(
            '--by <dimension>',
            `Breakdown: ${USAGE_DIMENSIONS.join(', ')}`,
            'daily',
        )
        .option('--from <date>', 'Start date YYYY-MM-DD (default: 15 days ago)')
        .option('--to <date>', 'End date YYYY-MM-DD (default: today)')
        .option('--repo <repository>', 'Repository id or owner/name')
        .option('--developer <developer>', 'Only this developer')
        .option('--pr <number>', 'Only this pull request number')
        .option(
            '--team <team>',
            'Team name or id (needed when the organization has more than one)',
        )
        .option('--json', 'Output the usage data as JSON')
        .action(async (options: UsageTokensCommandOptions) => {
            await usageTokensAction(options);
        });

    return command;
}

export const usageCommand = createUsageCommand();
