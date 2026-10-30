import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import { recallDecisions } from '../../services/trace/recall.service.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import type { GlobalOptions } from '../../types/cli.js';
import type { TraceRecalledDecision } from '../../types/trace.js';

export interface RecallActionOptions {
    /** Repeated `--path` values, produced by the `--` disambiguation. */
    path?: string[];
    limit?: string;
    remote?: string;
}

/**
 * `kodus trace <paths>` — the common case, which is why it needs no verb.
 *
 * Reads the local store and the shared decision branch. No network access, no
 * embeddings, no similarity search: given paths, it returns the decisions whose
 * scope matches them by exact or prefix comparison.
 */
export async function recallAction(
    positionalPaths: string[] = [],
    options: RecallActionOptions = {},
    globalOpts?: GlobalOptions,
): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
        return;
    }

    const gitRoot = (await gitService.getGitRoot()).trim();
    const paths = [...positionalPaths, ...(options.path ?? [])];
    const limit = options.limit
        ? Number.parseInt(options.limit, 10)
        : undefined;

    const result = await recallDecisions(gitRoot, {
        paths,
        remote: options.remote,
        limit: Number.isFinite(limit) ? limit : undefined,
    });

    if (globalOpts?.format === 'json' || globalOpts?.agent) {
        cliInfo(
            JSON.stringify(
                {
                    paths: result.queriedPaths,
                    decisions: result.decisions,
                },
                null,
                2,
            ),
        );
        return;
    }

    if (result.decisions.length === 0) {
        cliInfo(
            paths.length > 0
                ? chalk.dim(
                      `No decisions recorded for: ${result.queriedPaths.join(', ')}`,
                  )
                : chalk.dim('No decisions recorded for this repository yet.'),
        );
        return;
    }

    cliInfo(
        chalk.bold(
            paths.length > 0
                ? `Decisions for ${result.queriedPaths.join(', ')} (${result.decisions.length})`
                : `Decisions for this repository (${result.decisions.length})`,
        ),
    );

    for (const decision of result.decisions) {
        cliInfo('');
        cliInfo(renderDecision(decision));
    }
}

function renderDecision(decision: TraceRecalledDecision): string {
    const lines: string[] = [];
    const badges = [
        decision.pinned ? chalk.yellow('pinned') : null,
        chalk.cyan(decision.type),
        decision.origin ? chalk.dim(decision.origin) : null,
        typeof decision.confidence === 'number'
            ? chalk.dim(`confidence ${decision.confidence.toFixed(2)}`)
            : null,
        chalk.dim(decision.source),
    ].filter(Boolean);

    lines.push(`${chalk.bold(decision.decision)}`);
    lines.push(`  ${badges.join(chalk.dim(' · '))}  ${chalk.dim(decision.id)}`);

    if (decision.rationale) {
        lines.push(`  ${chalk.dim('why:')} ${decision.rationale}`);
    }
    if (decision.scope.length > 0) {
        lines.push(`  ${chalk.dim('scope:')} ${decision.scope.join(', ')}`);
    }
    if (decision.branch) {
        lines.push(`  ${chalk.dim('branch:')} ${decision.branch}`);
    }

    return lines.join('\n');
}
