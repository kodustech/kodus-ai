import chalk from 'chalk';
import { Command } from 'commander';
import {
    cockpitService,
    type CockpitOptions,
    type CockpitTab,
    type CockpitTabResult,
} from '../../services/cockpit.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { normalizeCommandError } from '../../utils/command-errors.js';
import { cliError, cliInfo } from '../../utils/logger.js';

export type CockpitCommandOptions = CockpitOptions & { json?: boolean };

type Period = { [key: string]: number | undefined };
type Highlight = {
    currentPeriod?: Period;
    previousPeriod?: Period;
    comparison?: { percentageChange?: number; trend?: string };
};

const TAB_DESCRIPTIONS: Record<CockpitTab, string> = {
    'kodus-review':
        'Kodus Review tab: implementation rate (weekly, by category and severity), ignored criticals, 👍/👎 feedback, review outcomes, repository and Kody Rules health.',
    'intent':
        'Delivered as asked tab: pull requests checked against their task (business logic validation runs).',
    'productivity':
        'Productivity tab: deploy frequency, PR cycle time (lead time p75), bug ratio, PR size, lead time breakdown, PRs opened vs closed, PRs by developer, team activity.',
    'code-areas':
        'Code hotspots tab: the areas of one repository that change most and carry the most bug fixes.',
};

function formatNumber(value: unknown, digits = 1): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '-';
    }
    return Number.isInteger(value) ? String(value) : value.toFixed(digits);
}

function formatChange(highlight: Highlight | null | undefined): string {
    const change = highlight?.comparison?.percentageChange;
    if (typeof change !== 'number' || !Number.isFinite(change)) {
        return '';
    }
    const sign = change > 0 ? '+' : '';
    return chalk.dim(` (${sign}${change.toFixed(1)}% vs previous period)`);
}

// Review analytics rates are fractions (0..1).
function formatPercent(rate: unknown): string {
    if (typeof rate !== 'number' || !Number.isFinite(rate)) {
        return '-';
    }
    return `${(rate * 100).toFixed(1)}%`;
}

// The bug-ratio highlight already comes as a percentage
// (libs/cockpit/infrastructure/services/cockpit-code-health.service.ts).
function formatPercentValue(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '-';
    }
    return `${value.toFixed(1)}%`;
}

function countRows(value: unknown): string {
    return Array.isArray(value) ? `${value.length} rows` : '-';
}

function printProductivity(metrics: Record<string, unknown>): void {
    const deploy = metrics.deployFrequency as Highlight | null;
    const cycle = metrics.prCycleTime as Highlight | null;
    const bug = metrics.bugRatio as Highlight | null;
    const size = metrics.prSize as Highlight | null;

    if ('deployFrequency' in metrics) {
        cliInfo(
            `Deploy frequency: ${formatNumber(deploy?.currentPeriod?.totalDeployments)} deployments, ${formatNumber(deploy?.currentPeriod?.averagePerWeek)}/week${formatChange(deploy)}`,
        );
    }
    if ('prCycleTime' in metrics) {
        cliInfo(
            `PR cycle time (p75): ${formatNumber(cycle?.currentPeriod?.leadTimeP75Hours)} h${formatChange(cycle)}`,
        );
    }
    if ('bugRatio' in metrics) {
        cliInfo(
            `Bug ratio: ${formatPercentValue(bug?.currentPeriod?.ratio)} (${formatNumber(bug?.currentPeriod?.bugFixPRs)} of ${formatNumber(bug?.currentPeriod?.totalPRs)} PRs)${formatChange(bug)}`,
        );
    }
    if ('prSize' in metrics) {
        cliInfo(
            `PR size: ${formatNumber(size?.currentPeriod?.averagePRSize)} lines avg over ${formatNumber(size?.currentPeriod?.totalPRs)} PRs${formatChange(size)}`,
        );
    }
    cliInfo(
        chalk.dim(
            `Charts: lead time breakdown ${countRows(metrics.leadTimeBreakdown)}, cycle time weekly ${countRows(metrics.prCycleTimeWeekly)}, opened vs closed ${countRows(metrics.prsOpenedVsClosed)}, by developer ${countRows(metrics.prsMergedByDeveloper)}, team activity ${countRows(metrics.teamActivity)}. Use --json for the series.`,
        ),
    );
}

function printKodusReview(metrics: Record<string, unknown>): void {
    const weekly = (metrics.implementationRateWeekly ?? []) as Array<{
        sent?: number;
        implemented?: number;
    }>;
    const totals = (Array.isArray(weekly) ? weekly : []).reduce<{
        sent: number;
        implemented: number;
    }>(
        (acc, row) => ({
            sent: acc.sent + (row.sent ?? 0),
            implemented: acc.implemented + (row.implemented ?? 0),
        }),
        { sent: 0, implemented: 0 },
    );
    const rate = totals.sent > 0 ? totals.implemented / totals.sent : null;
    cliInfo(
        `Suggestions: ${totals.sent} sent, ${totals.implemented} implemented (${formatPercent(rate)})`,
    );

    const ignored = metrics.ignoredCriticals as { count?: number } | null;
    cliInfo(`Ignored criticals: ${formatNumber(ignored?.count)}`);

    const votes = metrics.negativeVoteRate as Highlight | null;
    cliInfo(
        `Feedback: ${formatNumber(votes?.currentPeriod?.thumbsUp)} 👍, ${formatNumber(votes?.currentPeriod?.thumbsDown)} 👎 (negative ${formatPercent(votes?.currentPeriod?.negativeRate)})${formatChange(votes)}`,
    );

    const operational = metrics.operationalMetrics as Highlight | null;
    if (operational?.currentPeriod) {
        const current = operational.currentPeriod;
        cliInfo(
            `Reviews: ${formatNumber(current.processedReviews)} on ${formatNumber(current.processedPRs)} PRs — ${formatPercent(current.successRate)} ok, ${formatPercent(current.errorRate)} error, ${formatPercent(current.skippedRate)} skipped`,
        );
    }

    const byCategory = (metrics.implementationRateByCategory ?? []) as Array<{
        category: string;
        rate?: number;
        sent?: number;
    }>;
    if (Array.isArray(byCategory) && byCategory.length > 0) {
        cliInfo('By category:');
        for (const row of byCategory) {
            cliInfo(
                `  ${row.category}: ${formatPercent(row.rate)} of ${formatNumber(row.sent)}`,
            );
        }
    }

    cliInfo(
        chalk.dim(
            `Tables: repositories ${countRows(metrics.repositoriesHealth)}, Kody Rules ${countRows(metrics.kodyRulesHealth)}. Use --json for every series.`,
        ),
    );
}

function printIntent(metrics: Record<string, unknown>): void {
    const intent = metrics.intent as {
        pullRequests?: number;
        metRate?: number;
        previousMetRate?: number;
        notInTaskRate?: number;
        withoutTaskRate?: number;
        byAuthor?: Array<{
            author: string;
            pullRequests: number;
            metRate: number;
        }>;
        mostMissed?: Array<{ topic: unknown; pullRequests: number }>;
    } | null;
    if (!intent || !intent.pullRequests) {
        cliInfo(
            chalk.yellow(
                'No pull requests were checked against a task in this period.',
            ),
        );
        return;
    }
    cliInfo(
        `Pull requests checked: ${intent.pullRequests}, delivered as asked ${formatPercent(intent.metRate)} (previous ${formatPercent(intent.previousMetRate)})`,
    );
    cliInfo(
        `Not in the task ${formatPercent(intent.notInTaskRate)}, without a task ${formatPercent(intent.withoutTaskRate)}`,
    );
    for (const row of intent.byAuthor ?? []) {
        cliInfo(
            `  ${row.author}: ${row.pullRequests} PRs, ${formatPercent(row.metRate)} as asked`,
        );
    }
    cliInfo(
        chalk.dim(
            'Use --json for the most missed requirements and per-team rows.',
        ),
    );
}

function printCodeAreas(metrics: Record<string, unknown>): void {
    const response = metrics.areaRiskMap as {
        rankedAreaPaths?: string[];
        map?: {
            directDirectories?: Array<{
                path: string;
                changedPrs: number;
                linkedBugFixPrs: number;
                titleBugFixPrs: number;
            }>;
        };
    } | null;
    const byPath = new Map(
        (response?.map?.directDirectories ?? []).map(
            (area) => [area.path, area] as const,
        ),
    );
    const ranked = (response?.rankedAreaPaths ?? [])
        .map((path) => byPath.get(path))
        .filter((area): area is NonNullable<typeof area> => !!area);

    if (ranked.length === 0) {
        cliInfo(chalk.yellow('No code areas mapped for this repository yet.'));
        return;
    }
    for (const area of ranked) {
        cliInfo(
            `${area.path}: ${area.changedPrs} PRs changed it, ${area.linkedBugFixPrs + area.titleBugFixPrs} bug fixes`,
        );
    }
}

function printResult(result: CockpitTabResult): void {
    const scope = result.repository
        ? result.repository.fullName
        : 'all repositories';
    cliInfo(
        chalk.bold(
            `Cockpit · ${result.tab} · ${result.team.name} · ${scope} · ${result.range.startDate} → ${result.range.endDate}`,
        ),
    );

    if (result.tab === 'productivity') {
        printProductivity(result.metrics);
    } else if (result.tab === 'kodus-review') {
        printKodusReview(result.metrics);
    } else if (result.tab === 'intent') {
        printIntent(result.metrics);
    } else {
        printCodeAreas(result.metrics);
    }

    const failed = Object.keys(result.errors);
    if (failed.length > 0) {
        cliInfo(chalk.yellow(`Unavailable: ${failed.join(', ')}`));
    }
    if (result.hidden.length > 0) {
        cliInfo(
            chalk.dim(
                `Turned off in Cockpit settings: ${result.hidden.join(', ')}`,
            ),
        );
    }
}

export async function cockpitTabAction(
    tab: CockpitTab,
    options: CockpitCommandOptions,
): Promise<void> {
    try {
        const result = await cockpitService.getTab(tab, options);
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

export function createCockpitCommand(): Command {
    const command = new Command('cockpit')
        .description(
            'Read the Cockpit dashboards of the web app (one subcommand per tab). Requires kodus auth login.',
        )
        .showHelpAfterError();

    for (const tab of Object.keys(TAB_DESCRIPTIONS) as CockpitTab[]) {
        command
            .command(tab)
            .description(TAB_DESCRIPTIONS[tab])
            .option(
                '--from <date>',
                'Start date YYYY-MM-DD (default: 15 days ago)',
            )
            .option('--to <date>', 'End date YYYY-MM-DD (default: today)')
            .option(
                '--repo <repository>',
                tab === 'code-areas'
                    ? 'Repository id or owner/name (default: the team’s first repository)'
                    : 'Repository id or owner/name (default: all repositories)',
            )
            .option(
                '--team <team>',
                'Team name or id (needed when the organization has more than one)',
            )
            .option('--json', 'Output the raw metrics as JSON')
            .action(async (options: CockpitCommandOptions) => {
                await cockpitTabAction(tab, options);
            });
    }

    return command;
}

export const cockpitCommand = createCockpitCommand();
