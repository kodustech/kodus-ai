import machineId from 'node-machine-id';
import crypto from 'crypto';
import os from 'os';
import chalk from 'chalk';
import { api } from '../services/api/index.js';
import { gitService } from '../services/git.service.js';
import type { TrialStatus } from '../types/trial.js';
import { cliInfo } from './logger.js';

const { machineIdSync } = machineId;

export async function getTrialIdentifier(): Promise<string> {
    try {
        const machineId = machineIdSync();
        const username = os.userInfo().username;

        let repoPath = '';
        try {
            repoPath = await gitService.getGitRoot();
        } catch {
            repoPath = process.cwd();
        }

        const raw = `${machineId}:${username}:${repoPath}`;
        return crypto
            .createHash('sha256')
            .update(raw)
            .digest('hex')
            .substring(0, 32);
    } catch {
        const fallback = `${os.hostname()}:${os.userInfo().username}:${Date.now()}`;
        return crypto
            .createHash('sha256')
            .update(fallback)
            .digest('hex')
            .substring(0, 32);
    }
}

export async function checkTrialStatus(): Promise<TrialStatus> {
    const fingerprint = await getTrialIdentifier();
    return api.trial.getStatus(fingerprint);
}

export function showTrialLimitPrompt(status: TrialStatus): void {
    const box = `
${chalk.yellow('╭──────────────────────────────────────────────────────────╮')}
${chalk.yellow('│')}  ${chalk.bold.yellow('⚡ Daily limit reached')} (${status.reviewsUsed}/${status.reviewsLimit} reviews)${' '.repeat(16)}${chalk.yellow('│')}
${chalk.yellow('│')}                                                          ${chalk.yellow('│')}
${chalk.yellow('│')}  Sign up for free to unlock:                             ${chalk.yellow('│')}
${chalk.yellow('│')}  ${chalk.green('✓')} Unlimited reviews                                    ${chalk.yellow('│')}
${chalk.yellow('│')}  ${chalk.green('✓')} Custom configurations                                ${chalk.yellow('│')}
${chalk.yellow('│')}  ${chalk.green('✓')} Review history                                       ${chalk.yellow('│')}
${chalk.yellow('│')}  ${chalk.green('✓')} Team integration                                     ${chalk.yellow('│')}
${chalk.yellow('│')}                                                          ${chalk.yellow('│')}
${chalk.yellow('│')}  ${chalk.dim('→')} ${chalk.cyan('kodus auth login')}                                     ${chalk.yellow('│')}
${chalk.yellow('╰──────────────────────────────────────────────────────────╯')}
`;

    cliInfo(box);
}
