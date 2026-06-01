import { Command } from 'commander';
import chalk from 'chalk';
import { listBundledSkills } from '../utils/skills.js';
import { cliInfo } from '../utils/logger.js';
import {
    buildDefaultSkillSyncTargets,
    type SkillSyncMode,
    syncSkillsToTargets,
} from '../utils/skills-sync.js';
import { resolveRemoteInstallInstructions } from '../utils/install-instructions.js';

async function listAction(): Promise<void> {
    const skills = await listBundledSkills();

    if (skills.length === 0) {
        cliInfo(chalk.yellow('No bundled skills found.'));
        return;
    }

    cliInfo(chalk.bold(`Available bundled skills (${skills.length})`));
    for (const skill of skills) {
        cliInfo(`- ${skill}`);
    }
}

function titleForMode(mode: SkillSyncMode, dryRun: boolean): string {
    if (mode === 'install') {
        return dryRun ? 'Skills install (dry run)' : 'Skills installed';
    }
    if (mode === 'uninstall') {
        return dryRun ? 'Skills uninstall (dry run)' : 'Skills uninstalled';
    }
    return dryRun ? 'Skills sync (dry run)' : 'Skills synchronized';
}

async function runSkillAction(
    mode: SkillSyncMode,
    options: { dryRun?: boolean },
): Promise<void> {
    const targets = buildDefaultSkillSyncTargets();
    const result = await syncSkillsToTargets(targets, {
        dryRun: !!options.dryRun,
        mode,
    });

    if (result.syncedTargets === 0) {
        cliInfo(
            chalk.yellow(
                'No compatible local agent directories were detected.',
            ),
        );
        const remoteInstall = resolveRemoteInstallInstructions();
        cliInfo(chalk.dim(`Run: ${remoteInstall.primary}`));
        if (remoteInstall.fallback) {
            cliInfo(chalk.dim(`Fallback: ${remoteInstall.fallback}`));
        }
        return;
    }

    cliInfo(chalk.bold(titleForMode(mode, !!options.dryRun)));
    for (const targetResult of result.results) {
        if (!targetResult.synced) {
            continue;
        }
        cliInfo(
            `- ${targetResult.target.label}: ` +
                `${targetResult.created} created, ` +
                `${targetResult.updated} updated, ` +
                `${targetResult.unchanged} unchanged, ` +
                `${targetResult.removedManaged} managed removed` +
                (targetResult.removedLegacy > 0
                    ? `, ${targetResult.removedLegacy} legacy removed`
                    : ''),
        );
    }

    cliInfo(
        chalk.dim(
            `Summary: ${result.createdFiles} created, ${result.updatedFiles} updated, ${result.unchangedFiles} unchanged, ${result.removedManagedEntries} managed removed, ${result.removedLegacyEntries} legacy removed.`,
        ),
    );
}

export const skillsCommand = new Command('skills')
    .description('Inspect bundled Kodus skills')
    .action(listAction);

skillsCommand
    .command('list')
    .description('List bundled skills available in this CLI package')
    .action(listAction);

skillsCommand
    .command('sync')
    .description('Sync bundled skills to detected local agent directories')
    .option('--dry-run', 'Show planned changes without writing files', false)
    .action((options) => runSkillAction('sync', options));

skillsCommand
    .command('resync')
    .description('Re-sync bundled skills to detected local agent directories')
    .option('--dry-run', 'Show planned changes without writing files', false)
    .action((options) => runSkillAction('sync', options));

skillsCommand
    .command('install')
    .description(
        'Install bundled skills into detected local agent roots (creates skill/command dir if needed)',
    )
    .option('--dry-run', 'Show planned changes without writing files', false)
    .action((options) => runSkillAction('install', options));

skillsCommand
    .command('uninstall')
    .description(
        'Uninstall bundled skills from detected local agent directories',
    )
    .option('--dry-run', 'Show planned changes without writing files', false)
    .action((options) => runSkillAction('uninstall', options));
