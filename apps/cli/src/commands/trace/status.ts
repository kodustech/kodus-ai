import fs from 'node:fs/promises';
import path from 'node:path';
import chalk from 'chalk';
import { gitService } from '../../services/git.service.js';
import {
    lastCaptureAt,
    listSessions,
} from '../../services/trace/session-store.js';
import { readAllLocalBranchRecords } from '../../services/trace/local-decisions.js';
import { readAllBranchRecords } from '../../services/trace/decision-branch.service.js';
import { readIncidents } from '../../services/trace/incidents.js';
import { readOverrides } from '../../services/trace/overrides.js';
import { repoStoreDir } from '../../services/trace/store-paths.js';
import { isKodusTraceHookCommand } from './hooks.js';
import { TRACE_HOOK_MARKER } from '../../services/git-hooks.service.js';
import { cliError, cliInfo } from '../../utils/logger.js';
import { exitWithCode } from '../../utils/cli-exit.js';
import type { GlobalOptions } from '../../types/cli.js';

export interface TraceStatusReport {
    repositoryRoot: string;
    storePath: string;
    sessions: number;
    turns: number;
    decisions: { local: number; branch: number };
    lastCaptureAt: string | null;
    pinned: number;
    forgotten: number;
    hooks: {
        claudeCode: boolean;
        cursor: boolean;
        codex: boolean;
        gitPrePush: boolean;
        gitPrepareCommitMsg: boolean;
    };
    incidents: Array<{ at: string; kind: string; message: string }>;
}

export async function buildStatusReport(
    gitRoot: string,
    hooksDir: string | null,
): Promise<TraceStatusReport> {
    const [
        sessions,
        localRecords,
        branchRecords,
        overrides,
        incidents,
        capturedAt,
    ] = await Promise.all([
        listSessions(gitRoot),
        readAllLocalBranchRecords(gitRoot),
        readAllBranchRecords(gitRoot).catch(() => []),
        readOverrides(gitRoot),
        readIncidents(gitRoot),
        lastCaptureAt(gitRoot),
    ]);

    return {
        repositoryRoot: gitRoot,
        storePath: repoStoreDir(gitRoot),
        sessions: sessions.length,
        turns: sessions.reduce((total, entry) => total + entry.turnCount, 0),
        decisions: {
            local: localRecords.reduce(
                (total, record) => total + (record.decisions?.length ?? 0),
                0,
            ),
            branch: branchRecords.reduce(
                (total, record) => total + (record.decisions?.length ?? 0),
                0,
            ),
        },
        lastCaptureAt: capturedAt,
        pinned: overrides.pinned.length,
        forgotten: overrides.forgotten.length,
        hooks: {
            claudeCode: await hasClaudeHooks(gitRoot),
            cursor: await hasCursorHooks(gitRoot),
            codex: await hasCodexHooks(),
            gitPrePush: await hasGitHook(hooksDir, 'pre-push'),
            gitPrepareCommitMsg: await hasGitHook(
                hooksDir,
                'prepare-commit-msg',
            ),
        },
        incidents: incidents.map((incident) => ({
            at: incident.at,
            kind: incident.kind,
            message: incident.message,
        })),
    };
}

/**
 * The only signal a developer gets that this feature is alive. A repository
 * where nothing has been captured says so plainly rather than printing nothing.
 */
export async function statusAction(
    _options: unknown,
    globalOpts?: GlobalOptions,
): Promise<void> {
    const isRepo = await gitService.isGitRepository();
    if (!isRepo) {
        cliError(chalk.red('Error: Not a git repository.'));
        exitWithCode(1);
        return;
    }

    const gitRoot = (await gitService.getGitRoot()).trim();
    const hooksDir = await gitService.getHooksDir().catch(() => null);
    const report = await buildStatusReport(gitRoot, hooksDir);

    if (globalOpts?.format === 'json' || globalOpts?.agent) {
        cliInfo(JSON.stringify(report, null, 2));
        return;
    }

    cliInfo(chalk.bold('Kodus Trace status'));
    cliInfo(`  Repository: ${report.repositoryRoot}`);
    cliInfo(`  Local store: ${report.storePath}`);
    cliInfo('');

    if (report.sessions === 0) {
        cliInfo(
            chalk.yellow('  No sessions captured yet for this repository.'),
        );
        cliInfo(
            chalk.dim(
                '  Run `kodus trace enable`, then start an agent session here.',
            ),
        );
    } else {
        cliInfo(
            `  Sessions: ${report.sessions} (${report.turns} turns captured)`,
        );
        cliInfo(`  Last capture: ${report.lastCaptureAt ?? 'unknown'}`);
    }

    cliInfo(
        `  Decisions: ${report.decisions.local} local, ${report.decisions.branch} on kodus/trace/v1`,
    );
    if (report.pinned || report.forgotten) {
        cliInfo(
            chalk.dim(
                `  Corrections: ${report.pinned} pinned, ${report.forgotten} forgotten`,
            ),
        );
    }

    cliInfo('');
    cliInfo(chalk.bold('  Hooks'));
    cliInfo(`    Claude Code: ${mark(report.hooks.claudeCode)}`);
    cliInfo(`    Cursor: ${mark(report.hooks.cursor)}`);
    cliInfo(`    Codex: ${mark(report.hooks.codex)}`);
    cliInfo(`    git pre-push: ${mark(report.hooks.gitPrePush)}`);
    cliInfo(
        `    git prepare-commit-msg: ${mark(report.hooks.gitPrepareCommitMsg)}`,
    );

    if (report.incidents.length > 0) {
        cliInfo('');
        cliInfo(chalk.bold(chalk.red('  Problems')));
        for (const incident of report.incidents) {
            cliInfo(
                chalk.red(
                    `    ${incident.at} ${incident.kind}: ${incident.message}`,
                ),
            );
        }
    }
}

function mark(installed: boolean): string {
    return installed ? chalk.green('installed') : chalk.dim('not installed');
}

async function hasClaudeHooks(gitRoot: string): Promise<boolean> {
    return fileContains(
        path.join(gitRoot, '.claude', 'settings.json'),
        isKodusTraceHookCommand,
    );
}

async function hasCursorHooks(gitRoot: string): Promise<boolean> {
    return fileContains(
        path.join(gitRoot, '.cursor', 'hooks.json'),
        isKodusTraceHookCommand,
    );
}

async function hasCodexHooks(): Promise<boolean> {
    const { resolveCodexConfigPath } = await import('./hooks.js');
    return fileContains(resolveCodexConfigPath(), isKodusTraceHookCommand);
}

async function hasGitHook(
    hooksDir: string | null,
    hookName: string,
): Promise<boolean> {
    if (!hooksDir) {
        return false;
    }
    return fileContains(path.join(hooksDir, hookName), (content) =>
        content.includes(TRACE_HOOK_MARKER),
    );
}

async function fileContains(
    filePath: string,
    predicate: (content: string) => boolean,
): Promise<boolean> {
    try {
        const content = await fs.readFile(filePath, 'utf-8');
        return predicate(content);
    } catch {
        return false;
    }
}
