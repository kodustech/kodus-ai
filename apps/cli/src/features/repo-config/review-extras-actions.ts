import chalk from 'chalk';
import {
    customAgentsService,
    type KnowledgeEntry,
    type KnowledgeSaveResult,
} from '../../services/custom-agents.service.js';
import {
    MESSAGE_FIELDS,
    reviewMessagesService,
    type MessagesMutationResult,
    type MessagesShowResult,
} from '../../services/review-messages.service.js';
import {
    REVIEW_LANGUAGES,
    reviewLanguageService,
    type ReviewLanguageResult,
} from '../../services/review-language.service.js';
import { reviewSettingsService } from '../../services/review-settings.service.js';
import type { CentralizedPrResult } from '../../types/custom-agents.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import {
    CommandError,
    normalizeCommandError,
} from '../../utils/command-errors.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import fs from 'node:fs/promises';
import {
    describeScope,
    type ReviewSettingsTargetOptions,
} from './review-settings-actions.js';

export type MessagesSetOptions = ReviewSettingsTargetOptions & {
    fromFile?: string;
};

export type SkillsListOptions = ReviewSettingsTargetOptions & {
    check?: boolean;
};

export type SkillsAddOptions = ReviewSettingsTargetOptions & {
    kind?: string;
    link?: string[];
};

function fail(error: unknown): void {
    const normalized = normalizeCommandError(error);
    cliError(chalk.red(normalized.message));
    exitWithCode(normalized.exitCode);
}

function formatValue(value: unknown): string {
    if (value === undefined || value === null) {
        return chalk.gray('(not set)');
    }
    if (typeof value === 'string') {
        const oneLine = value.replace(/\s+/g, ' ').trim();
        if (oneLine === '') {
            return chalk.gray('""');
        }
        return oneLine.length > 80 ? `${oneLine.slice(0, 77)}...` : oneLine;
    }
    return JSON.stringify(value);
}

function printCentralized(
    centralized: { message?: string; prUrl?: string },
    what: string,
): void {
    cliInfo(
        chalk.green(`${what} proposed through a centralized pull request.`),
    );
    cliInfo(
        centralized.message ||
            'Centralized config is enabled. Change queued in a pull request.',
    );
    if (centralized.prUrl) {
        cliInfo(`Pull request: ${centralized.prUrl}`);
    }
}

// ── custom messages ─────────────────────────────────────────────────────────

export function formatMessagesShow(result: MessagesShowResult): string[] {
    const lines = [
        chalk.bold(
            `Custom messages for ${describeScope(result.scope)} (team ${result.team})`,
        ),
    ];
    for (const field of result.fields) {
        const origin =
            field.level === result.scope.level
                ? chalk.cyan('set here')
                : chalk.gray(`from ${field.level}`);
        lines.push(`  ${field.field} = ${formatValue(field.value)}  ${origin}`);
    }
    return lines;
}

function printMessagesMutation(result: MessagesMutationResult): void {
    if (!result.changed) {
        cliInfo(
            chalk.yellow(
                `${result.field} is not set at ${describeScope(result.scope)}; it already inherits.`,
            ),
        );
        return;
    }
    if (result.centralized) {
        printCentralized(result.centralized, `${result.field} change`);
        return;
    }
    cliInfo(
        chalk.green(
            `${result.field} = ${formatValue(result.value)} at ${describeScope(result.scope)}`,
        ),
    );
}

export async function messagesShowAction(
    repository: string,
    options: ReviewSettingsTargetOptions = {},
): Promise<void> {
    try {
        const result = await reviewMessagesService.show({
            repository,
            directory: options.directory,
            team: options.team,
        });
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        for (const line of formatMessagesShow(result)) {
            cliInfo(line);
        }
    } catch (error) {
        fail(error);
    }
}

export async function messagesSetAction(
    repository: string,
    field: string,
    value: string | undefined,
    options: MessagesSetOptions = {},
): Promise<void> {
    try {
        let raw = value;
        if (options.fromFile) {
            if (value !== undefined) {
                throw new CommandError(
                    'INVALID_INPUT',
                    'Pass the value or --from-file, not both.',
                );
            }
            raw = await fs.readFile(options.fromFile, 'utf-8');
        }
        if (raw === undefined) {
            throw new CommandError(
                'INVALID_INPUT',
                'Pass the value, or --from-file <path> for a long message.',
            );
        }
        const result = await reviewMessagesService.set(
            {
                repository,
                directory: options.directory,
                team: options.team,
            },
            field,
            raw,
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printMessagesMutation(result);
    } catch (error) {
        fail(error);
    }
}

export async function messagesUnsetAction(
    repository: string,
    field: string,
    options: ReviewSettingsTargetOptions = {},
): Promise<void> {
    try {
        const result = await reviewMessagesService.unset(
            {
                repository,
                directory: options.directory,
                team: options.team,
            },
            field,
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printMessagesMutation(result);
    } catch (error) {
        fail(error);
    }
}

export async function messagesFieldsAction(
    options: { json?: boolean } = {},
): Promise<void> {
    if (options.json) {
        cliInfo(JSON.stringify(MESSAGE_FIELDS, null, 2));
        return;
    }
    for (const field of MESSAGE_FIELDS) {
        cliInfo(`${field.field} (${field.type}): ${field.description}`);
    }
}

// ── review language ─────────────────────────────────────────────────────────

function printLanguage(result: ReviewLanguageResult, verb: string): void {
    cliInfo(
        `Review language for team ${result.team} ${verb} ${result.name} (${result.language})${result.isDefault ? chalk.gray(' — default') : ''}`,
    );
}

export async function languageShowAction(
    options: { team?: string; json?: boolean } = {},
): Promise<void> {
    try {
        const result = await reviewLanguageService.show({ team: options.team });
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printLanguage(result, 'is');
    } catch (error) {
        fail(error);
    }
}

export async function languageSetAction(
    language: string,
    options: { team?: string; json?: boolean } = {},
): Promise<void> {
    try {
        const result = await reviewLanguageService.set(language, {
            team: options.team,
        });
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printLanguage(result, 'set to');
    } catch (error) {
        fail(error);
    }
}

export async function languageListAction(
    options: { json?: boolean } = {},
): Promise<void> {
    if (options.json) {
        cliInfo(JSON.stringify(REVIEW_LANGUAGES, null, 2));
        return;
    }
    for (const language of REVIEW_LANGUAGES) {
        cliInfo(`${language.code}  ${language.name}`);
    }
}

// ── skills & docs ───────────────────────────────────────────────────────────

/** `config remote` takes '.', owner/repo, an id or 'global'; the agents service takes the same refs as --repo. */
async function knowledgeTarget(
    repository: string,
    options: ReviewSettingsTargetOptions,
) {
    return {
        team: options.team,
        repo:
            repository === 'global'
                ? 'global'
                : await reviewSettingsService.resolveRepositoryReference(
                      repository,
                  ),
        directory: options.directory,
    };
}

function describeLevel(result: {
    level: string;
    repository?: { name: string };
    directory?: { label: string };
}): string {
    if (result.level === 'global') {
        return 'global settings';
    }
    return result.directory
        ? `${result.repository?.name}:${result.directory.label}`
        : (result.repository?.name ?? result.level);
}

function formatKnowledgeEntry(entry: KnowledgeEntry): string {
    const name = entry.report?.name ? ` (${entry.report.name})` : '';
    const followers = entry.followedBy.length
        ? entry.followedBy.join(', ')
        : chalk.yellow('nothing follows it');
    const missing =
        entry.report && !entry.report.found ? chalk.red(' — not found') : '';
    return `  [${entry.kind}] ${entry.path}${name}${missing} → ${followers}`;
}

function printKnowledgeSave(result: KnowledgeSaveResult, verb: string): void {
    if (result.centralized) {
        printCentralized(
            result.centralized as CentralizedPrResult,
            'Skills and docs change',
        );
        return;
    }
    if (!result.changed) {
        cliInfo(chalk.yellow('Nothing to change.'));
        return;
    }
    cliInfo(
        chalk.green(
            `Skills and docs ${verb} at ${describeLevel(result)} (${result.items.length} added).`,
        ),
    );
    if (result.note) {
        cliInfo(result.note);
    }
}

export async function skillsListAction(
    repository: string,
    options: SkillsListOptions = {},
): Promise<void> {
    try {
        const result = await customAgentsService.listKnowledge({
            ...(await knowledgeTarget(repository, options)),
            check: options.check,
        });
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        cliInfo(
            chalk.bold(
                `Skills & docs for ${describeLevel(result)} (team ${result.team})${result.branch ? ` on ${result.branch}` : ''}`,
            ),
        );
        if (result.items.length === 0) {
            cliInfo(chalk.gray('  Nothing added yet.'));
        }
        for (const entry of result.items) {
            cliInfo(formatKnowledgeEntry(entry));
            for (const issue of entry.report?.issues ?? []) {
                cliInfo(
                    `      ${issue.severity === 'error' ? chalk.red(issue.message) : chalk.yellow(issue.message)}`,
                );
            }
        }
        if (result.inherited.length) {
            cliInfo(chalk.bold('From the repository:'));
            for (const entry of result.inherited) {
                cliInfo(formatKnowledgeEntry(entry));
            }
        }
        if (result.unavailable) {
            cliInfo(chalk.gray(result.unavailable));
        }
        for (const budget of result.overBudget ?? []) {
            cliInfo(
                chalk.yellow(
                    `${budget.target} is over its limit (${budget.over.join(', ')}).`,
                ),
            );
        }
        cliInfo(
            chalk.gray(
                `Link targets: ${result.targets.map((target) => target.label).join(', ')}`,
            ),
        );
    } catch (error) {
        fail(error);
    }
}

export async function skillsDiscoverAction(
    repository: string,
    options: ReviewSettingsTargetOptions = {},
): Promise<void> {
    try {
        const result = await customAgentsService.discoverKnowledge(
            await knowledgeTarget(repository, options),
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        if (result.unavailable) {
            cliInfo(chalk.yellow(result.unavailable));
            return;
        }
        cliInfo(
            chalk.bold(
                `Found in ${result.repository.name}${result.branch ? ` on ${result.branch}` : ''}:`,
            ),
        );
        if (result.candidates.length === 0) {
            cliInfo(chalk.gray('  Nothing new found.'));
        }
        for (const candidate of result.candidates) {
            const warning = candidate.kodyRuleSource
                ? chalk.yellow(
                      ' — also a Kody Rules source: linking it can make the same rule comment twice',
                  )
                : '';
            cliInfo(
                `  [${candidate.kind}] ${candidate.path}${candidate.name ? ` (${candidate.name})` : ''}${warning}`,
            );
        }
    } catch (error) {
        fail(error);
    }
}

export async function skillsAddAction(
    repository: string,
    paths: string[],
    options: SkillsAddOptions = {},
): Promise<void> {
    try {
        const result = await customAgentsService.addKnowledge(
            paths,
            await knowledgeTarget(repository, options),
            { kind: options.kind, link: options.link },
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printKnowledgeSave(result, 'saved');
    } catch (error) {
        fail(error);
    }
}

export async function skillsRemoveAction(
    repository: string,
    paths: string[],
    options: ReviewSettingsTargetOptions = {},
): Promise<void> {
    try {
        const result = await customAgentsService.removeKnowledge(
            paths,
            await knowledgeTarget(repository, options),
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printKnowledgeSave(result, 'saved');
    } catch (error) {
        fail(error);
    }
}

export async function skillsLinkAction(
    repository: string,
    path: string,
    targets: string[],
    linked: boolean,
    options: ReviewSettingsTargetOptions = {},
): Promise<void> {
    try {
        const result = await customAgentsService.linkKnowledge(
            path,
            targets,
            linked,
            await knowledgeTarget(repository, options),
        );
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        printKnowledgeSave(result, linked ? 'linked' : 'unlinked');
    } catch (error) {
        fail(error);
    }
}
