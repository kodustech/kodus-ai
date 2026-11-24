import chalk from 'chalk';
import { Command } from 'commander';
import { rulesService } from '../services/rules.service.js';
import type {
    CentralizedPrResponse,
    KodyRule,
    KodyRuleScope,
    KodyRuleSeverity,
    KodyRuleStatus,
} from '../types/rules.js';
import { exitWithCode, isCliExitError } from '../utils/cli-exit.js';
import { normalizeCommandError } from '../utils/command-errors.js';
import { cliError, cliInfo } from '../utils/logger.js';
import { isCentralizedPrResponse as isCentralizedPrResponseTypeGuard } from '../types/rules.js';

export type RulesCreateOptions = {
    team?: string;
    title: string;
    rule: string;
    repoId?: string;
    severity?: KodyRuleSeverity;
    scope?: KodyRuleScope;
    path?: string;
    json?: boolean;
};

export type RulesUpdateOptions = {
    team?: string;
    uuid: string;
    repoId?: string;
    title?: string;
    rule?: string;
    severity?: KodyRuleSeverity;
    scope?: KodyRuleScope;
    path?: string;
    json?: boolean;
};

export type RulesViewOptions = {
    team?: string;
    uuid?: string;
    repoId?: string;
    json?: boolean;
};

export type RulesStatusOptions = {
    uuid: string[];
    team?: string;
    json?: boolean;
};

function printRule(rule: KodyRule, fallbackRepositoryId = 'global'): void {
    cliInfo(`Rule UUID: ${rule.uuid}`);
    cliInfo(`Repository ID: ${rule.repositoryId ?? fallbackRepositoryId}`);
    cliInfo(`Rule Title: ${rule.title}`);
    cliInfo(`Rule: ${rule.rule}`);
    if (rule.severity) {
        cliInfo(`Severity: ${rule.severity}`);
    }
    if (rule.scope) {
        cliInfo(`Scope: ${rule.scope}`);
    }
    if (rule.path) {
        cliInfo(`Path: ${rule.path}`);
    }
    if (rule.status) {
        cliInfo(`Status: ${rule.status}`);
    }
}

function printCentralizedPr(response: CentralizedPrResponse): void {
    cliInfo(
        chalk.green(
            'Kody Rule change proposed through centralized pull request.',
        ),
    );
    if (response.message) {
        cliInfo(response.message);
    }
    if (response.prUrl) {
        cliInfo(`PR URL: ${response.prUrl}`);
    }
    if (response.prNumber !== undefined) {
        cliInfo(`PR Number: ${response.prNumber}`);
    }
}

function printRuleList(
    rules: KodyRule[],
    fallbackRepositoryId = 'global',
): void {
    if (rules.length === 0) {
        cliInfo(chalk.yellow('No Kody Rules found.'));
        return;
    }

    rules.forEach((rule, index) => {
        printRule(rule, fallbackRepositoryId);
        if (index < rules.length - 1) {
            cliInfo('');
        }
    });
}

export async function rulesCreateAction(
    options: RulesCreateOptions,
): Promise<void> {
    try {
        const createdRule = await rulesService.createRule(
            {
                title: options.title,
                rule: options.rule,
                repositoryId: options.repoId,
                severity: options.severity,
                scope: options.scope,
                path: options.path,
            },
            { team: options.team },
        );

        if (options.json) {
            cliInfo(JSON.stringify(createdRule, null, 2));
            return;
        }

        if (isCentralizedPrResponseTypeGuard(createdRule)) {
            printCentralizedPr(createdRule);
            return;
        }

        cliInfo(chalk.green('Kody Rule created successfully.'));
        printRule(createdRule, options.repoId ?? 'global');
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function rulesUpdateAction(
    options: RulesUpdateOptions,
): Promise<void> {
    try {
        const updatedRule = await rulesService.updateRule(
            {
                ruleId: options.uuid,
                repositoryId: options.repoId,
                title: options.title,
                rule: options.rule,
                severity: options.severity,
                scope: options.scope,
                path: options.path,
            },
            { team: options.team },
        );

        if (options.json) {
            cliInfo(JSON.stringify(updatedRule, null, 2));
            return;
        }

        if (isCentralizedPrResponseTypeGuard(updatedRule)) {
            printCentralizedPr(updatedRule);
            return;
        }

        cliInfo(chalk.green('Kody Rule updated successfully.'));
        printRule(updatedRule, options.repoId ?? 'global');
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function rulesViewAction(
    options: RulesViewOptions,
): Promise<void> {
    try {
        const rules = await rulesService.viewRules(
            {
                ruleId: options.uuid,
                repositoryId: options.repoId,
            },
            { team: options.team },
        );

        if (options.json) {
            cliInfo(JSON.stringify(rules, null, 2));
            return;
        }

        printRuleList(rules, options.repoId ?? 'global');
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

const STATUS_LABELS: Record<KodyRuleStatus, string> = {
    deleted: 'deleted',
    paused: 'paused',
    active: 'resumed',
};

function rulesStatusAction(status: KodyRuleStatus) {
    return async (options: RulesStatusOptions): Promise<void> => {
        try {
            const result = await rulesService.changeStatus(
                options.uuid,
                status,
                { team: options.team },
            );

            if (options.json) {
                cliInfo(JSON.stringify(result, null, 2));
                return;
            }

            if (isCentralizedPrResponseTypeGuard(result)) {
                printCentralizedPr(result);
                return;
            }

            const changed = result.filter((rule) => rule.status === status);
            const unchanged = result.filter((rule) => rule.status !== status);
            cliInfo(
                chalk.green(
                    `${changed.length} Kody Rule(s) ${STATUS_LABELS[status]}.`,
                ),
            );
            printRuleList(changed);
            if (unchanged.length > 0) {
                const locked = unchanged.some((rule) => rule.lockedByPlan);
                cliInfo('');
                cliInfo(
                    chalk.yellow(
                        `${unchanged.length} Kody Rule(s) kept their status${locked ? ': the plan allows no more active rules' : ''}.`,
                    ),
                );
                printRuleList(unchanged);
                exitWithCode(1);
            }
        } catch (error) {
            if (isCliExitError(error)) {
                throw error;
            }
            const normalized = normalizeCommandError(error);
            cliError(chalk.red(normalized.message));
            exitWithCode(normalized.exitCode);
        }
    };
}

export const rulesDeleteAction = rulesStatusAction('deleted');
export const rulesPauseAction = rulesStatusAction('paused');
export const rulesResumeAction = rulesStatusAction('active');

function collectUuids(value: string, previous: string[] = []): string[] {
    return [
        ...previous,
        ...value
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean),
    ];
}

const TEAM_OPTION_DESCRIPTION =
    'Team name or id (logged-in users with more than one team)';

export const rulesCommand = new Command('rules')
    .description('Create, update, view, pause, resume, and delete Kody Rules')
    .showHelpAfterError();

rulesCommand
    .command('create')
    .description('Create a new Kody Rule')
    .requiredOption('--title <title>', 'Rule title')
    .requiredOption('--rule <rule>', 'Rule content/description')
    .option('--repo-id <id>', 'Repository ID for the rule', 'global')
    .option(
        '--severity <severity>',
        'Rule severity (low, medium, high, critical)',
        'medium',
    )
    .option('--scope <scope>', "Rule scope ('pull-request' or 'file')", 'file')
    .option('--path <glob>', 'Optional glob pattern for file targeting', '**/*')
    .option('--team <team>', TEAM_OPTION_DESCRIPTION)
    .option('--json', 'Output created rule as JSON', false)
    .action(rulesCreateAction);

rulesCommand
    .command('update')
    .description('Update an existing Kody Rule')
    .requiredOption('--uuid <uuid>', 'Rule UUID to update')
    .option('--repo-id <id>', 'Updated rule repository ID')
    .option('--title <title>', 'Updated rule title')
    .option('--rule <rule>', 'Updated rule content/description')
    .option(
        '--severity <severity>',
        'Updated rule severity (low, medium, high, critical)',
    )
    .option('--scope <scope>', "Updated rule scope ('pull-request' or 'file')")
    .option('--path <glob>', 'Updated glob pattern for file targeting')
    .option('--team <team>', TEAM_OPTION_DESCRIPTION)
    .option('--json', 'Output updated rule as JSON')
    .action(rulesUpdateAction);

rulesCommand
    .command('view')
    .description('View Kody Rules')
    .option('--uuid <uuid>', 'Rule UUID to fetch')
    .option('--repo-id <id>', 'Repository ID to filter rules')
    .option('--team <team>', TEAM_OPTION_DESCRIPTION)
    .option('--json', 'Output rules as JSON')
    .action(rulesViewAction);

const STATUS_COMMANDS: Array<{
    name: string;
    description: string;
    action: (options: RulesStatusOptions) => Promise<void>;
}> = [
    {
        name: 'pause',
        description:
            'Pause Kody Rules: kept in the list, not enforced in reviews (requires kodus auth login)',
        action: rulesPauseAction,
    },
    {
        name: 'resume',
        description:
            'Resume paused Kody Rules so reviews enforce them again (requires kodus auth login)',
        action: rulesResumeAction,
    },
    {
        name: 'delete',
        description: 'Delete Kody Rules (requires kodus auth login)',
        action: rulesDeleteAction,
    },
];

for (const { name, description, action } of STATUS_COMMANDS) {
    rulesCommand
        .command(name)
        .description(description)
        .requiredOption(
            '--uuid <uuid>',
            'Rule UUID; repeat or comma-separate for several',
            collectUuids,
        )
        .option('--team <team>', TEAM_OPTION_DESCRIPTION)
        .option('--json', 'Output the result as JSON')
        .action(action);
}
