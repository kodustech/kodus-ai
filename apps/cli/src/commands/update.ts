import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import latestVersion from 'latest-version';
import { createRequire } from 'node:module';
import { execa } from 'execa';
import { cliError, cliInfo } from '../utils/logger.js';
import { resolveRemoteInstallInstructions } from '../utils/install-instructions.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
const PACKAGE_NAME = '@kodus/cli';
const remoteInstall = resolveRemoteInstallInstructions();
const SKILLS_REFRESH_HINT = chalk.dim(
    `\nTo refresh agent skills and integrations, run: ${remoteInstall.primary}\n`,
);
const SKILLS_CLI_FALLBACK = chalk.dim(
    'CLI fallback for common local agent roots: kodus skills install | kodus skills resync\n',
);
const SKILLS_REFRESH_FALLBACK = remoteInstall.fallback
    ? chalk.dim(`Installer fallback: ${remoteInstall.fallback}\n`)
    : null;

export interface InstallInstruction {
    command: string;
    args: string[];
}

export function resolveGlobalInstallInstruction(
    userAgent: string | undefined,
): InstallInstruction {
    if (!userAgent) {
        return {
            command: 'npm',
            args: ['install', '-g', `${PACKAGE_NAME}@latest`],
        };
    }

    if (userAgent.startsWith('pnpm/')) {
        return {
            command: 'pnpm',
            args: ['add', '-g', `${PACKAGE_NAME}@latest`],
        };
    }

    if (userAgent.startsWith('yarn/1.')) {
        return {
            command: 'yarn',
            args: ['global', 'add', `${PACKAGE_NAME}@latest`],
        };
    }

    if (userAgent.startsWith('bun/')) {
        return {
            command: 'bun',
            args: ['add', '-g', `${PACKAGE_NAME}@latest`],
        };
    }

    return {
        command: 'npm',
        args: ['install', '-g', `${PACKAGE_NAME}@latest`],
    };
}

export function formatInstallInstruction(
    instruction: InstallInstruction,
): string {
    return [instruction.command, ...instruction.args].join(' ');
}

function isPackageRegistryLookupFailure(message: string): boolean {
    const normalizedMessage = message.toLowerCase();
    return (
        normalizedMessage.includes('could not be found') ||
        normalizedMessage.includes('not found') ||
        normalizedMessage.includes('e404')
    );
}

export function getUpdateFailureHints(
    errorMessage: string,
    installInstruction: InstallInstruction,
    registry = process.env.npm_config_registry,
): string[] {
    const hints = [
        `Try running manually: ${formatInstallInstruction(installInstruction)}`,
    ];

    if (!isPackageRegistryLookupFailure(errorMessage)) {
        return hints;
    }

    hints.push('Check your npm registry with: npm config get registry');
    if (registry && registry !== 'https://registry.npmjs.org/') {
        hints.push(`Current registry: ${registry}`);
    }
    hints.push(
        `Retry with npmjs registry: npm install -g ${PACKAGE_NAME}@latest --registry https://registry.npmjs.org/`,
    );
    hints.push(`Installer fallback: ${remoteInstall.primary}`);

    return hints;
}

export const updateCommand = new Command('update')
    .description('Update the Kodus CLI to the latest version')
    .action(async () => {
        const spinner = ora('Checking for updates...').start();

        try {
            const current = pkg.version;
            const latest = await latestVersion('@kodus/cli');

            if (current === latest) {
                spinner.succeed(
                    chalk.green(
                        `You are already on the latest version (${current})`,
                    ),
                );
                cliInfo(SKILLS_REFRESH_HINT);
                if (SKILLS_REFRESH_FALLBACK) {
                    cliInfo(SKILLS_REFRESH_FALLBACK);
                }
                cliInfo(SKILLS_CLI_FALLBACK);
                return;
            }

            spinner.stop();
            cliInfo(
                chalk.yellow(
                    `\nUpdate available: ${chalk.dim(current)} → ${chalk.green(latest)}`,
                ),
            );

            const installSpinner = ora('Installing update...').start();
            const installInstruction = resolveGlobalInstallInstruction(
                process.env.npm_config_user_agent,
            );

            await execa(installInstruction.command, installInstruction.args);

            installSpinner.succeed(
                chalk.green(`Successfully updated to version ${latest}!`),
            );
            cliInfo(
                chalk.dim(
                    '\nYou may need to restart your terminal for changes to take effect.\n',
                ),
            );
            cliInfo(SKILLS_REFRESH_HINT);
            if (SKILLS_REFRESH_FALLBACK) {
                cliInfo(SKILLS_REFRESH_FALLBACK);
            }
            cliInfo(SKILLS_CLI_FALLBACK);
        } catch (error) {
            spinner.fail(chalk.red('Update failed'));

            if (error instanceof Error) {
                cliError(chalk.red(`Error: ${error.message}`));
                const installInstruction = resolveGlobalInstallInstruction(
                    process.env.npm_config_user_agent,
                );
                for (const hint of getUpdateFailureHints(
                    error.message,
                    installInstruction,
                )) {
                    cliInfo(chalk.yellow(`\n${hint}`));
                }
            }
        }
    });
