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
import { exitWithCode } from '../../utils/cli-exit.js';
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

export type ConfigRepoAddOptions = {
    prompt?: boolean;
    json?: boolean;
};

export type ConfigRepoListOptions = {
    json?: boolean;
};

export type ConfigRepoShowOptions = {
    json?: boolean;
};

export type ConfigRepoSetupOptions = {
    yes?: boolean;
    json?: boolean;
};

export type ConfigRepoOpenOptions = {
    section?: string;
    json?: boolean;
};

export type ConfigRepoMutationOptions = {
    json?: boolean;
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
        const repositories = await repoConfigService.listRepositories();

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
        validateRepositorySettingKey(key);
        const current =
            await repositorySettingsService.getRepositorySettings(repository);
        const nextSettings = applyRepositorySetting(
            current.settings,
            key,
            value,
        );
        const updated =
            await repositorySettingsService.updateRepositorySettings(
                repository,
                nextSettings,
            );

        printRepositoryMutationResult(updated, options);
    } catch (error) {
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
        validateRepositoryPatternField(field);
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
        validateRepositoryPatternField(field);
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
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}
