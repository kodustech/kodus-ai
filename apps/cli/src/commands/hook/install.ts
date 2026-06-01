import chalk from 'chalk';
import fs from 'fs/promises';
import path from 'path';
import { confirm } from '@inquirer/prompts';
import { gitService } from '../../services/git.service.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import type { GlobalOptions } from '../../types/cli.js';
import { createCommandContext } from '../../utils/command-context.js';
import {
    buildAgentErrorEnvelope,
    buildAgentSuccessEnvelope,
    emitAgentEnvelope,
} from '../../utils/command-output.js';
import {
    CommandError,
    normalizeCommandError,
} from '../../utils/command-errors.js';

const KODUS_MARKER = '# kodus-hook';

function generateHookScript(failOn: string, fast: boolean): string {
    const flags: string[] = [];
    if (fast) {
        flags.push('--fast');
    }
    flags.push('--fail-on', failOn);
    flags.push('--format', 'terminal');
    flags.push('--quiet');

    const reviewFlags = flags.join(' ');

    return `#!/bin/sh
${KODUS_MARKER} — installed by kodus CLI
# To uninstall: kodus hook uninstall

# Skip hook if KODUS_SKIP_HOOK is set
if [ -n "$KODUS_SKIP_HOOK" ]; then
  exit 0
fi

# Check if kodus is available
if ! command -v kodus >/dev/null 2>&1; then
  echo "Warning: kodus CLI not found. Skipping pre-push review."
  echo "Install: yarn global add @kodus/cli"
  exit 0
fi

remote="$1"
current_branch="$(git symbolic-ref --short HEAD 2>/dev/null)"

while read local_ref local_sha remote_ref remote_sha; do
  # Skip branch deletions
  if [ "$local_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # New branch — no remote state to compare, skip review
  if [ "$remote_sha" = "0000000000000000000000000000000000000000" ]; then
    continue
  fi

  # Extract branch name from ref (refs/heads/my-branch → my-branch)
  branch_name="\${local_ref#refs/heads/}"

  # Only review if pushing the currently checked-out branch
  # (--branch compares against HEAD, so reviewing other refs would produce wrong diffs)
  if [ "$branch_name" != "$current_branch" ]; then
    continue
  fi

  # Review changes not yet on the remote
  if ! kodus review --branch "\${remote}/\${branch_name}" ${reviewFlags}; then
    exit 1
  fi
done
`;
}

export async function installAction(
    options: {
        failOn?: string;
        fast?: boolean;
        force?: boolean;
        dryRun?: boolean;
    },
    globalOpts?: GlobalOptions,
): Promise<void> {
    const ctx = createCommandContext('hook install', {
        format: globalOpts?.format ?? 'terminal',
        output: globalOpts?.output,
        verbose: globalOpts?.verbose ?? false,
        quiet: globalOpts?.quiet ?? false,
        agent: globalOpts?.agent ?? false,
    });
    const failOn = options.failOn ?? 'critical';
    const fast = options.fast !== false; // default true

    try {
        const isRepo = await gitService.isGitRepository();
        if (!isRepo) {
            throw new CommandError('NOT_IN_GIT_REPO', 'Not a git repository.');
        }

        const gitRoot = await gitService.getGitRoot();
        const hooksDir = path.join(gitRoot.trim(), '.git', 'hooks');
        const hookPath = path.join(hooksDir, 'pre-push');

        // Check if hook already exists
        let existingContent: string | null = null;
        try {
            existingContent = await fs.readFile(hookPath, 'utf-8');
        } catch {
            // File doesn't exist
        }

        const isKodusHook = existingContent
            ? existingContent.includes(KODUS_MARKER)
            : false;

        if (options.dryRun) {
            const payload = {
                action: 'hook install',
                path: hookPath,
                failOn,
                fast,
                hasExistingHook: !!existingContent,
                wouldPromptForOverwrite:
                    !!existingContent && !isKodusHook && !options.force,
            };

            if (ctx.isAgent) {
                await emitAgentEnvelope(
                    buildAgentSuccessEnvelope(
                        ctx.command,
                        payload,
                        ctx.startedAt,
                    ),
                    ctx.outputFile,
                );
                return;
            }

            cliInfo(chalk.cyan('Dry run: no changes were made.'));
            cliInfo(JSON.stringify(payload, null, 2));
            return;
        }

        if (existingContent) {
            if (!isKodusHook && !options.force) {
                const overwrite = await confirm({
                    message: 'A pre-push hook already exists. Overwrite it?',
                    default: false,
                });

                if (!overwrite) {
                    cliInfo(chalk.yellow('Installation cancelled.'));
                    return;
                }
            }
        }

        // Ensure hooks directory exists
        await fs.mkdir(hooksDir, { recursive: true });

        // Write hook script
        const script = generateHookScript(failOn, fast);
        await fs.writeFile(hookPath, script, { mode: 0o755 });

        cliInfo(chalk.green('✓ Pre-push hook installed successfully!'));
        cliInfo(chalk.dim(`  Path: ${hookPath}`));
        cliInfo(chalk.dim(`  Fail on: ${failOn}`));
        cliInfo(chalk.dim(`  Fast mode: ${fast ? 'yes' : 'no'}`));
        cliInfo('');
        cliInfo(chalk.dim('Skip with: KODUS_SKIP_HOOK=1 git push'));
        cliInfo(chalk.dim('Remove with: kodus hook uninstall'));
    } catch (error) {
        const normalized = normalizeCommandError(error);
        if (ctx.isAgent) {
            await emitAgentEnvelope(
                buildAgentErrorEnvelope(ctx.command, normalized, ctx.startedAt),
                ctx.outputFile,
            );
            exitWithCode(normalized.exitCode);
        }

        cliError(chalk.red(`Error: ${normalized.message}`));
        exitWithCode(normalized.exitCode);
    }
}

export { KODUS_MARKER, generateHookScript };
