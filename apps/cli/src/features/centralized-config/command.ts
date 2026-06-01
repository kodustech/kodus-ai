import { Command } from 'commander';
import {
    configCentralizedDisableAction,
    configCentralizedDownloadAction,
    configCentralizedInitAction,
    configCentralizedStatusAction,
    configCentralizedSyncAction,
    type ConfigCentralizedActionOptions,
    type ConfigCentralizedDownloadOptions,
    type ConfigCentralizedInitOptions,
    type ConfigCentralizedStatusOptions,
} from './actions.js';

export const CENTRALIZED_CONFIG_DESCRIPTION =
    'Manage centralized repository configuration from the CLI. Team-key auth is required.';

export function registerCentralizedConfigCommand(command: Command): void {
    command.description(CENTRALIZED_CONFIG_DESCRIPTION);

    command
        .command('status')
        .description(
            'Show whether centralized config is enabled and its selected repository.',
        )
        .option('--json', 'Output centralized config status as JSON')
        .action(async (options: ConfigCentralizedStatusOptions) => {
            await configCentralizedStatusAction(options);
        });

    command
        .command('init [repository]')
        .description(
            "Enable centralized config and choose a repository. Use '.' for current repository.",
        )
        .option(
            '--sync-option <mode>',
            'Sync strategy after initialization: pr or manual',
            'pr',
        )
        .option('--json', 'Output centralized config init response as JSON')
        .action(
            async (
                repository: string | undefined,
                options: ConfigCentralizedInitOptions,
            ) => {
                await configCentralizedInitAction(repository, options);
            },
        );

    command
        .command('sync')
        .description(
            'Sync current centralized config to selected repositories.',
        )
        .option('--json', 'Output centralized config sync response as JSON')
        .action(async (options: ConfigCentralizedActionOptions) => {
            await configCentralizedSyncAction(options);
        });

    command
        .command('disable')
        .description(
            'Disable centralized config and clear selected repository.',
        )
        .option('--json', 'Output centralized config disable response as JSON')
        .action(async (options: ConfigCentralizedActionOptions) => {
            await configCentralizedDisableAction(options);
        });

    command
        .command('download')
        .description('Download the centralized config zip file.')
        .requiredOption(
            '--out <path>',
            'Output path for the downloaded zip file',
        )
        .option('--json', 'Output download metadata as JSON')
        .action(async (options: ConfigCentralizedDownloadOptions) => {
            await configCentralizedDownloadAction(options);
        });
}
