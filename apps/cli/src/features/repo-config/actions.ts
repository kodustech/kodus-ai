import { confirm, select } from '@inquirer/prompts';
import chalk from 'chalk';
import open from 'open';
import {
    formatRepositorySettingsOpenInfo,
    formatRepositorySettings,
    formatRepositorySetupPreview,
} from '../../formatters/repo-config.js';
import { repoConfigService } from '../../services/repo-config.service.js';
import {
    repositorySettingsService,
    type RepositorySettingsMutationResult,
} from '../../services/repo-settings.service.js';
import { repositorySettingsWizardService } from '../../services/repo-settings-wizard.service.js';
import { exitWithCode, isCliExitError } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { normalizeCommandError } from '../../utils/command-errors.js';
import {
    applyRepositorySetting,
    validateRepositorySettingKey,
} from '../../utils/repo-settings-schema.js';
import {
    addRepositoryPattern,
    removeRepositoryPattern,
    validateRepositoryPatternField,
} from '../../utils/repo-settings-patterns.js';
import {
    getKodusAppUrl,
    getRepositorySettingsSectionLabel,
    validateRepositorySettingsSection,
} from '../../utils/repo-settings-dashboard.js';
import {
    LOGIN_REQUIRED_HINT,
    userContextService,
} from '../../services/user-context.service.js';
import { reviewSettingsService } from '../../services/review-settings.service.js';
import { CommandError } from '../../utils/command-errors.js';
import {
    legacyAliasFor,
    resolveReviewSetting,
} from '../../utils/review-settings-catalog.js';
import {
    reviewSettingsSetAction,
    reviewSettingsShowAction,
    type ReviewSettingsSetOptions,
    type ReviewSettingsShowOptions,
} from './review-settings-actions.js';

export type ConfigRepoAddOptions = {
    prompt?: boolean;
    json?: boolean;
};

export type ConfigRepoListOptions = {
    json?: boolean;
    team?: string;
};

export type ConfigRepoShowOptions = ReviewSettingsShowOptions;

export type ConfigRepoSetupOptions = {
    yes?: boolean;
    json?: boolean;
};

export type ConfigRepoOpenOptions = {
    section?: string;
    json?: boolean;
};

export type ConfigRepoMutationOptions = ReviewSettingsSetOptions;

/**
 * Logged in, repository settings go through the endpoints Settings > Code
 * Review uses (every key, every level). A team key keeps the
 * /cli/config/repositories path and the keys it has always taken.
 */
async function isUserCredential(): Promise<boolean> {
    const credential = await userContextService.resolveCredential();
    return credential.kind === 'user';
}

function rejectTeamKeyScope(
    repository: string,
    options: { team?: string; directory?: string },
): void {
    if (repository === 'global' || options.directory || options.team) {
        throw new CommandError(
            'AUTH_REQUIRED',
            `Global, directory and --team settings require a logged-in user. ${LOGIN_REQUIRED_HINT}`,
        );
    }
}

function isKnownReviewSetting(key: string): boolean {
    try {
        resolveReviewSetting(key);
        return true;
    } catch {
        return false;
    }
}

const PATTERN_FIELD_KEYS: Record<string, string> = {
    'ignore-files': 'ignorePaths',
    'base-branches': 'baseBranches',
    'ignore-titles': 'ignoredTitleKeywords',
};

function shouldOfferSetupPrompt(options: ConfigRepoAddOptions = {}): boolean {
    if (options.prompt === false || options.json) {
        return false;
    }

    return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function printRepositoryMutationResult(
    result: RepositorySettingsMutationResult,
    options: ConfigRepoMutationOptions = {},
): void {
    if (options.json) {
        cliInfo(JSON.stringify(result, null, 2));
        return;
    }

    if ('centralized' in result) {
        cliInfo(
            chalk.green(
                `Repository settings change proposed for ${result.repositoryFullName}`,
            ),
        );
        cliInfo(
            result.centralized.message ||
                'Centralized config is enabled. Change queued in a pull request.',
        );

        if (result.centralized.prUrl) {
            cliInfo(`Pull request: ${result.centralized.prUrl}`);
        }

        return;
    }

    cliInfo(
        chalk.green(
            `Repository settings updated for ${result.repositoryFullName}`,
        ),
    );
}

export async function configRepoAction(
    repository = '.',
    options: ConfigRepoAddOptions = {},
): Promise<void> {
    try {
        const result = await repoConfigService.addRepository(repository);

        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }

        if (result.status === 'already-added') {
            cliInfo(
                chalk.yellow(
                    `Repository '${result.repositoryFullName}' is already added to Kodus.`,
                ),
            );
            return;
        }

        cliInfo(
            chalk.green(
                `Repository '${result.repositoryFullName}' was added to Kodus successfully.`,
            ),
        );

        if (shouldOfferSetupPrompt(options)) {
            const shouldConfigure = await confirm({
                message: 'Configure this repository now?',
                default: true,
            });

            if (shouldConfigure) {
                await configRepoSetupAction(repository);
            }
        }
    } catch (error) {
        if (error instanceof Error && error.message.includes('force closed')) {
            cliInfo(chalk.yellow('Operation cancelled'));
            return;
        }

        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configRepoAddAction(
    repository = '.',
    options: ConfigRepoAddOptions = {},
): Promise<void> {
    await configRepoAction(repository, options);
}

export async function configRemoteAction(
    repository = '.',
    options: ConfigRepoAddOptions = {},
): Promise<void> {
    await configRepoAction(repository, options);
}

export async function configRemoteAddAction(
    repository = '.',
    options: ConfigRepoAddOptions = {},
): Promise<void> {
    await configRepoAction(repository, options);
}

export async function configRepoListAction(
    options: ConfigRepoListOptions = {},
): Promise<void> {
    try {
        const repositories = await repoConfigService.listRepositories({
            team: options.team,
        });

        if (options.json) {
            cliInfo(JSON.stringify(repositories, null, 2));
            return;
        }

        if (repositories.length === 0) {
            cliInfo(chalk.yellow('No repositories are currently configured.'));
            return;
        }

        cliInfo('Configured repositories:');
        for (const repository of repositories) {
            cliInfo(`- ${repository.fullName}`);
        }
    } catch (error) {
        // A nested action already reported its error and exited.
        if (isCliExitError(error)) {
            throw error;
        }
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configRepoShowAction(
    repository = '.',
    options: ConfigRepoShowOptions = {},
): Promise<void> {
    try {
        if (await isUserCredential()) {
            await reviewSettingsShowAction(repository, options);
            return;
        }
        rejectTeamKeyScope(repository, options);

        const result =
            await repositorySettingsService.getRepositorySettings(repository);

        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }

        for (const line of formatRepositorySettings(result)) {
            cliInfo(line);
        }
    } catch (error) {
        // A nested action already reported its error and exited.
        if (isCliExitError(error)) {
            throw error;
        }
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configRepoSetupAction(
    repository = '.',
    options: ConfigRepoSetupOptions = {},
): Promise<void> {
    try {
        const current =
            await repositorySettingsService.getRepositorySettings(repository);
        let nextSettings =
            await repositorySettingsWizardService.collectSettings(
                current.settings,
                {
                    yes: options.yes,
                    writeLine: options.json ? undefined : cliInfo,
                },
            );

        while (true) {
            if (!options.json) {
                for (const line of formatRepositorySetupPreview(
                    current.repositoryFullName,
                    current.settings,
                    nextSettings,
                )) {
                    cliInfo(line);
                }
            }

            const nextAction = options.yes
                ? 'apply'
                : await select<string>({
                      message: 'What do you want to do next?',
                      default: 'apply',
                      choices: [
                          { name: 'Apply settings', value: 'apply' },
                          { name: 'Edit General', value: 'edit-general' },
                          { name: 'Edit Patterns', value: 'edit-patterns' },
                          { name: 'Cancel', value: 'cancel' },
                      ],
                  });

            if (nextAction === 'edit-general') {
                nextSettings =
                    await repositorySettingsWizardService.collectGeneralSettings(
                        nextSettings,
                        {
                            writeLine: options.json ? undefined : cliInfo,
                        },
                    );
                continue;
            }

            if (nextAction === 'edit-patterns') {
                nextSettings =
                    await repositorySettingsWizardService.collectPatternSettings(
                        nextSettings,
                        {
                            writeLine: options.json ? undefined : cliInfo,
                        },
                    );
                continue;
            }

            if (nextAction === 'cancel') {
                if (options.json) {
                    cliInfo(
                        JSON.stringify(
                            {
                                repositoryId: current.repositoryId,
                                repositoryFullName: current.repositoryFullName,
                                currentSettings: current.settings,
                                nextSettings,
                                applied: false,
                            },
                            null,
                            2,
                        ),
                    );
                    return;
                }

                cliInfo(chalk.yellow('Operation cancelled'));
                return;
            }

            break;
        }

        const updated =
            await repositorySettingsService.updateRepositorySettings(
                repository,
                nextSettings,
            );

        if (options.json) {
            cliInfo(
                JSON.stringify(
                    {
                        repositoryId: updated.repositoryId,
                        repositoryFullName: updated.repositoryFullName,
                        currentSettings: current.settings,
                        nextSettings,
                        applied: true,
                        ...('settings' in updated
                            ? { settings: updated.settings }
                            : { centralized: updated.centralized }),
                    },
                    null,
                    2,
                ),
            );
            return;
        }

        printRepositoryMutationResult(updated, options);
    } catch (error) {
        if (error instanceof Error && error.message.includes('force closed')) {
            cliInfo(chalk.yellow('Operation cancelled'));
            return;
        }

        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configRepoOpenAction(
    repository = '.',
    options: ConfigRepoOpenOptions = {},
): Promise<void> {
    try {
        const section = validateRepositorySettingsSection(options.section);
        const current =
            await repositorySettingsService.getRepositorySettings(repository);
        const appUrl = getKodusAppUrl();
        const sectionLabel = getRepositorySettingsSectionLabel(section);

        if (options.json) {
            cliInfo(
                JSON.stringify(
                    {
                        repositoryId: current.repositoryId,
                        repositoryFullName: current.repositoryFullName,
                        appUrl,
                        section,
                        sectionLabel,
                    },
                    null,
                    2,
                ),
            );
            return;
        }

        for (const line of formatRepositorySettingsOpenInfo(
            current.repositoryFullName,
            appUrl,
            sectionLabel,
        )) {
            cliInfo(line);
        }

        try {
            await open(appUrl);
        } catch {
            cliInfo(chalk.yellow(`Please visit: ${appUrl}`));
        }
    } catch (error) {
        // A nested action already reported its error and exited.
        if (isCliExitError(error)) {
            throw error;
        }
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configRepoSetAction(
    repository = '.',
    key: string,
    value: string,
    options: ConfigRepoMutationOptions = {},
): Promise<void> {
    try {
        if (await isUserCredential()) {
            await reviewSettingsSetAction(repository, key, value, options);
            return;
        }
        rejectTeamKeyScope(repository, options);

        const legacyKey = legacyAliasFor(key);
        if (!legacyKey && !isKnownReviewSetting(key)) {
            // Unknown everywhere: the team-key message, with the keys it takes.
            validateRepositorySettingKey(key);
        }
        if (!legacyKey) {
            throw new CommandError(
                'AUTH_REQUIRED',
                `Setting '${key}' requires a logged-in user; a team key sets only: review.enabled, review.autoApprove, review.requestChanges.minSeverity, patterns.ignoreFiles, patterns.baseBranches, patterns.ignoreTitles. ${LOGIN_REQUIRED_HINT}`,
            );
        }
        validateRepositorySettingKey(legacyKey);
        const current =
            await repositorySettingsService.getRepositorySettings(repository);
        const nextSettings = applyRepositorySetting(
            current.settings,
            legacyKey,
            value,
        );
        const updated =
            await repositorySettingsService.updateRepositorySettings(
                repository,
                nextSettings,
            );

        printRepositoryMutationResult(updated, options);
    } catch (error) {
        // A nested action already reported its error and exited.
        if (isCliExitError(error)) {
            throw error;
        }
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configRepoPatternAddAction(
    repository = '.',
    field: string,
    pattern: string,
    options: ConfigRepoMutationOptions = {},
): Promise<void> {
    try {
        const normalizedField = validateRepositoryPatternField(field);
        if (await isUserCredential()) {
            await updatePatternAsUser(
                repository,
                normalizedField,
                options,
                (patterns) =>
                    patterns.includes(pattern.trim())
                        ? patterns
                        : [...patterns, pattern.trim()],
            );
            return;
        }
        rejectTeamKeyScope(repository, options);

        const current =
            await repositorySettingsService.getRepositorySettings(repository);
        const nextSettings = addRepositoryPattern(
            current.settings,
            field,
            pattern,
        );
        const updated =
            await repositorySettingsService.updateRepositorySettings(
                repository,
                nextSettings,
            );

        printRepositoryMutationResult(updated, options);
    } catch (error) {
        // A nested action already reported its error and exited.
        if (isCliExitError(error)) {
            throw error;
        }
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configRepoPatternRemoveAction(
    repository = '.',
    field: string,
    pattern: string,
    options: ConfigRepoMutationOptions = {},
): Promise<void> {
    try {
        const normalizedField = validateRepositoryPatternField(field);
        if (await isUserCredential()) {
            await updatePatternAsUser(
                repository,
                normalizedField,
                options,
                (patterns) =>
                    patterns.filter((item) => item !== pattern.trim()),
            );
            return;
        }
        rejectTeamKeyScope(repository, options);

        const current =
            await repositorySettingsService.getRepositorySettings(repository);
        const nextSettings = removeRepositoryPattern(
            current.settings,
            field,
            pattern,
        );
        const updated =
            await repositorySettingsService.updateRepositorySettings(
                repository,
                nextSettings,
            );

        printRepositoryMutationResult(updated, options);
    } catch (error) {
        // A nested action already reported its error and exited.
        if (isCliExitError(error)) {
            throw error;
        }
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

/** A pattern list edit for a logged-in user: read the effective list at the scope, write the new one. */
async function updatePatternAsUser(
    repository: string,
    field: string,
    options: ConfigRepoMutationOptions,
    update: (patterns: string[]) => string[],
): Promise<void> {
    const key = PATTERN_FIELD_KEYS[field];
    const current = await reviewSettingsService.show(
        { repository, directory: options.directory, team: options.team },
        { includeFileOverlay: false },
    );
    const value = current.settings.find(
        (setting) => setting.key === key,
    )?.value;
    const patterns = Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];

    await reviewSettingsSetAction(
        repository,
        key,
        JSON.stringify(update(patterns)),
        options,
    );
}
