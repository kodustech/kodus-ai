import chalk from 'chalk';
import type { CentralizedConfigRepository } from '../../types/config.js';
import { centralizedConfigService } from '../../services/centralized-config.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { normalizeCommandError } from '../../utils/command-errors.js';
import { cliError, cliInfo } from '../../utils/logger.js';

type ConnectionOption = {
    /** The Git connection, when the workspace has several. */
    connection?: string;
};

export type ConfigCentralizedStatusOptions = ConnectionOption & {
    json?: boolean;
};

export type ConfigCentralizedInitOptions = ConnectionOption & {
    syncOption?: string;
    json?: boolean;
};

export type ConfigCentralizedDownloadOptions = ConnectionOption & {
    out: string;
    json?: boolean;
};

export type ConfigCentralizedActionOptions = ConnectionOption & {
    json?: boolean;
};

function connectionScope(
    options: ConnectionOption,
): [] | [{ connectionId: string }] {
    const connectionId = options.connection?.trim();
    return connectionId ? [{ connectionId }] : [];
}

function resolveSyncOption(value: string | undefined): 'pr' | 'manual' {
    if (!value) {
        return 'pr';
    }

    if (value === 'pr' || value === 'manual') {
        return value;
    }

    throw new Error(
        `Invalid value for --sync-option: '${value}'. Use one of: pr, manual.`,
    );
}

function formatRepositoryLabel(
    repository: CentralizedConfigRepository,
): string {
    return repository.name;
}

export async function configCentralizedStatusAction(
    options: ConfigCentralizedStatusOptions = {},
): Promise<void> {
    try {
        const status = await centralizedConfigService.getStatus(
            ...connectionScope(options),
        );

        if (options.json) {
            cliInfo(JSON.stringify(status, null, 2));
            return;
        }

        if (status.connections?.length) {
            cliInfo('Centralized config per Git connection:');
            for (const connection of status.connections) {
                cliInfo(
                    connection.enabled && connection.repository
                        ? `  ${connection.connectionId}: enabled, ${formatRepositoryLabel(connection.repository)} (${connection.repository.id})`
                        : `  ${connection.connectionId}: disabled`,
                );
            }
            cliInfo('Pass --connection <id> to manage one.');
            return;
        }

        if (!status.enabled || !status.repository) {
            cliInfo(chalk.yellow('Centralized config is disabled.'));
            return;
        }

        cliInfo(chalk.green('Centralized config is enabled.'));
        cliInfo(
            `Repository: ${formatRepositoryLabel(status.repository)} (${status.repository.id})`,
        );
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configCentralizedInitAction(
    repository?: string,
    options: ConfigCentralizedInitOptions = {},
): Promise<void> {
    try {
        const syncOption = resolveSyncOption(options.syncOption);
        const response = await centralizedConfigService.init({
            repository,
            syncOption,
            ...(connectionScope(options)[0] ?? {}),
        });

        if (options.json) {
            cliInfo(JSON.stringify(response, null, 2));
            return;
        }

        if (response.message) {
            cliInfo(chalk.green(response.message));
        }

        cliInfo(
            `Repository: ${response.repository.full_name ?? `${response.repository.organizationName}/${response.repository.name}`}`,
        );

        if (response.prUrl) {
            cliInfo(`Pull request: ${response.prUrl}`);
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

export async function configCentralizedSyncAction(
    options: ConfigCentralizedActionOptions = {},
): Promise<void> {
    try {
        const response = await centralizedConfigService.sync(
            ...connectionScope(options),
        );

        if (options.json) {
            cliInfo(JSON.stringify(response, null, 2));
            return;
        }

        cliInfo(chalk.green(response.message));
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configCentralizedDisableAction(
    options: ConfigCentralizedActionOptions = {},
): Promise<void> {
    try {
        const response = await centralizedConfigService.disable(
            ...connectionScope(options),
        );

        if (options.json) {
            cliInfo(JSON.stringify(response, null, 2));
            return;
        }

        cliInfo(chalk.green(response.message));
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function configCentralizedDownloadAction(
    options: ConfigCentralizedDownloadOptions,
): Promise<void> {
    try {
        const result = await centralizedConfigService.download(
            options.out,
            ...connectionScope(options),
        );

        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }

        cliInfo(chalk.green('Centralized config downloaded successfully.'));
        cliInfo(`Path: ${result.outputPath}`);
        cliInfo(`Bytes: ${result.bytes}`);
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}
