import { Command } from 'commander';
import {
    configRemoteAction,
    type ConfigRepoAddOptions,
} from '../features/repo-config/actions.js';
import {
    registerRemoteRepositoryConfig,
    registerRepoAliasConfig,
} from '../features/repo-config/command.js';
import { registerCentralizedConfigCommand } from '../features/centralized-config/command.js';

export {
    configCentralizedDisableAction,
    configCentralizedDownloadAction,
    configCentralizedInitAction,
    configCentralizedStatusAction,
    configCentralizedSyncAction,
} from '../features/centralized-config/actions.js';

export {
    configRemoteAction,
    configRemoteAddAction,
    configRepoAction,
    configRepoAddAction,
    configRepoListAction,
    configRepoShowAction,
    configRepoSetupAction,
    configRepoOpenAction,
    configRepoSetAction,
    configRepoPatternAddAction,
    configRepoPatternRemoveAction,
} from '../features/repo-config/actions.js';

export const configCommand = new Command('config').description(
    'Configuration commands',
);

configCommand
    .option(
        '-r, --remote [repository]',
        "Add a repository to Kodus. Shortcut for: kodus config remote add [repository]. Use '.' for the current repo.",
    )
    .option('--no-prompt', 'Skip the post-add setup prompt')
    .action(async (options, command) => {
        if (options.remote !== undefined) {
            const repository =
                typeof options.remote === 'string' ? options.remote : '.';
            await configRemoteAction(repository, {
                prompt: (options as ConfigRepoAddOptions).prompt,
            });
            return;
        }

        command.help();
    });

registerRemoteRepositoryConfig(configCommand.command('remote'));
registerCentralizedConfigCommand(configCommand.command('centralized'));

const repoAliasCommand = configCommand.command('repo');
(repoAliasCommand as Command & { _hidden?: boolean })._hidden = true;
registerRepoAliasConfig(repoAliasCommand);
