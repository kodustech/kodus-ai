import chalk from 'chalk';
import { Command } from 'commander';
import { collectRecipe } from '../features/env-recipe/recipe-files.js';
import { envService } from '../services/env.service.js';
import type {
    EnvFixResult,
    EnvHealth,
    EnvRecipeCheck,
    EnvStatus,
    EnvTarget,
} from '../types/env.js';
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
            if (f.detail) {
                lines.push(chalk.dim(`     ${f.detail}`));
            }
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
        for (const line of formatEnvStatus(status)) {
            cliInfo(line);
        }
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
        'Kody Runtime environments: send the setup file your coding agent wrote, see why one does not boot, and apply a fix',
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

export type EnvRecipeOptions = EnvTargetOptions & {
    file?: string;
    wait?: boolean;
    timeout?: string;
};

/** The human view of env_recipe_check. */
export function formatRecipeCheck(
    check: EnvRecipeCheck,
    recipePath: string,
    files: number,
): string[] {
    const where = `${recipePath}${files ? ` and ${files} build file${files === 1 ? '' : 's'} under .kodus/` : ''}`;
    if (!check.ok) {
        return [
            chalk.red(
                `Kodus would refuse ${where} for ${check.environment.repositoryName}:`,
            ),
            ...check.errors.map((e) => `  - ${e}`),
        ];
    }
    const s = check.summary;
    const exposed = s?.expose
        .map((e) => `${e.service}:${e.port} (${e.kind})`)
        .join(', ');
    return [
        chalk.green(
            `${where} passes Kodus's checks for ${check.environment.repositoryName}.`,
        ),
        ...(s?.public
            ? [
                  `  public service: ${s.public}${s.health ? `, health ${s.health}` : ''}`,
              ]
            : []),
        ...(exposed ? [`  exposed: ${exposed}`] : []),
        'Send it to boot on a clean machine: kodus env recipe submit --wait',
    ];
}

export const POLL_INTERVAL_MS = 15_000;

export type RecipeWaitOutcome =
    | { outcome: 'active'; health: EnvHealth }
    | { outcome: 'blocked'; health: EnvHealth; status: EnvStatus }
    | { outcome: 'timeout'; health?: EnvHealth };

/**
 * Polls env_status until the setup that boots the submitted recipe (its setupKey) is the environment's latest and
 * has ended: another setup's state (the one before, or one a push started) is never taken for this one's.
 */
export async function waitForSetup(
    target: EnvTarget,
    setupKey: string,
    timeoutMs: number,
    deps: {
        sleep?: (ms: number) => Promise<void>;
        now?: () => number;
        intervalMs?: number;
        onPoll?: (h: EnvHealth) => void;
    } = {},
): Promise<RecipeWaitOutcome> {
    const sleep =
        deps.sleep ??
        ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;
    const interval = deps.intervalMs ?? POLL_INTERVAL_MS;
    const deadline = now() + timeoutMs;
    let last: EnvHealth | undefined;
    for (;;) {
        last = await envService.health(target);
        deps.onPoll?.(last);
        if (last.setupKey === setupKey && last.state === 'active') {
            return { outcome: 'active', health: last };
        }
        if (last.setupKey === setupKey && last.state === 'blocked') {
            return {
                outcome: 'blocked',
                health: last,
                status: await envService.status(target),
            };
        }
        if (now() + interval > deadline) {
            return { outcome: 'timeout', health: last };
        }
        await sleep(interval);
    }
}

export async function envRecipeCheckAction(
    options: EnvRecipeOptions,
): Promise<void> {
    try {
        const collected = await collectRecipe(process.cwd(), options.file);
        const check = await envService.checkRecipe({
            ...targetOf(options),
            recipe: collected.recipe,
            files: collected.files,
        });
        if (options.json) {
            cliInfo(JSON.stringify(check, null, 2));
        } else {
            for (const line of formatRecipeCheck(
                check,
                collected.recipePath,
                collected.files.length,
            )) {
                cliInfo(line);
            }
        }
        if (!check.ok) {
            exitWithCode(1);
        }
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

export async function envRecipeSubmitAction(
    options: EnvRecipeOptions,
): Promise<void> {
    try {
        const minutes =
            options.timeout === undefined ? 30 : Number(options.timeout);
        if (!Number.isFinite(minutes) || minutes <= 0) {
            throw new CommandError(
                'INVALID_INPUT',
                '--timeout takes the minutes to wait, e.g. --timeout 30',
            );
        }
        const collected = await collectRecipe(process.cwd(), options.file);
        const sent = await envService.submitRecipe({
            ...targetOf(options),
            recipe: collected.recipe,
            files: collected.files,
        });
        if (!options.wait) {
            if (options.json) {
                cliInfo(JSON.stringify(sent, null, 2));
            } else {
                cliInfo(
                    chalk.green(
                        `Sent ${collected.recipePath} (${sent.recipeDigest.slice(0, 19)}): Kodus is setting the environment up from it. Follow it with kodus env status, or send it with --wait.`,
                    ),
                );
            }
            return;
        }
        if (!options.json) {
            cliInfo(
                `Sent ${collected.recipePath}; waiting for the setup to boot it from zero (up to ${minutes} min)...`,
            );
        }
        const target = { environmentId: sent.environmentId };
        const out = await waitForSetup(target, sent.setupKey, minutes * 60_000);
        if (options.json) {
            cliInfo(JSON.stringify({ ...sent, ...out }, null, 2));
        } else if (out.outcome === 'active') {
            cliInfo(
                chalk.green(
                    'It booted: the environment is active. Commit .kodus/ in a pull request; a committed recipe always wins over a sent one.',
                ),
            );
        } else if (out.outcome === 'blocked') {
            cliInfo(
                chalk.red(
                    'It did not boot. Fix the recipe or the .kodus/ files from what the blockers say, then send it again.',
                ),
            );
            for (const line of formatEnvStatus(out.status)) {
                cliInfo(line);
            }
        } else {
            cliInfo(
                chalk.yellow(
                    `The setup did not end in ${minutes} min. Follow it with kodus env status.`,
                ),
            );
        }
        if (out.outcome !== 'active') {
            exitWithCode(1);
        }
    } catch (error) {
        const normalized = normalizeCommandError(error);
        cliError(chalk.red(normalized.message));
        exitWithCode(normalized.exitCode);
    }
}

const recipeCommand = envCommand
    .command('recipe')
    .description(
        'The setup file your own coding agent writes (.kodus/workspace.yaml): check it, then send it so Kodus boots it on a clean machine',
    );

recipeCommand
    .command('check')
    .description(
        'Check the recipe and the build files under .kodus/ the way Kodus does before it boots one; keeps nothing',
    )
    .option(
        '--file <path>',
        'Recipe file (default: .kodus/workspace.runtime.yaml, then .kodus/workspace.yaml)',
    )
    .option('--env <id>', 'Environment ID (optional when the key reaches one)')
    .option('--repo-id <id>', 'Repository ID whose environment to use')
    .option('--json', 'Output as JSON')
    .action(envRecipeCheckAction);

recipeCommand
    .command('submit')
    .description(
        'Send the recipe and its .kodus/ build files: Kodus sets the environment up from it until a recipe is committed (needs env:fix)',
    )
    .option(
        '--file <path>',
        'Recipe file (default: .kodus/workspace.runtime.yaml, then .kodus/workspace.yaml)',
    )
    .option(
        '--wait',
        'Wait until the setup boots it, then print active or the blockers',
    )
    .option('--timeout <minutes>', 'With --wait: how long to wait', '30')
    .option('--env <id>', 'Environment ID (optional when the key reaches one)')
    .option('--repo-id <id>', 'Repository ID whose environment to use')
    .option('--json', 'Output as JSON')
    .action(envRecipeSubmitAction);
