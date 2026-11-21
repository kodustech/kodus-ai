import chalk from 'chalk';
import { Command } from 'commander';
import { envService } from '../services/env.service.js';
import type { EnvFixResult, EnvStatus } from '../types/env.js';
import { exitWithCode } from '../utils/cli-exit.js';
import {
    CommandError,
    normalizeCommandError,
} from '../utils/command-errors.js';
import { cliError, cliInfo } from '../utils/logger.js';

export type EnvTargetOptions = {
    env?: string;
    repoId?: string;
    json?: boolean;
};

export type EnvFixOptions = EnvTargetOptions & { fix?: string };

const targetOf = (options: EnvTargetOptions) => ({
    environmentId: options.env,
    repositoryId: options.repoId,
});

/** The human view of env_blockers: state, then each blocker with its evidence and fixes. */
export function formatEnvStatus(status: EnvStatus): string[] {
    const { environment, blockers } = status;
    const lines = [
        `Environment ${environment.environmentId} (${environment.repositoryName}): ${environment.state}`,
    ];
    if (blockers.length === 0) {
        lines.push(chalk.green('No blockers.'));
        return lines;
    }
    lines.push(
        `${blockers.length} ${blockers.length === 1 ? 'blocker' : 'blockers'}:`,
    );
    blockers.forEach((b, i) => {
        const seen = [
            `seen ${b.count}x`,
            b.lastPr !== undefined ? `last on PR #${b.lastPr}` : undefined,
        ]
            .filter(Boolean)
            .join(', ');
        lines.push('');
        lines.push(`${i + 1}. ${b.title} (${seen})`);
        lines.push(`   signature: ${b.signature}`);
        for (const line of b.evidence?.lines?.slice(0, 3) ?? []) {
            lines.push(chalk.dim(`   | ${line}`));
        }
        b.fixes.forEach((f, j) => {
            const tags = [
                j === 0 ? 'recommended' : undefined,
                f.learned ? `worked before (${f.learned.scope})` : undefined,
                f.recipeDiff ? 'opens a PR' : undefined,
                f.action === 'approve_host' ? 'admin only' : undefined,
                f.who === 'dev' && !f.recipeDiff ? 'by hand' : undefined,
            ].filter(Boolean);
            lines.push(
                `   - ${f.id}: ${f.label}${tags.length ? ` [${tags.join(', ')}]` : ''}`,
            );
            if (f.detail) lines.push(chalk.dim(`     ${f.detail}`));
        });
    });
    lines.push('');
    lines.push('Apply one: kodus env fix <signature> --fix <fix-id>');
    return lines;
}

export function formatEnvFix(result: EnvFixResult, fixId: string): string {
    if (result.action === 'retry_setup') {
        return `Applied ${fixId}: a new setup was requested. Check it with kodus env status.`;
    }
    return `Applied ${fixId}: opened pull request #${result.pullRequest.number} with the recipe change: ${result.pullRequest.url}`;
}

export async function envStatusAction(
    options: EnvTargetOptions,
): Promise<void> {
    try {
        const status = await envService.status(targetOf(options));
        if (options.json) {
            cliInfo(JSON.stringify(status, null, 2));
            return;
        }
        for (const line of formatEnvStatus(status)) cliInfo(line);
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function envFixAction(
    signature: string | undefined,
    options: EnvFixOptions,
): Promise<void> {
    try {
        const target = targetOf(options);
        const status = await envService.status(target);
        const blocker = envService.pickBlocker(status, signature);
        // Without --fix, the catalog's recommended fix (the first one).
        const fixId = options.fix ?? blocker.fixes[0]?.id;
        if (!fixId) {
            throw new CommandError(
                'INVALID_INPUT',
                `No fix is offered for ${blocker.signature}.`,
            );
        }
        const result = await envService.fix({
            environmentId: status.environment.environmentId,
            signature: blocker.signature,
            fixId,
        });
        if (options.json) {
            cliInfo(JSON.stringify(result, null, 2));
            return;
        }
        cliInfo(chalk.green(formatEnvFix(result, fixId)));
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export const envCommand = new Command('env')
    .description(
        'Kody Runtime environments: why one does not boot, and apply a fix',
    )
    .showHelpAfterError();

envCommand
    .command('status')
    .description('Show the environment state, its blockers and their fixes')
    .option('--env <id>', 'Environment ID (optional when the key reaches one)')
    .option('--repo-id <id>', 'Repository ID whose environment to show')
    .option('--json', 'Output as JSON')
    .action(envStatusAction);

envCommand
    .command('fix')
    .description(
        "Apply a fix to a blocker (the recommended one unless --fix): a recipe fix opens a PR, 'set up again' asks for a new setup",
    )
    .argument('[signature]', 'Blocker signature (optional when there is one)')
    .option('--fix <id>', 'Fix ID from kodus env status')
    .option('--env <id>', 'Environment ID (optional when the key reaches one)')
    .option('--repo-id <id>', 'Repository ID whose environment to fix')
    .option('--json', 'Output as JSON')
    .action(envFixAction);
