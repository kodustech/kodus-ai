import { simpleGit, SimpleGit } from 'simple-git';
import fs from 'fs/promises';
import path from 'path';
import chalk from 'chalk';
import type { FileContent } from '../types/review.js';
import type { FileDiff, GitInfo, PlatformType } from '../types/cli.js';
import { cliDebug } from '../utils/logger.js';
import {
    extractOrgRepoFromRemote,
    inferPlatformFromRemote,
} from '../utils/git-remote.js';
import {
    parseGitStatus,
} from '../utils/git-status.js';
import { countDiffChanges } from '../utils/git-diff.js';
import {
    buildFileContentReadPlan,
    buildFileDiffReadPlan,
} from '../utils/git-file-reader.js';
import {
    createFileSelectionFromModifiedFiles,
    createFileSelectionFromNameStatus,
    createFileSelectionFromPaths,
} from '../utils/git-file-selection.js';

class GitService {
    private git: SimpleGit;
    private verbose: boolean = false;

    constructor() {
        this.git = simpleGit();
    }

    setVerbose(verbose: boolean): void {
        this.verbose = verbose;
    }

    private async ensureRepo(): Promise<void> {
        const isRepo = await this.isGitRepository();
        if (!isRepo) {
            throw new Error(
                'Not a git repository. Run inside a Git repo or initialize one with "git init".',
            );
        }
    }

    async isGitRepository(): Promise<boolean> {
        try {
            await this.git.revparse(['--git-dir']);
            return true;
        } catch {
            return false;
        }
    }

    async getGitRoot(): Promise<string> {
        await this.ensureRepo();
        return this.git.revparse(['--show-toplevel']);
    }

    async getHeadSha(): Promise<string | null> {
        await this.ensureRepo();

        try {
            return (await this.git.revparse(['HEAD'])).trim();
        } catch {
            return null;
        }
    }

    async getRemoteUrl(remote = 'origin'): Promise<string | null> {
        try {
            const remotes = await this.git.getRemotes(true);
            const found = remotes.find((r) => r.name === remote);
            return found?.refs?.fetch || null;
        } catch {
            return null;
        }
    }

    async extractOrgRepo(): Promise<{ org: string; repo: string } | null> {
        return extractOrgRepoFromRemote(await this.getRemoteUrl());
    }

    async getWorkingTreeDiff(): Promise<string> {
        await this.ensureRepo();

        if (this.verbose) {
            // Show git status first for context
            const status = await this.git.status();
            cliDebug(chalk.dim('[verbose] Git status before diff:'));
            cliDebug(
                chalk.dim(
                    `[verbose]   - staged: ${status.staged.length} file(s) - ${status.staged.join(', ') || 'none'}`,
                ),
            );
            cliDebug(
                chalk.dim(
                    `[verbose]   - modified: ${status.modified.length} file(s) - ${status.modified.join(', ') || 'none'}`,
                ),
            );
            cliDebug(
                chalk.dim(
                    `[verbose]   - not_added: ${status.not_added.length} file(s) - ${status.not_added.join(', ') || 'none'}`,
                ),
            );
            cliDebug(
                chalk.dim(
                    `[verbose]   - deleted: ${status.deleted.length} file(s) - ${status.deleted.join(', ') || 'none'}`,
                ),
            );
        }

        const staged = await this.git.diff(['--cached']);
        const unstaged = await this.git.diff();
        const result = `${staged}\n${unstaged}`.trim();

        if (this.verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Staged diff: ${staged ? `${staged.length} chars` : 'empty'}`,
                ),
            );
            cliDebug(
                chalk.dim(
                    `[verbose] Unstaged diff: ${unstaged ? `${unstaged.length} chars` : 'empty'}`,
                ),
            );
            cliDebug(
                chalk.dim(
                    `[verbose] Combined diff: ${result ? `${result.length} chars` : 'empty'}`,
                ),
            );
        }

        return result;
    }

    async getStagedDiff(): Promise<string> {
        await this.ensureRepo();
        const diff = await this.git.diff(['--cached']);

        if (this.verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Staged diff: ${diff ? `${diff.length} chars` : 'empty'}`,
                ),
            );
        }

        return diff;
    }

    async getDiffForCommit(commitSha: string): Promise<string> {
        await this.ensureRepo();
        const diff = await this.git.diff([`${commitSha}^`, commitSha]);

        if (this.verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Commit ${commitSha} diff: ${diff ? `${diff.length} chars` : 'empty'}`,
                ),
            );
        }

        return diff;
    }

    async getDiffForBranch(branchName: string): Promise<string> {
        await this.ensureRepo();
        const diff = await this.git.diff([`${branchName}...HEAD`]);

        if (this.verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Branch ${branchName}...HEAD diff: ${diff ? `${diff.length} chars` : 'empty'}`,
                ),
            );
        }

        return diff;
    }

    async getDiffForFiles(files: string[]): Promise<string> {
        await this.ensureRepo();
        const diffs: string[] = [];

        if (this.verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Getting diff for ${files.length} file(s): ${files.join(', ')}`,
                ),
            );
        }

        for (const file of files) {
            const stagedDiff = await this.git.diff(['--cached', '--', file]);
            const unstagedDiff = await this.git.diff(['--', file]);

            if (this.verbose) {
                cliDebug(
                    chalk.dim(
                        `[verbose]   ${file}: staged=${stagedDiff ? `${stagedDiff.length} chars` : 'empty'}, unstaged=${unstagedDiff ? `${unstagedDiff.length} chars` : 'empty'}`,
                    ),
                );
            }

            if (stagedDiff) {
                diffs.push(stagedDiff);
            }
            if (unstagedDiff) {
                diffs.push(unstagedDiff);
            }
        }

        const result = diffs.join('\n').trim();

        if (this.verbose) {
            cliDebug(
                chalk.dim(
                    `[verbose] Combined file diff: ${result ? `${result.length} chars` : 'empty'}`,
                ),
            );
        }

        return result;
    }

    async getModifiedFiles(): Promise<FileDiff[]> {
        await this.ensureRepo();
        const status = await this.git.status();
        const files: FileDiff[] = [];

        const processFile = async (
            file: string,
            gitStatus: string,
        ): Promise<FileDiff> => {
            let status: FileDiff['status'] = 'modified';

            if (gitStatus === 'A' || gitStatus === '?') {
                status = 'added';
            } else if (gitStatus === 'D') {
                status = 'deleted';
            } else if (gitStatus === 'R') {
                status = 'renamed';
            }

            const diff = await this.git.diff(['--', file]);
            const { additions, deletions } = countDiffChanges(diff);

            return { file, status, additions, deletions, diff };
        };

        for (const file of status.staged) {
            files.push(await processFile(file, 'M'));
        }

        for (const file of status.modified) {
            if (!files.find((f) => f.file === file)) {
                files.push(await processFile(file, 'M'));
            }
        }

        for (const file of status.not_added) {
            files.push(await processFile(file, 'A'));
        }

        return files;
    }

    async getFullFileContents(
        explicitFiles?: string[],
        options?: {
            staged?: boolean;
            commit?: string;
            branch?: string;
        },
    ): Promise<FileContent[]> {
        await this.ensureRepo();
        let selection:
            | {
                  filesToRead: string[];
                  fileStatusMap: Map<string, FileDiff['status']>;
              }
            | undefined;

        if (explicitFiles && explicitFiles.length > 0) {
            selection = createFileSelectionFromPaths(explicitFiles);
        } else if (options?.branch) {
            const nameStatus = await this.git.diff([
                '--name-status',
                `${options.branch}...HEAD`,
            ]);
            selection = createFileSelectionFromNameStatus(nameStatus);
        } else if (options?.commit) {
            const nameStatus = await this.git.diff([
                '--name-status',
                `${options.commit}^`,
                options.commit,
            ]);
            selection = createFileSelectionFromNameStatus(nameStatus);
        } else {
            const allModifiedFiles = await this.getModifiedFiles();
            selection = createFileSelectionFromModifiedFiles(allModifiedFiles);
        }
        const { filesToRead, fileStatusMap } = selection;

        // 2. For each file, read content and diff
        const fileContents: FileContent[] = [];

        for (const filePath of filesToRead) {
            try {
                // Resolve file status
                const status = fileStatusMap.get(filePath) || 'modified';

                // Skip deleted files (no content to read)
                if (status === 'deleted') {
                    continue;
                }

                const diffPlan = buildFileDiffReadPlan(filePath, options);
                let fileDiff: string;
                if (diffPlan.mode === 'single-diff') {
                    fileDiff = await this.git.diff(diffPlan.args);
                } else {
                    const stagedDiff = await this.git.diff(diffPlan.stagedArgs);
                    const unstagedDiff = await this.git.diff(
                        diffPlan.unstagedArgs,
                    );
                    fileDiff = `${stagedDiff}\n${unstagedDiff}`.trim();
                }

                const contentPlan = buildFileContentReadPlan(filePath, options);
                let content: string;
                if (contentPlan.mode === 'git-show') {
                    content = await this.git.show(contentPlan.args);
                } else {
                    const fullPath = path.resolve(contentPlan.path);
                    content = await fs.readFile(fullPath, contentPlan.encoding);
                }

                fileContents.push({
                    path: filePath,
                    content,
                    status,
                    diff: fileDiff,
                });
            } catch {
                // File may be binary or inaccessible; skip silently.
                continue;
            }
        }

        return fileContents;
    }

    parseGitStatus(statusChar: string): FileDiff['status'] {
        return parseGitStatus(statusChar);
    }

    async getCurrentBranch(): Promise<string> {
        return this.git.revparse(['--abbrev-ref', 'HEAD']);
    }

    async getHeadCommit(): Promise<string> {
        return this.git.revparse(['HEAD']);
    }

    /**
     * Best-effort merge-base between HEAD and the upstream default branch.
     * Tries, in order: the branch's @{upstream}, origin/HEAD, origin/main,
     * origin/master. Returns undefined if none can be resolved — the caller
     * decides what to do (e.g. fall back to HEAD or to legacy clone-by-branch).
     */
    async getMergeBaseWithUpstream(): Promise<string | undefined> {
        const candidates = [
            '@{upstream}',
            'origin/HEAD',
            'origin/main',
            'origin/master',
        ];
        for (const ref of candidates) {
            try {
                // Resolve the ref first — revparse throws if it doesn't exist.
                await this.git.revparse([ref]);
                const sha = (
                    await this.git.raw(['merge-base', 'HEAD', ref])
                ).trim();
                if (sha) {return sha;}
            } catch {
                // Ref doesn't exist locally / no merge base — try next.
            }
        }
        return undefined;
    }

    async getUserEmail(): Promise<string | undefined> {
        try {
            const email = await this.git.raw(['config', 'user.email']);
            return email.trim() || undefined;
        } catch {
            return undefined;
        }
    }

    async getGitInfo(): Promise<GitInfo> {
        const info: GitInfo = {
            userEmail: undefined,
            remote: undefined,
            branch: undefined,
            commitSha: undefined,
        };

        try {
            info.userEmail = await this.getUserEmail();
        } catch {
            // Git config not set
        }

        try {
            info.remote = await this.getRemoteUrl();
        } catch {
            // No remote configured
        }

        try {
            info.branch = await this.getCurrentBranch();
        } catch {
            // Not on a branch (detached HEAD)
        }

        try {
            info.commitSha = await this.getHeadCommit();
        } catch {
            // No commits yet
        }

        try {
            info.mergeBaseSha = await this.getMergeBaseWithUpstream();
        } catch {
            // No upstream configured / fresh repo
        }

        return info;
    }

    inferPlatform(remote: string | null | undefined): PlatformType {
        return inferPlatformFromRemote(remote);
    }
}

export const gitService = new GitService();
