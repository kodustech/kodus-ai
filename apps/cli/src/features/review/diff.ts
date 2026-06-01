type ReviewDiffGit = {
    setVerbose(verbose: boolean): void;
    getDiffForFiles(files: string[]): Promise<string>;
    getDiffForBranch(branch: string): Promise<string>;
    getDiffForCommit(commit: string): Promise<string>;
    getStagedDiff(): Promise<string>;
    getWorkingTreeDiff(): Promise<string>;
};

export async function resolveReviewDiff({
    files,
    options,
    verbose,
    git,
}: {
    files: string[];
    options: {
        staged?: boolean;
        commit?: string;
        branch?: string;
    };
    verbose?: boolean;
    git: ReviewDiffGit;
}): Promise<{ diff: string; verboseMessages: string[] }> {
    git.setVerbose(!!verbose);

    const verboseMessages: string[] = [];
    let diff: string;

    if (files.length > 0) {
        if (verbose) {
            verboseMessages.push(
                `[verbose] Getting diff for specific files: ${files.join(', ')}`,
            );
        }
        diff = await git.getDiffForFiles(files);
    } else if (options.branch) {
        if (verbose) {
            verboseMessages.push(
                `[verbose] Getting diff for branch: ${options.branch}`,
            );
        }
        diff = await git.getDiffForBranch(options.branch);
    } else if (options.commit) {
        if (verbose) {
            verboseMessages.push(
                `[verbose] Getting diff for commit: ${options.commit}`,
            );
        }
        diff = await git.getDiffForCommit(options.commit);
    } else if (options.staged) {
        if (verbose) {
            verboseMessages.push('[verbose] Getting staged diff only');
        }
        diff = await git.getStagedDiff();
    } else {
        if (verbose) {
            verboseMessages.push(
                '[verbose] Getting working tree diff (staged + unstaged)',
            );
        }
        diff = await git.getWorkingTreeDiff();
    }

    if (verbose) {
        verboseMessages.push(
            `[verbose] Diff result: ${diff ? `${diff.length} characters` : 'empty'}`,
        );
        if (!diff) {
            verboseMessages.push(
                '[verbose] No changes detected in the requested scope',
            );
        } else {
            const preview = diff.substring(0, 500);
            verboseMessages.push(
                `[verbose] Diff preview:\n${preview}${diff.length > 500 ? '\n... (truncated)' : ''}`,
            );
        }
    }

    return { diff, verboseMessages };
}
