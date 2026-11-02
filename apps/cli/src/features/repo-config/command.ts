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
import {
    reviewModelListAction,
    reviewModelSetAction,
    reviewModelTestAction,
    reviewSettingsKeysAction,
    reviewSettingsUnsetAction,
    type ReviewModelSetOptions,
    type ReviewSettingsTargetOptions,
} from './review-settings-actions.js';
import {
    languageListAction,
    languageSetAction,
    languageShowAction,
    messagesFieldsAction,
    messagesSetAction,
    messagesShowAction,
    messagesUnsetAction,
    skillsAddAction,
    skillsDiscoverAction,
    skillsLinkAction,
    skillsListAction,
    skillsRemoveAction,
    type MessagesSetOptions,
    type SkillsAddOptions,
    type SkillsListOptions,
} from './review-extras-actions.js';

const REPOSITORY_ARGUMENT_HELP =
    "Use '.' for the current repo, owner/repo, a repository id, or 'global'.";

function withScopeOptions(command: Command): Command {
    return command
        .option(
            '--team <team>',
            'Team name or id (needed when your organization has more than one)',
        )
        .option(
            '--directory <path>',
            'Directory inside the repository whose own settings to use',
        );
}

export const REPOSITORY_CONFIG_DESCRIPTION =
    "Inspect and update code review settings in Kodus: global, per repository and per directory. show, set, unset and model reach every setting when logged in (kodus auth login); with a team key they cover the six legacy repository settings, and add, list, setup and open use a team key. Use 'kodus config -r [repository]' as a shortcut for 'kodus config remote add [repository]'.";

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
        .description(
            "List the team's repositories configured in Kodus (logged in, or the team key's team).",
        )
        .option(
            '--team <team>',
            'Team name or id (logged in, when your organization has more than one)',
        )
        .option('--json', 'Output configured repositories as JSON')
        .action(async (actionOptions: ConfigRepoListOptions) => {
            await configRepoListAction(actionOptions);
        });

    withScopeOptions(
        command
            .command('show [repository]')
            .description(
                `Show code review settings with the level each value comes from. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option(
            '--no-file-overlay',
            'Skip reading kodus-config.yml from the git provider (faster; shows stored settings only)',
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

    withScopeOptions(
        command
            .command('set [repository] <key> <value>')
            .description(
                `Set one code review setting at a scope. Run 'kodus config remote keys' for keys and values. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option(
            '--create-directory',
            'Give --directory its own settings if it has none yet',
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

    withScopeOptions(
        command.command('add-pattern [repository] <field> <pattern>'),
    )
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

    withScopeOptions(command.command('add-ignore-file [repository] <pattern>'))
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

    withScopeOptions(
        command.command('remove-ignore-file [repository] <pattern>'),
    )
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

    withScopeOptions(command.command('add-base-branch [repository] <pattern>'))
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

    withScopeOptions(
        command.command('remove-base-branch [repository] <pattern>'),
    )
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

    withScopeOptions(command.command('add-ignore-title [repository] <pattern>'))
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

    withScopeOptions(
        command.command('remove-ignore-title [repository] <pattern>'),
    )
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

    withScopeOptions(
        command.command('remove-pattern [repository] <field> <pattern>'),
    )
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

    withScopeOptions(
        command
            .command('unset [repository] <key>')
            .description(
                `Drop a scope's own value so the setting inherits again. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                repository: string | undefined,
                key: string,
                actionOptions: ReviewSettingsTargetOptions,
            ) => {
                await reviewSettingsUnsetAction(
                    repository ?? '.',
                    key,
                    actionOptions,
                );
            },
        );

    command
        .command('keys')
        .description(
            'List the settable code review keys with their type, allowed values and page.',
        )
        .option('--json', 'Output the keys as JSON')
        .action(async (actionOptions: { json?: boolean }) => {
            await reviewSettingsKeysAction(actionOptions);
        });

    const model = command
        .command('model')
        .description(
            'Choose the model code review runs on, among the BYOK models your organization configured.',
        );

    model
        .command('list')
        .description('List the BYOK models configured for your organization.')
        .option('--json', 'Output the models as JSON')
        .action(async (actionOptions: { json?: boolean }) => {
            await reviewModelListAction(actionOptions);
        });

    withScopeOptions(
        model
            .command('set [repository] <modelId>')
            .description(
                `Run reviews at a scope on one of the configured models. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option('--force', 'Save a model id that is not in the configured list')
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                repository: string | undefined,
                modelId: string,
                actionOptions: ReviewModelSetOptions,
            ) => {
                await reviewModelSetAction(
                    repository ?? '.',
                    modelId,
                    actionOptions,
                );
            },
        );

    withScopeOptions(
        model
            .command('unset [repository]')
            .description(
                `Drop a scope's model so it inherits the parent's. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ReviewSettingsTargetOptions,
            ) => {
                await reviewModelSetAction(
                    repository ?? '.',
                    '',
                    actionOptions,
                );
            },
        );

    model
        .command('test <modelId>')
        .description(
            "Check a model id against your organization's saved BYOK provider.",
        )
        .option('--json', 'Output the test result as JSON')
        .action(async (modelId: string, actionOptions: { json?: boolean }) => {
            await reviewModelTestAction(modelId, actionOptions);
        });

    registerReviewExtrasCommands(command);
}

function collect(value: string, previous: string[] = []): string[] {
    return [...previous, value];
}

/** Custom Messages, the review language and Skills & docs: the Code Review pages outside CODE_REVIEW_CONFIG's plain keys. */
function registerReviewExtrasCommands(command: Command): void {
    const messages = command
        .command('messages')
        .description(
            'Custom messages Kody posts when a review starts, ends or fails, and comment visibility (logged in).',
        );

    withScopeOptions(
        messages
            .command('show [repository]')
            .description(
                `Show the custom messages with the level each value comes from. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option('--json', 'Output the messages as JSON')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ReviewSettingsTargetOptions,
            ) => {
                await messagesShowAction(repository ?? '.', actionOptions);
            },
        );

    withScopeOptions(
        messages
            .command('set <repository> <field> [value]')
            .description(
                `Set one message field at a scope. Fields: start.content, start.status, end.content, end.status, error.content, hideComments, suggestionCopyPrompt. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option(
            '--from-file <path>',
            'Read the value from a file (long messages)',
        )
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                repository: string,
                field: string,
                value: string | undefined,
                actionOptions: MessagesSetOptions,
            ) => {
                await messagesSetAction(
                    repository,
                    field,
                    value,
                    actionOptions,
                );
            },
        );

    withScopeOptions(
        messages
            .command('unset <repository> <field>')
            .description(
                `Drop a scope's override of one message field so it inherits again. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                repository: string,
                field: string,
                actionOptions: ReviewSettingsTargetOptions,
            ) => {
                await messagesUnsetAction(repository, field, actionOptions);
            },
        );

    messages
        .command('fields')
        .description('List the message fields set and unset take.')
        .option('--json', 'Output the fields as JSON')
        .action(async (actionOptions: { json?: boolean }) => {
            await messagesFieldsAction(actionOptions);
        });

    const language = command
        .command('language')
        .description(
            'The language Kody writes reviews in. It is a team setting: it covers every repository of the team (logged in).',
        );

    language
        .command('show')
        .description("Show the team's review language.")
        .option(
            '--team <team>',
            'Team name or id (needed when your organization has more than one)',
        )
        .option('--json', 'Output the language as JSON')
        .action(async (actionOptions: { team?: string; json?: boolean }) => {
            await languageShowAction(actionOptions);
        });

    language
        .command('set <language>')
        .description(
            "Set the team's review language by code (pt-BR) or name (Portuguese (Brazil)).",
        )
        .option(
            '--team <team>',
            'Team name or id (needed when your organization has more than one)',
        )
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                value: string,
                actionOptions: { team?: string; json?: boolean },
            ) => {
                await languageSetAction(value, actionOptions);
            },
        );

    language
        .command('list')
        .description('List the languages a review can be written in.')
        .option('--json', 'Output the languages as JSON')
        .action(async (actionOptions: { json?: boolean }) => {
            await languageListAction(actionOptions);
        });

    const skills = command
        .command('skills')
        .description(
            'Skills & docs: repository guides (skill folders with a SKILL.md, Markdown docs) the main review and custom agents follow (logged in).',
        );

    withScopeOptions(
        skills
            .command('list [repository]')
            .description(
                `List the skills and docs added at a scope and who follows each. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option(
            '--no-check',
            "Skip reading each item on the repository's default branch",
        )
        .option('--json', 'Output the list as JSON')
        .action(
            async (
                repository: string | undefined,
                actionOptions: SkillsListOptions,
            ) => {
                await skillsListAction(repository ?? '.', actionOptions);
            },
        );

    withScopeOptions(
        skills
            .command('discover [repository]')
            .description(
                "List skills and docs found on the repository's default branch that are not added yet. Use '.' for the current repo, owner/repo or a repository id.",
            ),
    )
        .option('--json', 'Output the candidates as JSON')
        .action(
            async (
                repository: string | undefined,
                actionOptions: ReviewSettingsTargetOptions,
            ) => {
                await skillsDiscoverAction(repository ?? '.', actionOptions);
            },
        );

    withScopeOptions(
        skills
            .command('add <repository> <paths...>')
            .description(
                `Add skills or docs by path (docs/payments.md, .claude/skills/ledger). ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option(
            '--kind <kind>',
            'skill or doc (inferred from the path when omitted)',
        )
        .option(
            '--link <target>',
            "Who follows the new items: 'main-review' or an agent (repeatable)",
            collect,
        )
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                repository: string,
                paths: string[],
                actionOptions: SkillsAddOptions,
            ) => {
                await skillsAddAction(repository, paths, actionOptions);
            },
        );

    withScopeOptions(
        skills
            .command('remove <repository> <paths...>')
            .description(
                `Remove skills or docs from a scope. ${REPOSITORY_ARGUMENT_HELP}`,
            ),
    )
        .option('--json', 'Output the result as JSON')
        .action(
            async (
                repository: string,
                paths: string[],
                actionOptions: ReviewSettingsTargetOptions,
            ) => {
                await skillsRemoveAction(repository, paths, actionOptions);
            },
        );

    for (const [name, linked] of [
        ['link', true],
        ['unlink', false],
    ] as const) {
        withScopeOptions(
            skills
                .command(`${name} <repository> <path> <targets...>`)
                .description(
                    `${linked ? 'Make' : 'Stop'} the main review ('main-review') or agents ${linked ? 'follow' : 'following'} one skill or doc. ${REPOSITORY_ARGUMENT_HELP}`,
                ),
        )
            .option('--json', 'Output the result as JSON')
            .action(
                async (
                    repository: string,
                    path: string,
                    targets: string[],
                    actionOptions: ReviewSettingsTargetOptions,
                ) => {
                    await skillsLinkAction(
                        repository,
                        path,
                        targets,
                        linked,
                        actionOptions,
                    );
                },
            );
    }
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
