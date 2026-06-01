import { Command } from 'commander';
import {
    configRemoteAction,
    configRemoteAddAction,
    configRepoAddAction,
    configRepoListAction,
    configRepoOpenAction,
    configRepoPatternAddAction,
    configRepoPatternRemoveAction,
    configRepoSetAction,
    configRepoSetupAction,
    configRepoShowAction,
    configRepoAction,
    type ConfigRepoAddOptions,
    type ConfigRepoListOptions,
    type ConfigRepoMutationOptions,
    type ConfigRepoOpenOptions,
    type ConfigRepoSetupOptions,
    type ConfigRepoShowOptions,
} from './actions.js';
import { SUPPORTED_REPO_PATTERN_FIELDS } from '../../utils/repo-settings-patterns.js';

export const REPOSITORY_CONFIG_DESCRIPTION =
    "Inspect and update the current repository settings in Kodus. Team-key auth is required for repository config commands. Use 'kodus config -r [repository]' as a shortcut for 'kodus config remote add [repository]'.";

type RepositoryConfigHandlers = {
    action: (
        repository?: string,
        options?: ConfigRepoAddOptions,
    ) => Promise<void>;
    addAction: (
        repository?: string,
        options?: ConfigRepoAddOptions,
    ) => Promise<void>;
};

export function registerRepositoryConfigCommand(
    command: Command,
    options: {
        description?: string;
        handlers?: RepositoryConfigHandlers;
    } = {},
): void {
    const handlers = options.handlers ?? {
        action: configRemoteAction,
        addAction: configRemoteAddAction,
    };

    command
        .description(options.description ?? REPOSITORY_CONFIG_DESCRIPTION)
        .argument(
            '[repository]',
            "Repository to add. Use '.' for the current repo.",
            '.',
        )
        .option('--no-prompt', 'Skip the post-add setup prompt')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ConfigRepoAddOptions,
            ) => {
                await handlers.action(repository ?? '.', actionOptions);
            },
        );

    command
        .command('add [repository]')
        .description(
            "Add a repository to Kodus. Equivalent to 'kodus config -r [repository]'. Use '.' for the current repo.",
        )
        .option('--no-prompt', 'Skip the post-add setup prompt')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ConfigRepoAddOptions,
            ) => {
                await handlers.addAction(repository ?? '.', actionOptions);
            },
        );

    command
        .command('list')
        .description('List repositories already configured in Kodus.')
        .option('--json', 'Output configured repositories as JSON')
        .action(async (actionOptions: ConfigRepoListOptions) => {
            await configRepoListAction(actionOptions);
        });

    command
        .command('show [repository]')
        .description(
            "Show repository settings in Kodus. Use '.' for the current repo.",
        )
        .option('--json', 'Output repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ConfigRepoShowOptions,
            ) => {
                await configRepoShowAction(repository ?? '.', actionOptions);
            },
        );

    command
        .command('setup [repository]')
        .description(
            "Run a guided repository setup in Kodus. Use '.' for the current repo.",
        )
        .option(
            '--yes',
            'Apply current/default answers without interactive prompts',
        )
        .option('--json', 'Output setup result as JSON')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ConfigRepoSetupOptions,
            ) => {
                await configRepoSetupAction(repository ?? '.', actionOptions);
            },
        );

    command
        .command('set [repository] <key> <value>')
        .description(
            "Set a repository setting directly. Use '.' for the current repo.",
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                key: string,
                value: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoSetAction(
                    repository ?? '.',
                    key,
                    value,
                    actionOptions,
                );
            },
        );

    command
        .command('open [repository]')
        .description(
            "Open the Kodus dashboard for advanced repository settings. Use '.' for the current repo.",
        )
        .option(
            '--section <section>',
            'Section to open guidance for (general, review-categories, custom-prompts, suggestion-control, pr-summary, kody-rules, custom-messages, business-rules)',
        )
        .option('--json', 'Output dashboard handoff metadata as JSON')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ConfigRepoOpenOptions,
            ) => {
                await configRepoOpenAction(repository ?? '.', actionOptions);
            },
        );

    command
        .command('add-pattern [repository] <field> <pattern>')
        .description(
            `Add a pattern to a repository list field. Supported fields: ${SUPPORTED_REPO_PATTERN_FIELDS.join(', ')}`,
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                field: string,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternAddAction(
                    repository ?? '.',
                    field,
                    pattern,
                    actionOptions,
                );
            },
        );

    command
        .command('add-ignore-file [repository] <pattern>')
        .description(
            'Add a pattern to ignored file patterns for the repository.',
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternAddAction(
                    repository ?? '.',
                    'ignore-files',
                    pattern,
                    actionOptions,
                );
            },
        );

    command
        .command('remove-ignore-file [repository] <pattern>')
        .description(
            'Remove a pattern from ignored file patterns for the repository.',
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternRemoveAction(
                    repository ?? '.',
                    'ignore-files',
                    pattern,
                    actionOptions,
                );
            },
        );

    command
        .command('add-base-branch [repository] <pattern>')
        .description(
            'Add a pattern to base branch patterns for the repository.',
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternAddAction(
                    repository ?? '.',
                    'base-branches',
                    pattern,
                    actionOptions,
                );
            },
        );

    command
        .command('remove-base-branch [repository] <pattern>')
        .description(
            'Remove a pattern from base branch patterns for the repository.',
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternRemoveAction(
                    repository ?? '.',
                    'base-branches',
                    pattern,
                    actionOptions,
                );
            },
        );

    command
        .command('add-ignore-title [repository] <pattern>')
        .description(
            'Add a pattern to ignored title patterns for the repository.',
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternAddAction(
                    repository ?? '.',
                    'ignore-titles',
                    pattern,
                    actionOptions,
                );
            },
        );

    command
        .command('remove-ignore-title [repository] <pattern>')
        .description(
            'Remove a pattern from ignored title patterns for the repository.',
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternRemoveAction(
                    repository ?? '.',
                    'ignore-titles',
                    pattern,
                    actionOptions,
                );
            },
        );

    command
        .command('remove-pattern [repository] <field> <pattern>')
        .description(
            `Remove a pattern from a repository list field. Supported fields: ${SUPPORTED_REPO_PATTERN_FIELDS.join(', ')}`,
        )
        .option('--json', 'Output updated repository settings as JSON')
        .action(
            async (
                repository: string | undefined,
                field: string,
                pattern: string,
                actionOptions: ConfigRepoMutationOptions,
            ) => {
                await configRepoPatternRemoveAction(
                    repository ?? '.',
                    field,
                    pattern,
                    actionOptions,
                );
            },
        );
}

export function registerRemoteRepositoryConfig(command: Command): void {
    registerRepositoryConfigCommand(command, {
        description: REPOSITORY_CONFIG_DESCRIPTION,
        handlers: {
            action: configRemoteAction,
            addAction: configRemoteAddAction,
        },
    });
}

export function registerRepoAliasConfig(command: Command): void {
    registerRepositoryConfigCommand(command, {
        description: REPOSITORY_CONFIG_DESCRIPTION,
        handlers: {
            action: configRepoAction,
            addAction: configRepoAddAction,
        },
    });
}
